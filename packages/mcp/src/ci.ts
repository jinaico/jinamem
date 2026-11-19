/**
 * CI capture: failed GitHub Actions runs become dead ends in the project's
 * memory, so the next agent session knows "CI broke on main last night"
 * without anyone pasting logs.
 *
 * Uses the GitHub CLI (`gh`) the developer already has signed in — no tokens
 * or webhooks to set up. Runs when a session starts and before every
 * briefing; `jinamem-ci` runs it by hand or from cron.
 *
 * Skipped silently when: gh isn't installed or signed in, the project isn't a
 * GitHub repo, or JINAMEM_CI=off.
 */

import { execFile } from "child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { resolve } from "path";
import { jinamemDir, type JinamemStore } from "@jinamem/core";
import { extractErrors } from "./logscan.js";

interface Run {
  databaseId: number;
  conclusion: string;   // success | failure | cancelled | timed_out | startup_failure | ""
  status: string;       // completed | in_progress | queued
  workflowName: string;
  headBranch: string;
  headSha: string;
  displayTitle: string;
  createdAt: string;
  url: string;
}

interface CIState {
  seen: number[];                        // run IDs already processed
  lastFailed: Record<string, boolean>;   // "workflow\0branch" → last completed run failed
}

export interface CIResult {
  skipped?: string;
  failures: number;
  recoveries: number;
}

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const FIRST_SYNC_DAYS = 7;          // don't import ancient history on first use
const MAX_NEW_FAILURES = 5;         // per sync — a red streak shouldn't flood the briefing

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((ok, fail) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) =>
      err ? fail(err) : ok(stdout));
  });
}

/** owner/repo for a GitHub remote URL, or undefined. */
export function githubRepo(remoteUrl: string): string | undefined {
  const m = remoteUrl.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * The useful part of `gh run view --log-failed`. Each line is
 * "<job>\t<step>\t<timestamp> <text>"; strip the prefix, then extract errors.
 */
export function summarizeFailedLog(log: string): string {
  const text = log.split("\n")
    .map(l => l.split("\t").pop() ?? l)
    .map(l => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ""))
    .join("\n");
  return extractErrors(text, true);
}

const statePath = () => resolve(jinamemDir(), "ci-state.json");

function loadState(project: string): CIState {
  try {
    const all = JSON.parse(readFileSync(statePath(), "utf8")) as Record<string, CIState>;
    return all[project] ?? { seen: [], lastFailed: {} };
  } catch {
    return { seen: [], lastFailed: {} };
  }
}

function saveState(project: string, state: CIState) {
  let all: Record<string, CIState> = {};
  try { all = JSON.parse(readFileSync(statePath(), "utf8")); } catch { /* first save */ }
  state.seen = state.seen.slice(-300);
  all[project] = state;
  mkdirSync(jinamemDir(), { recursive: true });
  const tmp = `${statePath()}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(all));
  renameSync(tmp, statePath());
}

/** Syncs new completed CI runs into memory. Never throws. */
export async function syncCI(
  store: JinamemStore, userId: string, project: string, cwd: string,
  opts: { timeoutMs?: number } = {},
): Promise<CIResult> {
  const result: CIResult = { failures: 0, recoveries: 0 };
  if (process.env.JINAMEM_CI === "off") return { ...result, skipped: "disabled (JINAMEM_CI=off)" };
  const t = opts.timeoutMs ?? 10_000;

  let repo: string | undefined;
  try {
    repo = githubRepo(await run("git", ["remote", "get-url", "origin"], cwd, 3_000));
  } catch {
    return { ...result, skipped: "not a git repository with an origin remote" };
  }
  if (!repo) return { ...result, skipped: "origin is not on GitHub" };

  let runs: Run[];
  try {
    runs = JSON.parse(await run("gh", [
      "run", "list", "-R", repo, "--limit", "30",
      "--json", "databaseId,conclusion,status,workflowName,headBranch,headSha,displayTitle,createdAt,url",
    ], cwd, t)) as Run[];
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    return { ...result, skipped: /ENOENT/.test(msg) ? "GitHub CLI (gh) not installed" : "gh could not list runs (signed in?)" };
  }

  const state = loadState(project);
  const firstSync = state.seen.length === 0;
  const cutoff = Date.now() - FIRST_SYNC_DAYS * 86_400_000;
  const seen = new Set(state.seen);

  // Oldest first, so recoveries are judged against the run before them
  const completed = runs.filter(r => r.status === "completed" && !seen.has(r.databaseId));
  // On first use, older runs are history: mark them seen without importing
  if (firstSync) {
    for (const r of completed) if (Date.parse(r.createdAt) < cutoff) state.seen.push(r.databaseId);
  }
  const fresh = completed
    .filter(r => !firstSync || Date.parse(r.createdAt) >= cutoff)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  for (const r of fresh) {
    const key = `${r.workflowName}\0${r.headBranch}`;
    const label = `CI: ${r.workflowName} on ${r.headBranch} (${r.headSha.slice(0, 7)})`;
    state.seen.push(r.databaseId);

    if (FAILED.has(r.conclusion)) {
      if (result.failures >= MAX_NEW_FAILURES) { state.lastFailed[key] = true; continue; }
      let why = r.conclusion === "timed_out" ? "timed out" : "";
      try {
        const log = await run("gh", ["run", "view", String(r.databaseId), "-R", repo, "--log-failed"], cwd, t * 2);
        why = summarizeFailedLog(log) || why;
      } catch { /* logs expired or unavailable — keep the run anyway */ }
      await store.logAttempt(userId, project, "ci", label,
        `failed: ${why || r.conclusion} · ${r.displayTitle.slice(0, 80)} · ${r.url}`, false);
      result.failures++;
      state.lastFailed[key] = true;
    } else if (r.conclusion === "success") {
      if (state.lastFailed[key]) {
        await store.logAttempt(userId, project, "ci", label,
          `passing again after a failure · ${r.displayTitle.slice(0, 80)}`, true);
        result.recoveries++;
      }
      state.lastFailed[key] = false;
    }
  }

  saveState(project, state);
  return result;
}
