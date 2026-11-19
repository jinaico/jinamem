#!/usr/bin/env node
/**
 * jinamem-setup — one-command setup for Claude Code projects
 *
 * Usage (in your project directory):
 *   npx -y -p @jinamem/mcp jinamem-setup
 *   # or, after `npm install -g @jinamem/mcp`:
 *   jinamem-setup
 *
 * What it does:
 *   1. Adds the jinamem MCP server to .mcp.json (Claude Code's project MCP config)
 *   2. Approves it and adds PostToolUse + PostToolUseFailure hooks in
 *      .claude/settings.json
 *   3. Prints the next step (restart Claude Code)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, delimiter } from "path";

const cwd = process.cwd();
const claudeDir = join(cwd, ".claude");
const settingsPath = join(claudeDir, "settings.json");
const mcpJsonPath = join(cwd, ".mcp.json");

type Json = Record<string, unknown>;

function readJson(path: string): Json {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Json;
  } catch {
    console.error(`⚠️  Could not parse ${path} — leaving it untouched.`);
    process.exit(1);
  }
}

// ─── Command resolution ──────────────────────────────────────────────────────
// Use the global binaries when installed (fast: the hook runs after every tool
// call); otherwise fall back to npx, which works with no global install.

function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter);
  const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  return dirs.some(d => exts.some(e => d && existsSync(join(d, bin + e))));
}

const globalInstall = onPath("jinamem-mcp") && onPath("jinamem-hook");

const mcpEntry = globalInstall
  ? { type: "stdio", command: "jinamem-mcp", args: [] as string[], env: {} }
  : { type: "stdio", command: "npx", args: ["-y", "-p", "@jinamem/mcp", "jinamem-mcp"], env: {} };

const hookCommand = globalInstall
  ? "jinamem-hook"
  : "npx -y -p @jinamem/mcp jinamem-hook";

const MATCHER = "Bash|Edit|MultiEdit|Write";
const HOOK_EVENTS = ["PostToolUse", "PostToolUseFailure"] as const;

// ─── Merge helpers ────────────────────────────────────────────────────────────

function mergeMcpJson(mcp: Json): void {
  if (!mcp.mcpServers) mcp.mcpServers = {};
  const servers = mcp.mcpServers as Json;
  if (servers.jinamem) {
    console.log("  ✓ MCP server already in .mcp.json");
  } else {
    servers.jinamem = mcpEntry;
    console.log("  ✓ Added MCP server to .mcp.json");
  }
}

function mergeSettings(settings: Json): void {
  // Pre-approve the project server so Claude Code doesn't leave it pending
  const enabled = (settings.enabledMcpjsonServers as string[] | undefined) ?? [];
  if (!enabled.includes("jinamem")) {
    settings.enabledMcpjsonServers = [...enabled, "jinamem"];
    console.log("  ✓ Approved jinamem server");
  }

  // Remove the broken entry written by jinamem <= 0.1.0 (settings.json is not
  // where Claude Code reads project MCP servers from)
  const legacy = settings.mcpServers as Json | undefined;
  if (legacy?.jinamem) {
    delete legacy.jinamem;
    if (Object.keys(legacy).length === 0) delete settings.mcpServers;
  }

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Json;

  for (const event of HOOK_EVENTS) {
    const list = (hooks[event] as Array<Json> | undefined) ?? [];
    const has = list.some(h =>
      (h.hooks as Array<Json> | undefined)?.some(inner =>
        String(inner.command ?? "").includes("jinamem-hook")));
    if (has) {
      console.log(`  ✓ ${event} hook already configured`);
    } else {
      list.push({ matcher: MATCHER, hooks: [{ type: "command", command: hookCommand }] });
      console.log(`  ✓ Added ${event} hook`);
    }
    hooks[event] = list;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log("\n🧠 jinamem setup\n");
  console.log(`Project: ${cwd}`);
  console.log(`Mode:    ${globalInstall ? "global install" : "npx (run `npm i -g @jinamem/mcp` for faster hooks)"}\n`);

  const mcp = readJson(mcpJsonPath);
  const settings = readJson(settingsPath);

  mergeMcpJson(mcp);
  mergeSettings(settings);

  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(mcpJsonPath, JSON.stringify(mcp, null, 2) + "\n");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  console.log(`\n✅ Done! Wrote .mcp.json and .claude/settings.json`);
  console.log("\nNext: restart Claude Code in this project.");
  console.log("jinamem will start capturing your session automatically.\n");
}

main();
