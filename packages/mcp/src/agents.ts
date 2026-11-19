/**
 * Turns each coding agent's "a tool just ran" hook payload into one shape.
 *
 * Supported agents and the events jinamem-setup registers for them:
 *
 *   Claude Code  PostToolUse, PostToolUseFailure        (.claude/settings.json)
 *                Bash results in tool_response.stdout/stderr; failures arrive
 *                as PostToolUseFailure with a top-level `error`.
 *
 *   Codex        PostToolUse                             (.codex/hooks.json)
 *                No failure event: a Bash command that exits non-zero still
 *                fires PostToolUse, so success is read from the output.
 *                Payloads carry `turn_id`. File edits are `apply_patch`.
 *
 *   Cursor       afterShellExecution, postToolUseFailure (.cursor/hooks.json)
 *                Shell output has no exit code; tool failures carry
 *                `error_message` and `failure_type`.
 *
 *   Gemini CLI   AfterTool                               (.gemini/settings.json)
 *                Tools: run_shell_command, write_file, replace. Failures set
 *                tool_response.error.
 */

import { extractErrors } from "./logscan.js";

export type Agent = "claude" | "codex" | "cursor" | "gemini";
export const AGENTS: Agent[] = ["claude", "codex", "cursor", "gemini"];

export interface Capture {
  agent: Agent;
  kind: "shell" | "edit" | "tool";
  action: string;       // e.g. "Bash: npm test", "Edit: src/a.ts"
  result: string;       // one line: the error lines for failures, the last line for successes
  success: boolean;
  sessionId?: string;
  cwd?: string;
}

type Raw = Record<string, unknown>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const str = (v: unknown): string =>
  typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);

/** One line, bounded — multi-line output would break the briefing's bullets. */
export function oneLine(text: string, max = 300): string {
  return text.trim().replace(/\s*\n\s*/g, " · ").slice(0, max);
}

/** Strong failure markers only. Broad words like "failed" or "error:" also
 *  appear in successful output ("0 failed", log lines) and would create
 *  false dead ends. Also catches `npm test | tail`, where a pipe hides the
 *  non-zero exit code. */
export function looksFailed(text: string): boolean {
  return [
    /\b[1-9]\d* (tests? )?(failed|failing)\b/i,
    /^npm err!/im,
    /^npm error /im,
    /traceback \(most recent call last\)/i,
    /^\s*\w*error: /im,               // SyntaxError: / TypeError: / error: at line start
    /command not found/i,
    /no such file or directory/i,
    /permission denied/i,
    /segmentation fault/i,
    /\bexit(ed)? (with )?(code|status) [1-9]/i,
    /^make(\[\d+\])?: \*\*\*/m,          // make: *** No rule to make target …
    /^fatal: /m,                          // git
  ].some(p => p.test(text));
}

/** Pulls an exit code out of structured fields or "Exit code: N" style text. */
export function exitCodeOf(resp: unknown): number | undefined {
  if (resp && typeof resp === "object") {
    const r = resp as Raw;
    for (const k of ["exit_code", "exitCode", "returncode", "code"]) {
      if (typeof r[k] === "number") return r[k] as number;
    }
    const meta = r.metadata as Raw | undefined;
    if (meta && typeof meta.exit_code === "number") return meta.exit_code as number;
  }
  const m = str(resp).match(/\bexit(?:ed)?(?: with)?[ _]?(?:code|status)\b[^\d-]{0,12}(-?\d+)/i);
  return m ? Number(m[1]) : undefined;
}

/** Text content of a tool response, whatever its shape. */
function responseText(resp: unknown): string {
  if (typeof resp === "string") return resp;
  if (!resp || typeof resp !== "object") return "";
  const r = resp as Raw;
  for (const k of ["stdout", "output", "aggregated_output", "formatted_output", "llmContent", "content", "text", "returnDisplay"]) {
    if (r[k] != null && r[k] !== "") {
      const v = r[k];
      if (Array.isArray(v)) return v.map(p => str((p as Raw)?.text ?? p)).join("\n");
      return str(v);
    }
  }
  return str(resp);
}

function commandOf(input: unknown): string {
  const i = (input ?? {}) as Raw;
  const c = i.command ?? i.cmd;
  return (Array.isArray(c) ? c.join(" ") : str(c)).slice(0, 200);
}

function fileOf(input: unknown): string {
  const i = (input ?? {}) as Raw;
  return str(i.file_path ?? i.path ?? i.absolute_path ?? i.filePath ?? "") || "unknown file";
}

/** Files touched by a Codex apply_patch ("*** Update File: path" lines). */
function patchFiles(input: unknown): string {
  const patch = str((input as Raw)?.command ?? (input as Raw)?.input ?? input);
  const files = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(m => m[1].trim());
  return files.length ? files.join(", ").slice(0, 200) : "patch";
}

// Read-only and jinamem's own tools are never worth remembering
const SKIP = /^(Read|Glob|Grep|LS|WebFetch|WebSearch|TodoRead|TodoWrite|read_file|read_many_files|list_directory|glob|search_file_content|google_web_search|web_fetch|update_plan)$/;
const isJinamemTool = (name: string) => /jinamem/i.test(name);

// ─── Detection ───────────────────────────────────────────────────────────────

export function detectAgent(raw: Raw): Agent {
  const ev = str(raw.hook_event_name);
  if (raw.cursor_version !== undefined || /^(after|before|post|pre)[A-Z]/.test(ev) && ev[0] === ev[0].toLowerCase()) {
    return "cursor";
  }
  if (ev === "AfterTool" || ev === "BeforeTool") return "gemini";
  if (raw.turn_id !== undefined) return "codex";
  return "claude";
}

// ─── Per-agent parsers ───────────────────────────────────────────────────────

function fromClaude(raw: Raw): Capture | null {
  const ev = str(raw.hook_event_name);
  if (ev !== "PostToolUse" && ev !== "PostToolUseFailure") return null;
  const tool = str(raw.tool_name);
  const base = { agent: "claude" as const, sessionId: str(raw.session_id) || undefined, cwd: str(raw.cwd) || undefined };

  if (ev === "PostToolUseFailure") {
    if (raw.is_interrupt) return null;   // the user stopped it — not a dead end
    return { ...base, ...describe(tool, raw.tool_input), result: `error: ${extractErrors(str(raw.error), true) || "failed"}`, success: false };
  }

  const resp = (raw.tool_response ?? {}) as Raw;
  if (resp.interrupted) return null;
  if (tool === "Bash") {
    const stdout = str(resp.stdout ?? resp.output);
    const stderr = str(resp.stderr ?? resp.error);
    // Exit code 0 here; stderr alone (warnings) is not a failure
    const all = `${stdout}\n${stderr}`;
    const failed = looksFailed(all);
    return { ...base, ...describe(tool, raw.tool_input),
      result: failed ? `error: ${extractErrors(all, true)}` : extractErrors(stdout || stderr, false) || "no output",
      success: !failed };
  }
  return { ...base, ...describe(tool, raw.tool_input), result: "ok", success: true };
}

function fromCodex(raw: Raw): Capture | null {
  if (str(raw.hook_event_name) !== "PostToolUse") return null;
  const tool = str(raw.tool_name);
  const resp = raw.tool_response;
  const text = responseText(resp);
  const base = { agent: "codex" as const, sessionId: str(raw.session_id) || undefined, cwd: str(raw.cwd) || undefined };

  if (tool === "Bash" || tool === "exec_command" || tool === "shell") {
    // Codex has no failure event — judge by exit code, then by the output
    const code = exitCodeOf(resp);
    const failed = code !== undefined ? code !== 0 : looksFailed(text);
    const body = text.replace(/^(exit code|wall time|output):.*$/gim, "");
    return { ...base, kind: "shell", action: `Bash: ${commandOf(raw.tool_input)}`,
      result: failed
        ? `error: ${code !== undefined ? `exit ${code} · ` : ""}${extractErrors(body, true)}`
        : extractErrors(body, false) || "no output",
      success: !failed };
  }
  if (tool === "apply_patch") {
    const failed = /verification failed|failed to apply|invalid patch|error/i.test(text) && !/^success/i.test(text.trim());
    return { ...base, kind: "edit", action: `Edit: ${patchFiles(raw.tool_input)}`,
      result: failed ? `failed: ${extractErrors(text, true)}` : "edited", success: !failed };
  }
  const failed = !!(resp && typeof resp === "object" && (resp as Raw).isError);
  return { ...base, ...describe(tool, raw.tool_input), result: failed ? `error: ${extractErrors(text, true)}` : "ok", success: !failed };
}

function fromCursor(raw: Raw): Capture | null {
  const ev = str(raw.hook_event_name);
  const roots = raw.workspace_roots as string[] | undefined;
  const base = { agent: "cursor" as const,
    sessionId: str(raw.conversation_id ?? raw.session_id) || undefined,
    cwd: str(roots?.[0] ?? raw.cwd) || undefined };

  if (ev === "afterShellExecution") {
    const output = str(raw.output);
    // Cursor reports no exit code for shell commands — judge by the output
    const code = exitCodeOf(output);
    const failed = code !== undefined ? code !== 0 : looksFailed(output);
    return { ...base, kind: "shell", action: `Bash: ${str(raw.command).slice(0, 200)}`,
      result: failed ? `error: ${extractErrors(output, true)}` : extractErrors(output, false) || "no output", success: !failed };
  }
  if (ev === "postToolUseFailure") {
    // Interrupts and permission denials are the user's choice, not dead ends
    if (raw.is_interrupt || raw.failure_type === "permission_denied") return null;
    const tool = str(raw.tool_name);
    const why = raw.failure_type === "timeout" ? "timed out" : "error";
    return { ...base, ...describe(tool, raw.tool_input), result: `${why}: ${extractErrors(str(raw.error_message), true) || "failed"}`, success: false };
  }
  return null;
}

function fromGemini(raw: Raw): Capture | null {
  if (str(raw.hook_event_name) !== "AfterTool") return null;
  const tool = str(raw.tool_name);
  const resp = (raw.tool_response ?? {}) as Raw;
  const base = { agent: "gemini" as const, sessionId: str(raw.session_id) || undefined, cwd: str(raw.cwd) || undefined };
  const err = resp.error ? str((resp.error as Raw)?.message ?? resp.error) : "";
  const text = responseText(resp);

  if (tool === "run_shell_command") {
    const code = exitCodeOf(text);
    const failed = !!err || (code !== undefined ? code !== 0 : looksFailed(text));
    return { ...base, kind: "shell", action: `Bash: ${commandOf(raw.tool_input)}`,
      result: failed ? `error: ${err ? oneLine(err) : extractErrors(text, true)}` : extractErrors(text, false) || "no output", success: !failed };
  }
  return { ...base, ...describe(tool, raw.tool_input),
    result: err ? `error: ${oneLine(err)}` : "ok", success: !err };
}

/** Action label and kind for non-shell tools, consistent across agents. */
function describe(tool: string, input: unknown): Pick<Capture, "kind" | "action"> {
  switch (tool) {
    case "Bash": case "Shell": case "run_terminal_cmd": case "run_shell_command":
      return { kind: "shell", action: `Bash: ${commandOf(input)}${(input as Raw)?.description ? ` (${str((input as Raw).description)})` : ""}` };
    case "Edit": case "MultiEdit": case "replace": case "edit_file": case "search_replace": case "StrReplace":
      return { kind: "edit", action: `Edit: ${fileOf(input)}` };
    case "Write": case "write_file": case "create_file":
      return { kind: "edit", action: `Write: ${fileOf(input)}` };
    default:
      return { kind: "tool", action: `${tool}: ${str(input).slice(0, 200)}` };
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Parses a hook payload into a Capture, or null when it should be ignored
 * (wrong event, read-only tool, jinamem's own tools, user interrupts).
 */
export function parseEvent(raw: Raw, hint?: Agent): Capture | null {
  const agent = hint ?? detectAgent(raw);
  const tool = str(raw.tool_name);
  if (tool && (SKIP.test(tool) || isJinamemTool(tool))) return null;

  switch (agent) {
    case "claude": return fromClaude(raw);
    case "codex":  return fromCodex(raw);
    case "cursor": return fromCursor(raw);
    case "gemini": return fromGemini(raw);
  }
}

/** Only shell commands are logged on success; everything else only when it
 *  fails — successful edits are noise in a briefing. */
export function worthLogging(c: Capture): boolean {
  return c.kind === "shell" || !c.success;
}
