#!/usr/bin/env node
/**
 * jinamem-setup — one-command setup for Claude Code projects
 *
 * Usage: npx jinamem-setup
 *
 * What it does:
 *   1. Creates/updates .claude/settings.json with MCP server + hook config
 *   2. Prints the next step (restart Claude Code)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, join } from "path";

const cwd = process.cwd();
const claudeDir = join(cwd, ".claude");
const settingsPath = join(claudeDir, "settings.json");

// ─── Read existing settings ───────────────────────────────────────────────────

function readSettings(): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    console.error("⚠️  Could not parse existing .claude/settings.json — will merge carefully.");
    return {};
  }
}

// ─── MCP server config ────────────────────────────────────────────────────────

const mcpEntry = {
  "jinamem": {
    "type": "stdio",
    "command": "jinamem-mcp",
    "env": {}
  }
};

// ─── Hook config ─────────────────────────────────────────────────────────────

const hookEntry = {
  "matcher": "Bash|Edit|MultiEdit|Write",
  "hooks": [{
    "type": "command",
    "command": "jinamem-hook"
  }]
};

// ─── Merge helpers ────────────────────────────────────────────────────────────

function mergeMcp(settings: Record<string, unknown>): void {
  if (!settings.mcpServers) settings.mcpServers = {};
  const servers = settings.mcpServers as Record<string, unknown>;
  if (servers.jinamem) {
    console.log("  ✓ MCP server already configured");
  } else {
    Object.assign(servers, mcpEntry);
    console.log("  ✓ Added MCP server");
  }
}

function mergeHooks(settings: Record<string, unknown>): void {
  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown>;

  if (!hooks.PostToolUse) {
    hooks.PostToolUse = [hookEntry];
    console.log("  ✓ Added PostToolUse hook");
    return;
  }

  const existing = hooks.PostToolUse as Array<Record<string, unknown>>;
  const alreadyHasHook = existing.some(h => {
    const hs = h.hooks as Array<Record<string, unknown>> | undefined;
    return hs?.some(inner => inner.command === "jinamem-hook");
  });

  if (alreadyHasHook) {
    console.log("  ✓ Hook already configured");
  } else {
    existing.push(hookEntry);
    console.log("  ✓ Added PostToolUse hook");
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log("\n🧠 jinamem setup\n");
  console.log(`Project: ${cwd}`);
  console.log(`Config:  ${settingsPath}\n`);

  mkdirSync(claudeDir, { recursive: true });

  const settings = readSettings();

  mergeMcp(settings);
  mergeHooks(settings);

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  console.log(`\n✅ Done! Wrote ${settingsPath}`);
  console.log("\nNext: restart Claude Code in this project.");
  console.log("jinamem will start capturing your session automatically.\n");
}

main();
