/**
 * Shared log-line classification and error extraction, used by the hook,
 * jinamem-watch, background-task watching and CI capture.
 */

// ─── Log event classification ─────────────────────────────────────────────────

export type Severity = "error" | "warn" | "info" | "debug";

export interface LogEvent {
  raw: string;
  severity: Severity;
  message: string;
  source?: string;    // e.g. file path, service name
  timestamp: Date;
}

export const ERROR_PATTERNS: RegExp[] = [
  /\b(error|err|fatal|critical|exception|crash|panic)\b/i,
  /\btypeerror\b/i,
  /\breferenceerror\b/i,
  /\bsyntaxerror\b/i,
  /\buncaught\b/i,
  /\bunhandled (promise rejection|rejection)\b/i,
  /exit code [^0]/i,
  /exited with \d*[1-9]/i,
  /oom|out of memory/i,
  /segfault|segmentation fault/i,
  /\bfailed to\b/i,
  /\bcannot find module\b/i,
  /\benoent\b/i,
  /\bconnection refused\b/i,
  /\btimeout\b.*\bexceeded\b/i,
  /\b(5[0-9]{2})\b.*\b(error|fail)/i,  // HTTP 5xx
  /npm err!/i,
  /traceback \(most recent call\)/i,
  /panic:/i,
];

const WARN_PATTERNS: RegExp[] = [
  /\b(warn|warning|deprecated|deprecation)\b/i,
  /\bretrying\b/i,
  /\bslowly\b/i,
  /\bhigh (memory|cpu|latency)\b/i,
  /\b4[0-9]{2}\b/,  // HTTP 4xx
];

// Noise to ignore even if they match above patterns
export const NOISE_PATTERNS: RegExp[] = [
  /^\s*$/,                    // blank lines
  /^[\s\-=*#]+$/,             // dividers
  /\bchecking\b.*\bfor errors\b/i,
  /\bno errors found\b/i,
  /\berror count: 0\b/i,
  /\b0 errors\b/i,
];

export function classify(line: string): LogEvent {
  const raw = line.trim();
  const lower = raw.toLowerCase();
  let severity: Severity = "info";

  // Check noise first
  const isNoise = NOISE_PATTERNS.some(p => p.test(raw));
  if (!isNoise) {
    if (ERROR_PATTERNS.some(p => p.test(raw))) severity = "error";
    else if (WARN_PATTERNS.some(p => p.test(raw))) severity = "warn";
    else if (lower.includes("debug") || lower.includes("trace")) severity = "debug";
  }

  // Try to extract a clean message (strip timestamps, log prefixes)
  const message = raw
    .replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?\s*/i, "")  // ISO timestamp
    .replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/i, "")                              // [HH:MM:SS]
    .replace(/^(ERROR|WARN|INFO|DEBUG|FATAL)\s*[:|\]]\s*/i, "")             // log level prefix
    .replace(/^\d+\s+/i, "")                                                  // leading PID
    .trim() || raw;

  return { raw, severity, message, timestamp: new Date() };
}


// ─── Error extraction from long output ───────────────────────────────────────
// Build tools, test runners and compilers print hundreds of progress lines and
// put the actual error near the end. Keeping the first N characters loses it.

/** Lines that locate an error: stack frames, "--> file:line", "at file:line". */
const LOCATION = /^\s*(at |-->|File "|\.{0,2}\/?\S+\.(ts|tsx|js|jsx|mjs|py|rs|go|rb|java|kt|cs|php|swift|c|cc|cpp|h)[:(]\d+)/;

/** Generic "the command failed" lines from package managers and build
 *  wrappers. True but useless next to the real error. */
const WRAPPER = /^(npm (error|err!) (code |errno |syscall |path |workspace |location |command |Lifecycle script|A complete log|Exit status|\s*$)|yarn error Command failed|error Command failed|ELIFECYCLE|pnpm.*ERR_|make(\[\d+\])?: \*\*\*|error: could not compile|error: Recipe|Failed to compile\.?$|Build failed|FAILURE: Build failed|##\[error\]Process completed with exit code|\s*exit (code|status) \d+|Exit code \d+)/i;

/**
 * The useful part of a long output, as one line.
 *  - failed: the error lines (plus the line that says where), most recent last;
 *            falls back to the last lines if nothing looks like an error
 *  - success: the last meaningful line ("Compiled successfully", "7 passed")
 */
export function extractErrors(text: string, failed: boolean, max = 400): string {
  const lines = text.split(/\r?\n/).map(l => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).filter(l => l.trim());
  if (lines.length === 0) return "";

  if (!failed) return lines[lines.length - 1].trim().slice(0, max);

  const clean = (l: string) => l.replace(/^\[?\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\]?\s*/, "").trim();
  const errorIdx = lines.map((l, i) => (classify(l).severity === "error" ? i : -1)).filter(i => i >= 0);
  // Generic "the command failed" lines only count when nothing better exists
  const realIdx = errorIdx.filter(i => !WRAPPER.test(clean(lines[i])));
  const useIdx = (realIdx.length ? realIdx : errorIdx).slice(-3);   // the last errors usually caused the exit

  const usedLoc = new Set<number>();
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const i of useIdx) {
    const parts = [clean(lines[i])];   // keep the line as written: "TypeError:" is informative
    // Where it happened: compilers print the location just after or just before
    const isLoc = (j: number) => j >= 0 && j < lines.length && !usedLoc.has(j) &&
      LOCATION.test(lines[j]) && classify(lines[j]).severity !== "error";
    if (isLoc(i + 1)) { parts.push(lines[i + 1].trim()); usedLoc.add(i + 1); }
    else if (isLoc(i - 1)) { parts.unshift(lines[i - 1].trim()); usedLoc.add(i - 1); }
    const entry = parts.join(" ");
    const key = entry.replace(/\d+/g, "#");          // "line 42" and "line 43" are the same error
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(entry);
  }

  const chosen = picked.length ? picked : lines.slice(-3).map(l => l.trim());
  let out = chosen.join(" · ");
  if (out.length > max) out = "…" + out.slice(out.length - max + 1);
  return out;
}

