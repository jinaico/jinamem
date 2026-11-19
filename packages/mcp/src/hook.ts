#!/usr/bin/env node
/**
 * jinamem-hook — captures what a coding agent's tools did, for any agent.
 *
 * Each agent pipes a JSON event to stdin after a tool runs. agents.ts turns
 * Claude Code, Codex, Cursor and Gemini CLI payloads into one shape; this
 * binary filters it, de-duplicates it and logs it to the jinamem store.
 *
 *   jinamem-hook [--agent claude|codex|cursor|gemini]
 *
 * Without --agent the payload's shape decides. jinamem-setup writes the
 * right config for each agent.
 */

import { createStore, jinamemDir, type JinamemStore } from "@jinamem/core";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "fs";
import { resolve } from "path";
import { randomUUID, createHash } from "crypto";
import { parseEvent, worthLogging, AGENTS, type Agent } from "./agents.js";
import { projectName as getProject } from "./project.js";
import { isBackgroundStart, findOutputFile, registerBackground } from "./background.js";


function agentArg(): Agent | undefined {
  const i = process.argv.indexOf("--agent");
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v && (AGENTS as string[]).includes(v) ? (v as Agent) : undefined;
}

// ─── De-duplication ──────────────────────────────────────────────────────────
// Some agents report one failure through two events (e.g. Cursor's shell hook
// and its tool-failure hook). Drop an identical capture seen moments ago.

const DEDUPE_WINDOW_MS = 30_000;
const recentPath = () => resolve(jinamemDir(), "recent.json");

function seenRecently(key: string): boolean {
  const now = Date.now();
  let recent: Record<string, number> = {};
  try { recent = JSON.parse(readFileSync(recentPath(), "utf8")); } catch { /* none yet */ }
  for (const [k, t] of Object.entries(recent)) if (now - t > DEDUPE_WINDOW_MS) delete recent[k];
  const dup = key in recent;
  recent[key] = now;
  try {
    mkdirSync(jinamemDir(), { recursive: true });
    writeFileSync(recentPath(), JSON.stringify(recent));
  } catch { /* best effort */ }
  return dup;
}

// ─── Cloud delivery + offline outbox ──────────────────────────────────────────

// Hooks block the agent until they exit, so keep network calls short.
const CLOUD_TIMEOUT_MS = Number(process.env.JINAMEM_HOOK_TIMEOUT_MS ?? 3000);
const OUTBOX_MAX = 500;            // oldest entries are dropped beyond this
const FLUSH_PER_RUN = 25;          // bound the extra latency of a single hook run

interface QueuedAttempt {
  userId: string; project: string; sessionId: string;
  action: string; result: string; success: boolean;
}

const outboxPath = () => resolve(jinamemDir(), "outbox.jsonl");

function sendAttempt(store: JinamemStore, a: QueuedAttempt) {
  return store.logAttempt(a.userId, a.project, a.sessionId, a.action, a.result, a.success);
}

function queue(...entries: QueuedAttempt[]) {
  if (entries.length === 0) return;
  mkdirSync(jinamemDir(), { recursive: true });
  appendFileSync(outboxPath(), entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  // Cap the file so a long outage can't grow it without bound
  const lines = readFileSync(outboxPath(), "utf8").split("\n").filter(Boolean);
  if (lines.length > OUTBOX_MAX) {
    const tmp = `${outboxPath()}.${process.pid}.trim`;
    appendFileSync(tmp, lines.slice(-OUTBOX_MAX).join("\n") + "\n");
    renameSync(tmp, outboxPath());
  }
}

async function flushOutbox(store: JinamemStore) {
  const path = outboxPath();
  if (!existsSync(path)) return;

  // Claim the file atomically — parallel tool calls run parallel hooks,
  // and only one of them should send each queued entry.
  const claimed = `${path}.${process.pid}.${randomUUID()}`;
  try { renameSync(path, claimed); } catch { return; }

  const entries = readFileSync(claimed, "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l) as QueuedAttempt; } catch { return null; } })
    .filter((e): e is QueuedAttempt => e !== null);
  unlinkSync(claimed);

  let i = 0;
  try {
    for (; i < entries.length && i < FLUSH_PER_RUN; i++) await sendAttempt(store, entries[i]);
  } catch {
    // Still offline — keep everything not yet sent
  }
  queue(...entries.slice(i));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const agentHint = agentArg();
  // Gemini CLI expects a JSON object on stdout; an empty one changes nothing
  const done = () => {
    if (agentHint === "gemini") process.stdout.write("{}\n");
    process.exit(0);
  };

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return done();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return done();   // not JSON — ignore
  }

  // A dev server or watcher started in the background: remember its output
  // file so the MCP server can watch it for crashes for the rest of the session
  if (isBackgroundStart(payload)) {
    try {
      const file = findOutputFile(payload.tool_response);
      const cmd = String((payload.tool_input as Record<string, unknown>)?.command ?? "");
      if (file) registerBackground(getProject(String(payload.cwd || process.cwd())), cmd, file);
    } catch { /* best effort */ }
  }

  const capture = parseEvent(payload, agentHint);
  if (!capture || !worthLogging(capture)) return done();

  const cwd = capture.cwd || process.cwd();
  const project = getProject(cwd);
  const userId = process.env.JINAMEM_USER_ID ?? "local";
  const sessionId = capture.sessionId || randomUUID();

  const key = createHash("sha1").update(`${project}\0${capture.action}\0${capture.success}`).digest("hex");
  if (seenRecently(key)) return done();

  const entry: QueuedAttempt = {
    userId, project, sessionId,
    action: capture.action, result: capture.result, success: capture.success,
  };
  const { store, config } = createStore({ timeoutMs: CLOUD_TIMEOUT_MS });

  try {
    if (config.mode === "cloud") {
      // Never lose a capture to a network blip: queue it locally and retry
      // on the next hook run.
      await flushOutbox(store);
      try {
        await sendAttempt(store, entry);
      } catch (err) {
        queue(entry);
        console.error("[jinamem-hook] cloud unreachable, queued:", (err as Error).message);
      }
    } else {
      await sendAttempt(store, entry);
    }
  } finally {
    await store.close();
  }

  done();
}

main().catch(err => {
  // stderr only — a hook must never break the agent
  console.error("[jinamem-hook] error:", err);
  if (agentArg() === "gemini") process.stdout.write("{}\n");
  process.exit(0);
});
