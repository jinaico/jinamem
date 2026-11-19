#!/usr/bin/env node
/**
 * jinamem-watch — sidecar log watcher
 *
 * Tails a log file or wraps a process, filters for significant events,
 * deduplicates, and writes to the jinamem store. Runs continuously
 * alongside your app — even when no agent is active.
 *
 * Usage:
 *   jinamem-watch --follow /var/log/myapp.log
 *   jinamem-watch --pipe "npm run dev"
 *   jinamem-watch --follow /var/log/myapp.log --project myapp --level error
 *
 * Next session briefing will include:
 *   🚫 Server crashed at 2:14am: OOM in /api/process-upload
 *   ⚠️  Build failed 3 times: TypeScript error in auth.ts
 */

import { createReadStream, statSync, watchFile } from "fs";
import { createInterface } from "readline";
import { spawn } from "child_process";
import { createStore, type JinamemStore } from "@jinamem/core";
import { classify, type LogEvent, type Severity } from "./logscan.js";
import { randomUUID } from "crypto";
import { projectName } from "./project.js";

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs(): {
  follow?: string;
  pipe?: string;
  project: string;
  level: "error" | "warn" | "all";
  userId: string;
  sessionId: string;
} {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const follow = get("--follow");
  const pipe   = get("--pipe");

  if (!follow && !pipe) {
    console.error("Usage:");
    console.error("  jinamem-watch --follow <logfile> [--project <name>] [--level error|warn|all]");
    console.error("  jinamem-watch --pipe <command>  [--project <name>] [--level error|warn|all]");
    process.exit(1);
  }

  // Same naming as the MCP server and hook; --project overrides it
  const cwd = projectName();

  return {
    follow,
    pipe,
    project:   get("--project") ?? cwd,
    level:    (get("--level") ?? "warn") as "error" | "warn" | "all",
    userId:    process.env.JINAMEM_USER_ID ?? "local",
    sessionId: randomUUID(),
  };
}

// ─── Deduplication ────────────────────────────────────────────────────────────
// Same error appearing 50 times = one memory entry with count

interface SeenEntry {
  message: string;
  severity: Severity;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  written: boolean;
}

const seen = new Map<string, SeenEntry>();
const DEDUP_WINDOW_MS = 60 * 1000;  // 1 minute
const FLUSH_INTERVAL_MS = 30 * 1000; // write accumulated events every 30s

function dedupeKey(event: LogEvent): string {
  // Normalize: strip numbers/hashes that change per occurrence
  return event.message
    .replace(/\b[0-9a-f]{8,}\b/g, "<id>")   // UUIDs, hashes
    .replace(/:\d+/g, ":<n>")                // port/line numbers
    .replace(/\d+ms/g, "<n>ms")              // timings
    .replace(/\d+\.\d+\.\d+\.\d+/g, "<ip>") // IPs
    .slice(0, 150);
}

function recordEvent(event: LogEvent): boolean {
  const key = dedupeKey(event);
  const now = Date.now();
  const existing = seen.get(key);

  if (existing) {
    existing.count++;
    existing.lastSeen = new Date();
    return false; // already seen
  }

  seen.set(key, {
    message: event.message,
    severity: event.severity,
    count: 1,
    firstSeen: event.timestamp,
    lastSeen: event.timestamp,
    written: false,
  });
  return true; // new event
}

// Clean up old dedup entries
function cleanupSeen() {
  const cutoff = Date.now() - DEDUP_WINDOW_MS * 10;
  for (const [key, entry] of seen) {
    if (entry.written && entry.lastSeen.getTime() < cutoff) {
      seen.delete(key);
    }
  }
}

// ─── Store writer ─────────────────────────────────────────────────────────────

// Cloud if a token is set (JINAMEM_TOKEN or ~/.jinamem/config.json), local SQLite otherwise
let store: JinamemStore | null = null;

function getStore(): JinamemStore {
  if (!store) {
    const created = createStore({ timeoutMs: 10_000 });
    store = created.store;
    console.error(created.config.mode === "cloud"
      ? `[jinamem-watch] cloud mode · ${created.config.apiUrl}`
      : `[jinamem-watch] local mode · ${created.config.dbPath}`);
  }
  return store;
}

async function flushToStore(
  userId: string, project: string, sessionId: string,
  level: "error" | "warn" | "all",
) {
  const s = getStore();
  let flushed = 0;

  for (const [key, entry] of seen) {
    if (entry.written) continue;

    const severityOk =
      level === "all" ||
      (level === "error" && entry.severity === "error") ||
      (level === "warn" && true); // warn includes errors too

    if (!severityOk) continue;

    // Use the severity detected from the raw line — the stored message has
    // prefixes like "Error:" stripped, so re-matching it misses real errors
    const isError = entry.severity === "error";
    const countSuffix = entry.count > 1 ? ` (×${entry.count})` : "";
    const prefix = isError ? "[app error]" : "[app warning]";
    const content = `${prefix} ${entry.message}${countSuffix}`;

    try {
      await s.logAttempt(
        userId, project, sessionId,
        `watch: ${entry.message.slice(0, 100)}`,
        content,
        !isError, // success=false for errors → auto-stored as dead ends
      );
    } catch (err) {
      // Store unreachable (e.g. cloud outage) — keep the rest unwritten and
      // retry on the next flush instead of crashing the watcher
      console.error(`[jinamem-watch] write failed, will retry: ${(err as Error).message}`);
      break;
    }

    entry.written = true;
    flushed++;
  }

  if (flushed > 0) {
    console.error(`[jinamem-watch] wrote ${flushed} events to memory`);
  }

  cleanupSeen();
}

// ─── Line processor ───────────────────────────────────────────────────────────

function shouldCapture(event: LogEvent, level: "error" | "warn" | "all"): boolean {
  if (level === "all") return true;
  if (level === "error") return event.severity === "error";
  if (level === "warn") return event.severity === "error" || event.severity === "warn";
  return false;
}

function processLine(
  line: string,
  opts: { level: "error" | "warn" | "all" },
): LogEvent | null {
  if (!line.trim()) return null;
  const event = classify(line);
  if (!shouldCapture(event, opts.level)) return null;
  if (!recordEvent(event)) return null; // duplicate
  return event;
}

// ─── Follow a log file ────────────────────────────────────────────────────────

async function followFile(
  filePath: string,
  opts: ReturnType<typeof parseArgs>,
) {
  console.error(`[jinamem-watch] tailing ${filePath} (level: ${opts.level}, project: ${opts.project})`);

  let fileSize = statSync(filePath).size;

  // Start from end of file — don't replay old history
  const tail = () => {
    const stream = createReadStream(filePath, {
      start: fileSize,
      encoding: "utf8",
    });
    const rl = createInterface({ input: stream });
    rl.on("line", line => {
      processLine(line, opts);
    });
  };

  tail();

  watchFile(filePath, { interval: 1000 }, (curr) => {
    if (curr.size > fileSize) {
      fileSize = curr.size;
      tail();
    }
  });
}

// ─── Wrap a process ───────────────────────────────────────────────────────────

async function wrapProcess(
  command: string,
  opts: ReturnType<typeof parseArgs>,
) {
  console.error(`[jinamem-watch] wrapping: ${command} (level: ${opts.level}, project: ${opts.project})`);

  const [cmd, ...args] = command.split(/\s+/);
  const child = spawn(cmd, args, {
    stdio: ["inherit", "pipe", "pipe"],
    shell: true,
  });

  const rl_stdout = createInterface({ input: child.stdout });
  const rl_stderr = createInterface({ input: child.stderr });

  // Pass through to terminal so developer still sees output
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  rl_stdout.on("line", line => processLine(line, opts));
  rl_stderr.on("line", line => {
    // stderr lines are always at least warn-level
    const event = classify(line);
    if (event.severity === "info" || event.severity === "debug") {
      event.severity = "warn";
    }
    if (shouldCapture(event, opts.level)) recordEvent(event);
  });

  child.on("exit", async (code) => {
    if (code !== 0) {
      const event: LogEvent = {
        raw: `Process exited with code ${code}`,
        severity: "error",
        message: `${command} exited with code ${code}`,
        timestamp: new Date(),
      };
      recordEvent(event);
    }
    // Final flush on exit
    await flushToStore(opts.userId, opts.project, opts.sessionId, opts.level);
    if (store) await store.close();
    process.exit(code ?? 0);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  // Flush accumulated events every 30 seconds
  const flushTimer = setInterval(async () => {
    await flushToStore(opts.userId, opts.project, opts.sessionId, opts.level);
  }, FLUSH_INTERVAL_MS);

  // Graceful shutdown
  const shutdown = async () => {
    clearInterval(flushTimer);
    await flushToStore(opts.userId, opts.project, opts.sessionId, opts.level);
    if (store) await store.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT",  shutdown);

  if (opts.follow) {
    await followFile(opts.follow, opts);
    // Keep process alive (watchFile keeps it running)
  } else if (opts.pipe) {
    await wrapProcess(opts.pipe, opts);
  }
}

main().catch(err => {
  console.error("[jinamem-watch] fatal:", err);
  process.exit(1);
});
