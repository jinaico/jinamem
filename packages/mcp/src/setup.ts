#!/usr/bin/env node
/**
 * jinamem-setup — one-command setup for Claude Code projects
 *
 * Usage (in your project directory):
 *   npx -y -p @jinamem/mcp jinamem-setup
 *   # or, after `npm install -g @jinamem/mcp`:
 *   jinamem-setup
 *
 *   # hosted version (jinamem.dev) or a self-hosted cloud API:
 *   jinamem-setup --token am_live_... [--api-url https://your-host]
 *   jinamem-setup --local          # forget the saved token, back to SQLite
 *
 * What it does:
 *   1. Adds the jinamem MCP server to .mcp.json (Claude Code's project MCP config)
 *   2. Approves it and adds PostToolUse + PostToolUseFailure hooks in
 *      .claude/settings.json
 *   3. With --token, saves it to ~/.jinamem/config.json so the MCP server,
 *      the hook and jinamem-watch all use the cloud (hooks don't see env
 *      vars from .mcp.json, so the token can't live there)
 *   4. Prints the next step (restart Claude Code)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, delimiter } from "path";
import { writeConfig, resolveStoreConfig, configPath } from "@jinamem/core";

// ─── Args ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) {
    console.error(`❌ ${name} needs a value`);
    process.exit(1);
  }
  return v;
}
const tokenArg = arg("--token");
const apiUrlArg = arg("--api-url");
const goLocal = argv.includes("--local");
if (tokenArg && goLocal) {
  console.error("❌ Use either --token or --local, not both");
  process.exit(1);
}

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

  if (tokenArg) {
    const path = writeConfig({ token: tokenArg, apiUrl: apiUrlArg });
    console.log(`  ✓ Saved cloud token to ${path}`);
  } else if (apiUrlArg) {
    writeConfig({ apiUrl: apiUrlArg });
    console.log(`  ✓ Saved API URL to ${configPath()}`);
  } else if (goLocal) {
    writeConfig({ token: "", apiUrl: "" });
    console.log("  ✓ Removed saved cloud token — using local SQLite");
  }

  const mcp = readJson(mcpJsonPath);
  const settings = readJson(settingsPath);

  mergeMcpJson(mcp);
  mergeSettings(settings);

  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(mcpJsonPath, JSON.stringify(mcp, null, 2) + "\n");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  const store = resolveStoreConfig();
  console.log(`\n✅ Done! Wrote .mcp.json and .claude/settings.json`);
  console.log(store.mode === "cloud"
    ? `Storage: cloud · ${store.apiUrl}`
    : `Storage: local · ${store.dbPath}`);
  if (goLocal && process.env.JINAMEM_TOKEN) {
    console.log("⚠️  JINAMEM_TOKEN is still set in your environment and takes precedence.");
  }
  console.log("\nNext: restart Claude Code in this project.");
  console.log("jinamem will start capturing your session automatically.\n");
}

main();
