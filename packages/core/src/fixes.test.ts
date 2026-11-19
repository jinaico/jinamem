import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fixKey, legacyAction, describeFix, formatFixed } from "./fixes.js";
import { SqliteStore } from "./sqlite-store.js";

// ─── Matching ────────────────────────────────────────────────────────────────

test("fixKey: same command matches through pipes, redirects, cd and descriptions", () => {
  const k = "Bash: npm test";
  assert.equal(fixKey("Bash: npm test"), k);
  assert.equal(fixKey("Bash: npm test 2>&1 | tail -20"), k);
  assert.equal(fixKey("Bash: cd /srv/app && npm test"), k);
  assert.equal(fixKey("Bash: npm test (Run the test suite)"), k);
  assert.equal(fixKey("Bash:   npm   test  "), k);
  assert.notEqual(fixKey("Bash: npm test -- orders"), k);
});

test("fixKey: CI matches by workflow and branch, not commit", () => {
  assert.equal(fixKey("CI: CI on main (b1c2d3e)"), "CI: CI on main");
  assert.equal(fixKey("CI: CI on main (c2d3e4f)"), "CI: CI on main");
  assert.notEqual(fixKey("CI: CI on feat/x (c2d3e4f)"), "CI: CI on main");
});

test("fixKey: runtime crashes and failed edits aren't resolved by a success", () => {
  assert.equal(fixKey("Runtime: npm run dev"), undefined);
  assert.equal(fixKey("Edit: src/a.ts"), undefined);
});

test("legacyAction: action of a dead end stored before metadata", () => {
  assert.equal(legacyAction("[dead end] Bash: npm test: error: Error: Cannot find module 'express'"), "Bash: npm test");
  assert.equal(legacyAction("[dead end] CI: CI on main (b1c2d3e): failed: TypeError x"), "CI: CI on main (b1c2d3e)");
});

// ─── Describing the fix ──────────────────────────────────────────────────────

test("describeFix: the meaningful commands in between, not the looking-around ones", () => {
  const fix = describeFix("Bash: npm test", "Bash: npm test", "7 passed", [
    "Bash: ls", "Bash: cat package.json", "Bash: git status",
    "Bash: npm install express", "Bash: npm test 2>&1 | tail -5",   // a retry of the same thing isn't the fix
  ]);
  assert.equal(fix, "fixed after `npm install express`");
});

test("describeFix: keeps the last two steps", () => {
  assert.equal(
    describeFix("Bash: pytest", "Bash: pytest", "", ["Bash: pip install -r requirements.txt", "Bash: python manage.py migrate", "Bash: export DJANGO_SETTINGS_MODULE=app.settings"]),
    "fixed after `python manage.py migrate`, then `export DJANGO_SETTINGS_MODULE=app.settings`",
  );
});

test("describeFix: CI names the commit that made it pass", () => {
  assert.equal(
    describeFix("CI: CI on main", "CI: CI on main (c2d3e4f)", "passing again after a failure · Fix orders test", []),
    'fixed in c2d3e4f "Fix orders test"',
  );
});

test("describeFix: nothing meaningful in between", () => {
  assert.equal(describeFix("Bash: npm test", "Bash: npm test", "", ["Bash: ls"]), "passing now");
});

test("formatFixed: readable line without the run URL", () => {
  assert.equal(
    formatFixed("[dead end] CI: CI on main (b1c2d3e): failed: TypeError: x at y.ts:4 · Add orders API · https://github.com/a/b/actions/runs/1", 'fixed in c2d3e4f "Fix orders test"'),
    'CI: CI on main: "TypeError: x at y.ts:4 · Add orders API" — fixed in c2d3e4f "Fix orders test"',
  );
});

// ─── End to end on SQLite ────────────────────────────────────────────────────

const freshStore = () => new SqliteStore(join(mkdtempSync(join(tmpdir(), "jm-")), "m.db"));
const tick = () => new Promise(r => setTimeout(r, 5));   // distinct timestamps

test("store: a fixed failure leaves Don't retry and shows what fixed it", async () => {
  const s = freshStore();
  await s.logAttempt("u", "p", "s1", "Bash: npm test", "error: Error: Cannot find module 'express'", false);
  await tick(); await s.logAttempt("u", "p", "s1", "Bash: ls", "src", true);
  await tick(); await s.logAttempt("u", "p", "s1", "Bash: npm install express", "added 64 packages", true);
  await tick(); await s.logAttempt("u", "p", "s1", "Bash: npm test 2>&1 | tail -3", "7 passed", true);

  const b = await s.getBriefing("u", "p");
  assert.deepEqual(b.deadEnds, []);
  assert.deepEqual(b.fixed, ["npm test: \"Error: Cannot find module 'express'\" — fixed after `npm install express`"]);
  await s.close();
});

test("store: an unrelated success doesn't resolve anything", async () => {
  const s = freshStore();
  await s.logAttempt("u", "p", "s1", "Bash: npm test", "error: boom", false);
  await tick(); await s.logAttempt("u", "p", "s1", "Bash: npm run lint", "ok", true);
  const b = await s.getBriefing("u", "p");
  assert.equal(b.deadEnds.length, 1);
  assert.deepEqual(b.fixed, []);
  await s.close();
});

test("store: other projects are untouched", async () => {
  const s = freshStore();
  await s.logAttempt("u", "p1", "s", "Bash: npm test", "error: boom", false);
  await tick(); await s.logAttempt("u", "p2", "s", "Bash: npm test", "ok", true);
  assert.equal((await s.getBriefing("u", "p1")).deadEnds.length, 1);
  await s.close();
});

test("store: CI failure resolved by a later passing run", async () => {
  const s = freshStore();
  await s.logAttempt("u", "p", "ci", "CI: CI on main (b1c2d3e)", "failed: TypeError: x · Add orders API · https://gh/runs/101", false);
  await tick(); await s.logAttempt("u", "p", "ci", "CI: CI on main (c2d3e4f)", "passing again after a failure · Fix orders test", true);
  const b = await s.getBriefing("u", "p");
  assert.deepEqual(b.deadEnds, []);
  assert.deepEqual(b.fixed, ['CI: CI on main: "TypeError: x · Add orders API" — fixed in c2d3e4f "Fix orders test"']);
  await s.close();
});

test("store: repeated failures of the same command are all resolved", async () => {
  const s = freshStore();
  for (let i = 0; i < 3; i++) { await s.logAttempt("u", "p", "s", "Bash: cargo build", `error: E0425 #${i}`, false); await tick(); }
  await s.logAttempt("u", "p", "s", "Bash: cargo build", "Finished", true);
  const b = await s.getBriefing("u", "p");
  assert.deepEqual(b.deadEnds, []);
  assert.ok((b.fixed ?? []).length >= 1);
  await s.close();
});

test("store: dead ends saved before fix tracking (no metadata) are resolved too", async () => {
  const s = freshStore();
  // Simulate an old row: plain remember() with the dead-end text
  await s.remember("u", "p", "[dead end] Bash: make build: error: make: *** No rule to make target", false);
  await tick(); await s.logAttempt("u", "p", "s", "Bash: make build", "done", true);
  const b = await s.getBriefing("u", "p");
  assert.deepEqual(b.deadEnds, []);
  assert.equal(b.fixed?.length, 1);
  await s.close();
});
