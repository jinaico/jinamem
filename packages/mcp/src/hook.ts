#!/usr/bin/env node
/**
 * jinamem-hook — Claude Code PostToolUse hook
 *
 * Claude Code pipes a JSON event to stdin on every tool call.
 * This binary reads it, determines success/failure, and logs
 * the attempt to the jinamem SQLite store directly.
 *
 * Config in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PostToolUse": [{
 *       "matcher": "Bash|Edit|Write|MultiEdit",
 *       "hooks": [{ "type": "command", "command": "jinamem-hook" }]
 *     }]
 *   }
 * }
 */

import { SqliteStore } from "@jinamem/core";
import { mkdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

// ─── Claude Code Hook Event Schema ───────────────────────────────────────────
// https://docs.anthropic.com/en/docs/claude-code/hooks
//
// PostToolUse stdin payload:
// {
//   "hook_event_name": "PostToolUse",
//   "tool_name": "Bash",
//   "tool_input": { "command": "npm test", "description": "Run tests" },
//   "tool_response": {
//     "output": "...",        // stdout for Bash
//     "error": "...",         // stderr or error message
//     "interrupted": false
//   },
//   "session_id": "abc123",
//   "cwd": "/home/user/my-project"
// }

interface HookEvent {
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: {
    output?: string;
    error?: string;
    interrupted?: boolean;
    filePath?: string;       // Write tool
    newFile?: boolean;
    // Edit/MultiEdit
    old_content?: string;
    new_content?: string;
  };
  session_id?: string;
  cwd?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getProject(cwd: string): string {
  return cwd.split("/").filter(Boolean).slice(-2).join("-") || "default";
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
  const resp = event.tool_response;
  if (!resp) return { result: "no response", success: true };

  const { tool_name } = event;

  if (resp.interrupted) {
    return { result: "interrupted by user", success: false };
  }

  switch (tool_name) {
    case "Bash": {
      const output = resp.output ?? "";
      const error  = resp.error ?? "";

      // Heuristics for failure detection
      const failed = detectBashFailure(output, error);

      const summary = error
        ? `error: ${error.slice(0, 300)}`
        : output.slice(0, 300) || "no output";

      return { result: summary, success: !failed };
    }
    case "Edit":
    case "MultiEdit":
    case "Write": {
      const error = resp.error ?? "";
      if (error) return { result: `failed: ${error.slice(0, 300)}`, success: false };
      const file = String(event.tool_input.file_path ?? event.tool_input.path ?? "");
      return {
        result: `${event.tool_name === "Write" ? "wrote" : "edited"} ${file}`,
        success: true,
      };
    }
    default: {
      const error = resp.error ?? "";
      return error
        ? { result: `error: ${error.slice(0, 200)}`, success: false }
        : { result: "ok", success: true };
    }
  }
}

// Detect bash command failures from output content
function detectBashFailure(output: string, error: string): boolean {
  if (error && error.trim().length > 0) return true;

  const text = output.toLowerCase();
  const failPatterns = [
    /\berror\b.*:/,
    /\bfailed\b/,
    /\bfailure\b/,
    /exit code [^0]/,
    /exited with \d*[1-9]/,
    /npm err!/i,
    /syntax error/,
    /traceback/,
    /exception:/,
    /typeerror/,
    /referenceerror/,
    /cannot find/,
    /no such file/,
    /permission denied/,
    /command not found/,
    /enoent/,
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

  // Only handle PostToolUse
  if (event.hook_event_name !== "PostToolUse") process.exit(0);

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
