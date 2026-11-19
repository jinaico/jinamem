#!/usr/bin/env node
/**
 * jinamem-hook — Claude Code PostToolUse / PostToolUseFailure hook
 *
 * Claude Code pipes a JSON event to stdin after each tool call.
 * PostToolUse fires only when a tool succeeds; failures arrive as
 * PostToolUseFailure, so both must be registered to capture dead ends.
 * This binary reads the event and logs the attempt to the jinamem store.
 *
 * Config in .claude/settings.json (written by jinamem-setup):
 * {
 *   "hooks": {
 *     "PostToolUse":        [{ "matcher": "Bash|Edit|MultiEdit|Write",
 *                              "hooks": [{ "type": "command", "command": "jinamem-hook" }] }],
 *     "PostToolUseFailure": [{ "matcher": "Bash|Edit|MultiEdit|Write",
 *                              "hooks": [{ "type": "command", "command": "jinamem-hook" }] }]
 *   }
 * }
 */

import { SqliteStore } from "@jinamem/core";
import { mkdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

// ─── Claude Code Hook Event Schema ───────────────────────────────────────────
// https://code.claude.com/docs/en/hooks
//
// PostToolUse (tool succeeded):
//   { hook_event_name: "PostToolUse", tool_name, tool_input, session_id, cwd,
//     tool_response: { stdout, stderr, interrupted, isImage }   // Bash
//                  | { filePath, type, ... }                     // Write / Edit }
//
// PostToolUseFailure (tool failed — there is no tool_response):
//   { hook_event_name: "PostToolUseFailure", tool_name, tool_input, session_id, cwd,
//     error: "Exit code 1\nError: Cannot find module 'express'", is_interrupt? }

interface HookEvent {
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: {
    stdout?: string;
    stderr?: string;
    interrupted?: boolean;
    filePath?: string;
    // older / non-Bash shapes
    output?: string;
    error?: string;
  };
  error?: string;           // PostToolUseFailure
  is_interrupt?: boolean;   // PostToolUseFailure
  session_id?: string;
  cwd?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Must match the MCP server's project naming, or captured attempts never
// show up in the briefing.
function getProject(cwd: string): string {
  const base = process.env.JINAMEM_PROJECT ?? cwd;
  return base.split("/").filter(Boolean).slice(-2).join("-") || "default";
}

function summarizeInput(event: HookEvent): string {
  const { tool_name, tool_input } = event;

  switch (tool_name) {
    case "Bash": {
      const cmd = String(tool_input.command ?? "").slice(0, 200);
      const desc = tool_input.description ? ` (${tool_input.description})` : "";
      return `Bash: ${cmd}${desc}`;
    }
    case "Edit":
    case "MultiEdit": {
      const file = String(tool_input.file_path ?? tool_input.path ?? "unknown file");
      return `Edit: ${file}`;
    }
    case "Write": {
      const file = String(tool_input.file_path ?? tool_input.path ?? "unknown file");
      return `Write: ${file}`;
    }
    default:
      return `${tool_name}: ${JSON.stringify(tool_input).slice(0, 200)}`;
  }
}

function summarizeResult(event: HookEvent): { result: string; success: boolean } {
  // Failure event: Claude Code reports the failure text in a top-level `error`
  if (event.hook_event_name === "PostToolUseFailure") {
    if (event.is_interrupt) return { result: "interrupted", success: false };
    const err = (event.error ?? "failed").trim().replace(/\s*\n\s*/g, " · ");
    return { result: `error: ${err.slice(0, 300)}`, success: false };
  }

  const resp = event.tool_response;
  if (!resp) return { result: "ok", success: true };
  if (resp.interrupted) return { result: "interrupted by user", success: false };

  switch (event.tool_name) {
    case "Bash": {
      const stdout = resp.stdout ?? resp.output ?? "";
      const stderr = resp.stderr ?? resp.error ?? "";
      // The command exited 0. Many tools write warnings to stderr, so stderr
      // alone is not a failure — only clear failure markers count (these catch
      // e.g. `npm test | tail`, where the pipe hides the non-zero exit code).
      const failed = detectBashFailure(`${stdout}\n${stderr}`);
      const text = (stdout.trim() || stderr.trim()).replace(/\s*\n\s*/g, " · ");
      return { result: text.slice(0, 300) || "no output", success: !failed };
    }
    case "Edit":
    case "MultiEdit":
    case "Write": {
      const file = String(event.tool_input.file_path ?? event.tool_input.path ?? "");
      return {
        result: `${event.tool_name === "Write" ? "wrote" : "edited"} ${file}`,
        success: true,
      };
    }
    default:
      return { result: "ok", success: true };
  }
}

// Strong failure markers only — broad words like "failed" or "error:" also
// appear in successful output ("0 failed", log lines) and would create
// false dead ends.
function detectBashFailure(text: string): boolean {
  const failPatterns = [
    /\b[1-9]\d* (tests? )?(failed|failing)\b/i,
    /^npm err!/im,
    /^npm error /im,
    /traceback \(most recent call last\)/i,
    /^\s*\w*error: /im,              // SyntaxError: / TypeError: / error: at line start
    /command not found/i,
    /no such file or directory/i,
    /permission denied/i,
    /segmentation fault/i,
    /\bexit(ed)? (with )?(code|status) [1-9]/i,
  ];
  return failPatterns.some(p => p.test(text));
}

// Tools worth logging — skip noisy read-only tools
const LOGGABLE_TOOLS = new Set([
  "Bash", "Edit", "MultiEdit", "Write",
  "mcp__jinamem__remember",  // avoid logging jinamem's own calls
]);

const SKIP_TOOLS = new Set([
  "Read", "Glob", "Grep", "WebFetch", "WebSearch",
  "mcp__jinamem__recall", "mcp__jinamem__what_was_i_doing",
  "mcp__jinamem__remember", "mcp__jinamem__log_attempt",
  "TodoRead", "TodoWrite",
]);

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) process.exit(0);

  let event: HookEvent;
  try {
    event = JSON.parse(raw) as HookEvent;
  } catch {
    // Not JSON — ignore silently
    process.exit(0);
  }

  // Only handle tool-completion events
  if (event.hook_event_name !== "PostToolUse" &&
      event.hook_event_name !== "PostToolUseFailure") process.exit(0);

  // Skip read-only and jinamem's own tools
  if (SKIP_TOOLS.has(event.tool_name)) process.exit(0);

  // Skip tools we don't care about
  if (!LOGGABLE_TOOLS.has(event.tool_name) && !event.tool_name.startsWith("mcp__")) {
    // For unknown tools, only log if they look like write operations
    const name = event.tool_name.toLowerCase();
    const isWrite = name.includes("write") || name.includes("create") ||
                    name.includes("edit") || name.includes("bash") ||
                    name.includes("run") || name.includes("exec");
    if (!isWrite) process.exit(0);
  }

  const cwd = event.cwd ?? process.cwd();
  const project = getProject(cwd);
  const userId = process.env.JINAMEM_USER_ID ?? "local";
  const sessionId = event.session_id ?? randomUUID();

  const action = summarizeInput(event);
  const { result, success } = summarizeResult(event);

  // Skip trivially successful file writes — too noisy
  // Only log: bash commands always, edits only on failure
  const isBash = event.tool_name === "Bash";
  if (!isBash && success) process.exit(0);

  // Open store
  const dbDir = resolve(homedir(), ".jinamem");
  mkdirSync(dbDir, { recursive: true });

  const store = new SqliteStore(process.env.JINAMEM_DB_PATH);

  try {
    await store.logAttempt(userId, project, sessionId, action, result, success);
  } finally {
    await store.close();
  }

  // Exit 0 = hook succeeded, Claude Code continues normally
  // Exit 1 = hook failed, Claude Code shows warning but continues
  // Exit 2 = hook wants to block the tool (we never do this)
  process.exit(0);
}

main().catch(err => {
  // Log to stderr (goes to Claude Code's debug log, not shown to user)
  console.error("[jinamem-hook] error:", err);
  process.exit(0); // Always exit 0 — never block Claude Code
});
