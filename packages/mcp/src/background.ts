/**
 * Watches commands an agent started in the background — dev servers, watch
 * builds, workers — and saves their errors and crashes to memory, even if the
 * agent never reads their output again.
 *
 * How it works:
 *   1. The hook sees a background command start (Claude Code: Bash with
 *      run_in_background) and registers the file its output is written to.
 *   2. The MCP server, which runs for the whole session, polls registered
 *      files every few seconds and records new error lines.
 *
 * Nothing about the agent's command changes; jinamem only reads the output
 * file the agent itself writes.
 */

import {
  existsSync, readFileSync, writeFileSync, renameSync, statSync, openSync, readSync, closeSync,
  readdirSync, mkdirSync,
} from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { jinamemDir, type JinamemStore } from "@jinamem/core";
import { classify, extractErrors } from "./logscan.js";

interface Entry {
  project: string;
  command: string;
  file: string;
  offset: number;
  added: number;     // ms epoch
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_READ = 256 * 1024;           // bytes read per file per poll
const registryPath = () => resolve(jinamemDir(), "background.json");

function load(): Entry[] {
  try { return JSON.parse(readFileSync(registryPath(), "utf8")) as Entry[]; } catch { return []; }
}

function save(entries: Entry[]) {
  mkdirSync(jinamemDir(), { recursive: true });
  const tmp = `${registryPath()}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(entries));
  renameSync(tmp, registryPath());      // atomic: the hook and server may write concurrently
}

// ─── Registration (called by the hook) ───────────────────────────────────────

/** True when a payload is a background command starting. */
export function isBackgroundStart(raw: Record<string, unknown>): boolean {
  const input = (raw.tool_input ?? {}) as Record<string, unknown>;
  return raw.tool_name === "Bash" && input.run_in_background === true &&
    (raw.hook_event_name === "PostToolUse" || raw.hook_event_name === undefined);
}

/**
 * The output file of a background command. Claude Code mentions the path in
 * the tool result; if only a task ID is given, look for "<id>.output" under
 * Claude Code's temp directories.
 */
export function findOutputFile(response: unknown, searchRoots = defaultRoots()): string | undefined {
  const text = typeof response === "string" ? response : JSON.stringify(response ?? "");
  const path = text.match(/(\/[^\s"'\\]+\.output)\b/)?.[1];
  if (path) return path;

  const id = text.match(/"(?:backgroundTaskId|task_id|taskId|shellId|bash_id)"\s*:\s*"([\w-]+)"/)?.[1];
  if (!id) return undefined;
  for (const root of searchRoots) {
    const found = searchFile(root, `${id}.output`, 6);
    if (found) return found;
  }
  return undefined;
}

function defaultRoots(): string[] {
  const roots = new Set<string>();
  for (const base of [tmpdir(), "/tmp", "/private/tmp"]) {
    try {
      for (const name of readdirSync(base)) if (name.startsWith("claude")) roots.add(join(base, name));
    } catch { /* not present on this OS */ }
  }
  return [...roots];
}

function searchFile(dir: string, name: string, depth: number, budget = { n: 3000 }): string | undefined {
  if (depth < 0 || budget.n <= 0) return undefined;
  let items: import("fs").Dirent[];
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
  for (const it of items) {
    if (--budget.n <= 0) return undefined;
    if (it.isFile() && it.name === name) return join(dir, it.name);
  }
  for (const it of items) {
    if (it.isDirectory()) {
      const f = searchFile(join(dir, it.name), name, depth - 1, budget);
      if (f) return f;
    }
  }
  return undefined;
}

export function registerBackground(project: string, command: string, file: string) {
  const now = Date.now();
  const entries = load().filter(e => now - e.added < MAX_AGE_MS && e.file !== file);
  entries.push({ project, command: command.slice(0, 200), file, offset: 0, added: now });
  save(entries);
}

// ─── Watching (run by the MCP server) ────────────────────────────────────────

export class BackgroundWatcher {
  private timer?: NodeJS.Timeout;
  private reported = new Set<string>();

  constructor(
    private store: JinamemStore,
    private userId: string,
    private project: string,
    private sessionId: () => string,
  ) {}

  start(intervalMs = Number(process.env.JINAMEM_BG_POLL_MS ?? 10_000)) {
    this.timer = setInterval(() => { this.poll().catch(() => {}); }, intervalMs);
    this.timer.unref();   // never keep the server alive on its own
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.poll().catch(() => {});   // catch errors written just before exit
  }

  /** Reads new output from this project's background commands; returns errors saved. */
  async poll(): Promise<number> {
    const now = Date.now();
    const all = load();
    let saved = 0;
    let changed = false;

    for (const e of all) {
      if (e.project !== this.project) continue;
      if (!existsSync(e.file)) continue;
      let size: number;
      try { size = statSync(e.file).size; } catch { continue; }
      if (size < e.offset) e.offset = 0;              // file was truncated or replaced
      if (size === e.offset) continue;

      const len = Math.min(size - e.offset, MAX_READ);
      const buf = Buffer.alloc(len);
      const fd = openSync(e.file, "r");
      try { readSync(fd, buf, 0, len, e.offset); } finally { closeSync(fd); }
      // Only consume up to the last complete line
      let text = buf.toString("utf8");
      const lastNl = text.lastIndexOf("\n");
      if (lastNl === -1 && len < MAX_READ) continue;
      if (lastNl !== -1) text = text.slice(0, lastNl + 1);
      e.offset += Buffer.byteLength(text);
      changed = true;

      if (!text.split("\n").some(l => classify(l).severity === "error")) continue;
      const summary = extractErrors(text, true);
      const key = `${e.file}\0${summary.replace(/\d+/g, "#")}`;   // same error again → once
      if (!summary || this.reported.has(key)) continue;
      this.reported.add(key);

      await this.store.logAttempt(
        this.userId, this.project, this.sessionId(),
        `Runtime: ${e.command}`, `error: ${summary}`, false,
      );
      saved++;
    }

    if (changed) {
      // Merge offsets into the latest registry (the hook may have added entries meanwhile)
      const latest = load().filter(x => now - x.added < MAX_AGE_MS);
      for (const x of latest) {
        const mine = all.find(e => e.file === x.file);
        if (mine) x.offset = Math.max(x.offset, mine.offset);
      }
      save(latest);
    }
    return saved;
  }
}
