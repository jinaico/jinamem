import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEvent, detectAgent, worthLogging, exitCodeOf } from "./agents.js";

const cwd = "/home/dev/myapp";

// ─── Claude Code ─────────────────────────────────────────────────────────────

test("claude: successful Bash with stderr warnings is a success", () => {
  const c = parseEvent({
    hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm install" },
    tool_response: { stdout: "added 12 packages", stderr: "npm warn deprecated foo@1", interrupted: false },
    session_id: "s1", cwd,
  })!;
  assert.equal(c.agent, "claude");
  assert.equal(c.success, true);
  assert.equal(c.action, "Bash: npm install");
  assert.equal(c.result, "added 12 packages");
});

test("claude: piped test failure (exit 0) is caught from the output", () => {
  const c = parseEvent({
    hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test | tail -3" },
    tool_response: { stdout: "Tests: 2 failed, 5 passed", stderr: "" }, session_id: "s1", cwd,
  })!;
  assert.equal(c.success, false);
});

test("claude: '0 failed' is not a failure", () => {
  const c = parseEvent({
    hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" },
    tool_response: { stdout: "Tests: 0 failed, 7 passed", stderr: "" }, session_id: "s1", cwd,
  })!;
  assert.equal(c.success, true);
});

test("claude: PostToolUseFailure is a dead end, flattened to one line", () => {
  const c = parseEvent({
    hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm test" },
    error: "Exit code 1\nError: Cannot find module 'express'", session_id: "s1", cwd,
  })!;
  assert.equal(c.success, false);
  assert.equal(c.result, "error: Error: Cannot find module 'express'");   // "Exit code 1" adds nothing
});

test("claude: failed Edit is logged, successful Edit is not", () => {
  const fail = parseEvent({
    hook_event_name: "PostToolUseFailure", tool_name: "Edit", tool_input: { file_path: "src/a.ts" },
    error: "String to replace not found in file.", cwd,
  })!;
  assert.equal(fail.action, "Edit: src/a.ts");
  assert.equal(worthLogging(fail), true);
  const ok = parseEvent({
    hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "src/a.ts" },
    tool_response: { filePath: "src/a.ts" }, cwd,
  })!;
  assert.equal(worthLogging(ok), false);
});

test("claude: user interrupts and read-only / jinamem tools are ignored", () => {
  assert.equal(parseEvent({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: {}, error: "x", is_interrupt: true }), null);
  assert.equal(parseEvent({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} }), null);
  assert.equal(parseEvent({ hook_event_name: "PostToolUse", tool_name: "mcp__jinamem__remember", tool_input: {} }), null);
});

// ─── Codex ───────────────────────────────────────────────────────────────────

test("codex: detected from turn_id", () => {
  assert.equal(detectAgent({ hook_event_name: "PostToolUse", turn_id: "t1", tool_name: "Bash" }), "codex");
});

test("codex: non-zero exit in text output is a failure (no failure event)", () => {
  const c = parseEvent({
    hook_event_name: "PostToolUse", turn_id: "t1", tool_name: "Bash", tool_input: { command: "pytest" },
    tool_response: "Exit code: 1\nWall time: 2.1 seconds\nOutput:\nE   ModuleNotFoundError: No module named 'flask'",
    session_id: "c1", cwd,
  })!;
  assert.equal(c.agent, "codex");
  assert.equal(c.success, false);
  assert.match(c.result, /^error: exit 1 · .*ModuleNotFoundError/);
});

test("codex: structured exit_code 0 is a success even with scary words", () => {
  const c = parseEvent({
    hook_event_name: "PostToolUse", turn_id: "t1", tool_name: "Bash", tool_input: { command: ["bash", "-lc", "grep -r error ."] },
    tool_response: { exit_code: 0, output: "src/log.ts: error: handled" }, cwd,
  })!;
  assert.equal(c.success, true);
  assert.equal(c.action, "Bash: bash -lc grep -r error .");
});

test("codex: failed apply_patch names the files", () => {
  const c = parseEvent({
    hook_event_name: "PostToolUse", turn_id: "t1", tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: src/server.ts\n@@\n-old\n+new\n*** End Patch" },
    tool_response: "apply_patch verification failed: context not found", cwd,
  })!;
  assert.equal(c.action, "Edit: src/server.ts");
  assert.equal(c.success, false);
});

test("codex: successful apply_patch is not worth logging", () => {
  const c = parseEvent({
    hook_event_name: "PostToolUse", turn_id: "t1", tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch" },
    tool_response: "Success. Updated the following files:\nA a.txt", cwd,
  })!;
  assert.equal(c.success, true);
  assert.equal(worthLogging(c), false);
});

// ─── Cursor ──────────────────────────────────────────────────────────────────

test("cursor: detected from camelCase event / cursor_version", () => {
  assert.equal(detectAgent({ hook_event_name: "afterShellExecution" }), "cursor");
  assert.equal(detectAgent({ hook_event_name: "postToolUseFailure", cursor_version: "2.1" }), "cursor");
});

test("cursor: shell output judged by content; project from workspace root", () => {
  const c = parseEvent({
    hook_event_name: "afterShellExecution", command: "cargo build", conversation_id: "conv1",
    output: "error[E0425]: cannot find value `x`\nerror: could not compile `app`", duration: 900,
    workspace_roots: [cwd],
  })!;
  assert.equal(c.agent, "cursor");
  assert.equal(c.success, false);
  assert.equal(c.cwd, cwd);
  assert.equal(c.sessionId, "conv1");
});

test("cursor: clean shell output is a success", () => {
  const c = parseEvent({ hook_event_name: "afterShellExecution", command: "ls", output: "src\nREADME.md", workspace_roots: [cwd] })!;
  assert.equal(c.success, true);
  assert.equal(c.result, "README.md");   // last line of successful output
});

test("cursor: tool failures are dead ends; permission denials and interrupts are not", () => {
  const c = parseEvent({
    hook_event_name: "postToolUseFailure", tool_name: "Shell", tool_input: { command: "make deploy" },
    error_message: "Command timed out after 30s", failure_type: "timeout", workspace_roots: [cwd],
  })!;
  assert.equal(c.success, false);
  assert.equal(c.action, "Bash: make deploy");
  assert.match(c.result, /^timed out: /);
  assert.equal(parseEvent({ hook_event_name: "postToolUseFailure", tool_name: "Shell", tool_input: {}, error_message: "x", failure_type: "permission_denied" }), null);
  assert.equal(parseEvent({ hook_event_name: "postToolUseFailure", tool_name: "Shell", tool_input: {}, error_message: "x", is_interrupt: true }), null);
});

// ─── Gemini CLI ──────────────────────────────────────────────────────────────

test("gemini: detected from AfterTool", () => {
  assert.equal(detectAgent({ hook_event_name: "AfterTool" }), "gemini");
});

test("gemini: shell failure from exit code in llmContent", () => {
  const c = parseEvent({
    hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: { command: "go test ./..." },
    tool_response: { llmContent: "Command: go test ./...\nStdout: FAIL app 0.2s\nExit Code: 1", returnDisplay: "FAIL" },
    session_id: "g1", cwd,
  })!;
  assert.equal(c.agent, "gemini");
  assert.equal(c.success, false);
});

test("gemini: tool_response.error marks a failed edit", () => {
  const c = parseEvent({
    hook_event_name: "AfterTool", tool_name: "replace", tool_input: { file_path: "/home/dev/myapp/a.py" },
    tool_response: { llmContent: "", error: { message: "0 occurrences found for old_string", type: "EDIT_NO_OCCURRENCE_FOUND" } }, cwd,
  })!;
  assert.equal(c.action, "Edit: /home/dev/myapp/a.py");
  assert.equal(c.success, false);
  assert.equal(c.result, "error: 0 occurrences found for old_string");
});

test("gemini: successful shell command", () => {
  const c = parseEvent({
    hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: { command: "echo hi" },
    tool_response: { llmContent: "Command: echo hi\nStdout: hi\nExit Code: 0" }, cwd,
  })!;
  assert.equal(c.success, true);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

test("exitCodeOf reads structured and text forms", () => {
  assert.equal(exitCodeOf({ exit_code: 2 }), 2);
  assert.equal(exitCodeOf({ metadata: { exit_code: 0 } }), 0);
  assert.equal(exitCodeOf("Exit code: 127\nOutput:"), 127);
  assert.equal(exitCodeOf("Process exited with code 3"), 3);
  assert.equal(exitCodeOf("all good"), undefined);
});

// ─── Long build output ───────────────────────────────────────────────────────

import { extractErrors } from "./logscan.js";

const nextBuild = [
  "> next build",
  "  ▲ Next.js 15.2",
  "  Creating an optimized production build ...",
  ...Array.from({ length: 400 }, (_, i) => `  Compiling page ${i}/400 ...`),
  "Failed to compile.",
  "",
  "./src/app/api/orders/route.ts:42:18",
  "Type error: Property 'userId' does not exist on type 'Session'.",
  "  40 |   const session = await getSession();",
  "> 42 |   const id = session.userId;",
  "npm error Lifecycle script `build` failed with error:",
  "npm error code 1",
].join("\n");

test("build: the type error at the end survives, progress noise doesn't", () => {
  const out = extractErrors(nextBuild, true);
  assert.equal(out, "./src/app/api/orders/route.ts:42:18 Type error: Property 'userId' does not exist on type 'Session'.");
  assert.doesNotMatch(out, /Compiling page|npm error/);
  assert.ok(out.length <= 400);
});

test("build: claude captures the real error from a failed next build", () => {
  const c = parseEvent({
    hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm run build" },
    error: "Exit code 1\n" + nextBuild, cwd,
  })!;
  assert.match(c.result, /Property 'userId' does not exist/);
});

test("build: rust error keeps its location line", () => {
  const out = extractErrors([
    "   Compiling app v0.1.0",
    "error[E0425]: cannot find value `cfg` in this scope",
    "  --> src/main.rs:12:5",
    "error: could not compile `app` (bin \"app\") due to 1 previous error",
  ].join("\n"), true);
  assert.equal(out, "error[E0425]: cannot find value `cfg` in this scope --> src/main.rs:12:5");
});

test("build: python traceback keeps the final exception", () => {
  const out = extractErrors([
    "Traceback (most recent call last):",
    '  File "app.py", line 3, in <module>',
    "    import flask",
    "ModuleNotFoundError: No module named 'flask'",
  ].join("\n"), true);
  assert.match(out, /ModuleNotFoundError: No module named 'flask'/);
});

test("build: success keeps the last meaningful line", () => {
  assert.equal(extractErrors("Compiling...\n\n✓ Compiled successfully\n", false), "✓ Compiled successfully");
});

test("build: failure with no recognizable error falls back to the last lines", () => {
  assert.equal(extractErrors("step 1\nstep 2\nstep 3\ngave up\n", true), "step 2 · step 3 · gave up");
});

// ─── CI ──────────────────────────────────────────────────────────────────────

import { githubRepo, summarizeFailedLog } from "./ci.js";

test("ci: GitHub remotes in ssh and https form", () => {
  assert.equal(githubRepo("git@github.com:acme/shop-api.git"), "acme/shop-api");
  assert.equal(githubRepo("https://github.com/acme/shop-api"), "acme/shop-api");
  assert.equal(githubRepo("https://gitlab.com/acme/shop-api.git"), undefined);
});

test("ci: failed-step log keeps the cause, drops job/step/timestamp prefixes and boilerplate", () => {
  const log = [
    "deploy\tDeploy\t2026-11-19T07:12:00.0Z Building image...",
    "deploy\tDeploy\t2026-11-19T07:12:40.0Z ERROR: failed to solve: process \"/bin/sh -c npm ci\" did not complete successfully: exit code: 1",
    "deploy\tDeploy\t2026-11-19T07:12:40.1Z npm error ERESOLVE could not resolve dependency peer react@\"^18\" from next@15.2",
    "deploy\tDeploy\t2026-11-19T07:12:40.2Z npm error A complete log of this run can be found in: /root/.npm/_logs/x.log",
    "deploy\tDeploy\t2026-11-19T07:12:41.0Z ##[error]Process completed with exit code 1.",
  ].join("\n");
  const out = summarizeFailedLog(log);
  assert.match(out, /ERESOLVE could not resolve dependency/);
  assert.doesNotMatch(out, /2026-11-19T|A complete log|Process completed/);
});

test("cursor: make and git failures are recognized without an exit code", () => {
  for (const output of ["make: *** No rule to make target 'deploy'.  Stop.", "fatal: not a git repository (or any of the parent directories): .git"]) {
    const c = parseEvent({ hook_event_name: "afterShellExecution", command: "x", output, workspace_roots: [cwd] })!;
    assert.equal(c.success, false, output);
  }
});
