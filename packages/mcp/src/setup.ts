#!/usr/bin/env node
/**
 * jinamem-setup — one-command setup for Claude Code, Codex, Cursor and Gemini CLI
 *
 * Usage (in your project directory):
 *   npx -y -p @jinamem/mcp jinamem-setup
 *   # or, after `npm install -g @jinamem/mcp`:
 *   jinamem-setup
 *
 *   # choose agents explicitly (default: the ones installed on this machine)
 *   jinamem-setup --agents claude,codex,cursor,gemini
 *
 *   # hosted version (jinamem.dev) or a self-hosted cloud API:
 *   jinamem-setup --token am_live_... [--api-url https://your-host]
 *   jinamem-setup --local          # forget the saved token, back to SQLite
 *
 * What it does, per agent, in this project:
 *   Claude Code  .mcp.json + .claude/settings.json (approval, PostToolUse(+Failure) hooks)
 *   Codex        .codex/config.toml (MCP server) + .codex/hooks.json (PostToolUse)
 *   Cursor       .cursor/mcp.json + .cursor/hooks.json (afterShellExecution, postToolUseFailure)
 *   Gemini CLI   .gemini/settings.json (MCP server + AfterTool hook)
 *
 * Plus:
 *   • With --token, saves it to ~/.jinamem/config.json so the MCP server,
 *      the hook and jinamem-watch all use the cloud (hooks don't see env
 *      vars from .mcp.json, so the token can't live there)
 *   • Prints the next steps for each agent
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, delimiter } from "path";
import { homedir } from "os";
import { AGENTS, type Agent } from "./agents.js";
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
const agentsArg = arg("--agents");
if (tokenArg && goLocal) {
  console.error("❌ Use either --token or --local, not both");
  process.exit(1);
}

const cwd = process.cwd();

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

function writeJson(path: string, data: Json) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
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

const server = globalInstall
  ? { command: "jinamem-mcp", args: [] as string[] }
  : { command: "npx", args: ["-y", "-p", "@jinamem/mcp", "jinamem-mcp"] };

const hookCmd = (agent: Agent) =>
  `${globalInstall ? "jinamem-hook" : "npx -y -p @jinamem/mcp jinamem-hook"} --agent ${agent}`;

const isJinamemHook = (h: Json) => String(h.command ?? "").includes("jinamem-hook");

/** Adds a {matcher?, hooks:[...]} group under an event unless one is already there. */
function addHookGroup(hooks: Json, event: string, group: Json): boolean {
  const list = (hooks[event] as Json[] | undefined) ?? [];
  const has = list.some(g => isJinamemHook(g) ||
    (g.hooks as Json[] | undefined)?.some(isJinamemHook));
  if (!has) list.push(group);
  hooks[event] = list;
  return !has;
}

const log = (msg: string) => console.log(`    ✓ ${msg}`);

// ─── Agent detection ─────────────────────────────────────────────────────────

const home = homedir();
const DETECT: Record<Agent, () => boolean> = {
  claude: () => onPath("claude") || existsSync(join(home, ".claude")) || existsSync(join(cwd, ".claude")),
  codex:  () => onPath("codex") || existsSync(join(home, ".codex")),
  cursor: () => onPath("cursor") || onPath("cursor-agent") || existsSync(join(home, ".cursor")),
  gemini: () => onPath("gemini") || existsSync(join(home, ".gemini")),
};

function chooseAgents(): Agent[] {
  if (agentsArg) {
    const wanted = agentsArg.split(",").map(a => a.trim().toLowerCase()).filter(Boolean);
    const bad = wanted.filter(a => !(AGENTS as string[]).includes(a));
    if (bad.length) {
      console.error(`❌ Unknown agent(s): ${bad.join(", ")}. Choose from: ${AGENTS.join(", ")}`);
      process.exit(1);
    }
    return wanted as Agent[];
  }
  const found = AGENTS.filter(a => DETECT[a]());
  noneDetected = found.length === 0;
  return noneDetected ? ["claude"] : found;
}
let noneDetected = false;

// ─── Per-agent configuration ─────────────────────────────────────────────────

interface Result { files: string[]; next: string }

/** Claude Code: .mcp.json + approval and hooks in .claude/settings.json */
function setupClaude(): Result {
  const mcpPath = join(cwd, ".mcp.json");
  const settingsPath = join(cwd, ".claude", "settings.json");
  const mcp = readJson(mcpPath);
  const settings = readJson(settingsPath);

  const servers = (mcp.mcpServers ??= {}) as Json;
  if (!servers.jinamem) { servers.jinamem = { type: "stdio", ...server, env: {} }; log("MCP server in .mcp.json"); }

  // Pre-approve the project server so Claude Code doesn't leave it pending
  const enabled = (settings.enabledMcpjsonServers as string[] | undefined) ?? [];
  if (!enabled.includes("jinamem")) { settings.enabledMcpjsonServers = [...enabled, "jinamem"]; log("approved the server"); }

  // Remove the broken entry written by jinamem <= 0.1.0 (settings.json is not
  // where Claude Code reads project MCP servers from)
  const legacy = settings.mcpServers as Json | undefined;
  if (legacy?.jinamem) {
    delete legacy.jinamem;
    if (Object.keys(legacy).length === 0) delete settings.mcpServers;
  }

  const hooks = (settings.hooks ??= {}) as Json;
  for (const event of ["PostToolUse", "PostToolUseFailure"]) {
    if (addHookGroup(hooks, event, {
      matcher: "Bash|Edit|MultiEdit|Write",
      hooks: [{ type: "command", command: hookCmd("claude") }],
    })) log(`${event} hook`);
  }

  writeJson(mcpPath, mcp);
  writeJson(settingsPath, settings);
  return { files: [".mcp.json", ".claude/settings.json"], next: "restart Claude Code in this project" };
}

/** Codex: MCP server in .codex/config.toml, hook in .codex/hooks.json */
function setupCodex(): Result {
  const tomlPath = join(cwd, ".codex", "config.toml");
  const hooksPath = join(cwd, ".codex", "hooks.json");
  mkdirSync(join(cwd, ".codex"), { recursive: true });

  // Append a TOML table rather than rewriting the user's file
  const toml = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
  if (!/^\[mcp_servers\.jinamem\]/m.test(toml)) {
    const q = (v: string) => JSON.stringify(v);   // JSON strings are valid TOML basic strings
    const block = [
      "[mcp_servers.jinamem]",
      `command = ${q(server.command)}`,
      `args = [${server.args.map(q).join(", ")}]`,
      // Codex may start the server outside the project; pin the project name
      `env = { JINAMEM_PROJECT = ${q(cwd)} }`,
    ].join("\n");
    writeFileSync(tomlPath, (toml && !toml.endsWith("\n") ? toml + "\n" : toml) + (toml ? "\n" : "") + block + "\n");
    log("MCP server in .codex/config.toml");
  }

  // Codex has no failure event; failed commands also arrive as PostToolUse.
  // Codex warns when one config layer defines hooks both inline in
  // config.toml and in hooks.json, so follow whichever format the project
  // already uses.
  const MATCHER = "Bash|apply_patch|Edit|Write";
  const tomlNow = readFileSync(tomlPath, "utf8");
  const inlineHooks = /^\s*\[\[?hooks[.\]]/m.test(tomlNow);
  const inlineArrayForm = /^\s*PostToolUse\s*=/m.test(tomlNow);   // [hooks] PostToolUse = [...]
  const jsonCfg = readJson(hooksPath);
  const inJson = ((jsonCfg.hooks as Json | undefined)?.PostToolUse as Json[] | undefined)
    ?.some(g => (g.hooks as Json[] | undefined)?.some(isJinamemHook)) ?? false;
  const inToml = /jinamem-hook/.test(tomlNow);

  if (inJson || inToml) {
    // already configured in one of the two places
  } else if (inlineHooks && !inlineArrayForm) {
    const q = (v: string) => JSON.stringify(v);
    const block = [
      "[[hooks.PostToolUse]]",
      `matcher = ${q(MATCHER)}`,
      "",
      "[[hooks.PostToolUse.hooks]]",
      'type = "command"',
      `command = ${q(hookCmd("codex"))}`,
      "timeout = 30",
    ].join("\n");
    writeFileSync(tomlPath, tomlNow + (tomlNow.endsWith("\n") ? "" : "\n") + "\n" + block + "\n");
    log("PostToolUse hook in .codex/config.toml (your hooks live there)");
  } else {
    const hooks = (jsonCfg.hooks ??= {}) as Json;
    addHookGroup(hooks, "PostToolUse", {
      matcher: MATCHER,
      hooks: [{ type: "command", command: hookCmd("codex"), timeout: 30 }],
    });
    writeJson(hooksPath, jsonCfg);
    log("PostToolUse hook in .codex/hooks.json");
  }

  return {
    files: [".codex/config.toml"],
    next: "trust this project in Codex, then run /hooks once to approve jinamem's hook (Codex asks before running project hooks)",
  };
}

/** Cursor: .cursor/mcp.json + .cursor/hooks.json */
function setupCursor(): Result {
  const mcpPath = join(cwd, ".cursor", "mcp.json");
  const hooksPath = join(cwd, ".cursor", "hooks.json");

  const mcp = readJson(mcpPath);
  const servers = (mcp.mcpServers ??= {}) as Json;
  if (!servers.jinamem) {
    // ${workspaceFolder} keeps the file portable if it's committed
    servers.jinamem = { ...server, env: { JINAMEM_PROJECT: "${workspaceFolder}" } };
    log("MCP server in .cursor/mcp.json");
  }
  writeJson(mcpPath, mcp);

  const cfg = readJson(hooksPath);
  cfg.version ??= 1;
  const hooks = (cfg.hooks ??= {}) as Json;
  // Shell results (no exit code from Cursor — judged by output) and tool failures
  for (const event of ["afterShellExecution", "postToolUseFailure"]) {
    if (addHookGroup(hooks, event, { command: hookCmd("cursor") })) log(`${event} hook`);
  }
  writeJson(hooksPath, cfg);

  return { files: [".cursor/mcp.json", ".cursor/hooks.json"], next: "Cursor reloads hooks automatically; enable the jinamem server under Settings → MCP if prompted" };
}

/** Gemini CLI: MCP server and AfterTool hook in .gemini/settings.json */
function setupGemini(): Result {
  const path = join(cwd, ".gemini", "settings.json");
  const settings = readJson(path);

  const servers = (settings.mcpServers ??= {}) as Json;
  if (!servers.jinamem) {
    servers.jinamem = { ...server, env: { JINAMEM_PROJECT: cwd } };
    log("MCP server in .gemini/settings.json");
  }
  const hooks = (settings.hooks ??= {}) as Json;
  if (addHookGroup(hooks, "AfterTool", {
    matcher: "run_shell_command|write_file|replace",
    hooks: [{ name: "jinamem", type: "command", command: hookCmd("gemini"), timeout: 10000 }],
  })) log("AfterTool hook");
  writeJson(path, settings);

  return { files: [".gemini/settings.json"], next: "restart Gemini CLI in this project" };
}

const SETUP: Record<Agent, () => Result> = {
  claude: setupClaude, codex: setupCodex, cursor: setupCursor, gemini: setupGemini,
};
const NAMES: Record<Agent, string> = {
  claude: "Claude Code", codex: "Codex", cursor: "Cursor", gemini: "Gemini CLI",
};

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log("\n🧠 jinamem setup\n");
  console.log(`Project: ${cwd}`);
  console.log(`Mode:    ${globalInstall ? "global install" : "npx (run `npm i -g @jinamem/mcp` for faster hooks)"}`);

  if (tokenArg) {
    const path = writeConfig({ token: tokenArg, apiUrl: apiUrlArg });
    console.log(`\n  ✓ Saved cloud token to ${path}`);
  } else if (apiUrlArg) {
    writeConfig({ apiUrl: apiUrlArg });
    console.log(`\n  ✓ Saved API URL to ${configPath()}`);
  } else if (goLocal) {
    writeConfig({ token: "", apiUrl: "" });
    console.log("\n  ✓ Removed saved cloud token — using local SQLite");
  }

  const agents = chooseAgents();
  console.log(`Agents:  ${agents.map(a => NAMES[a]).join(", ")}${agentsArg ? "" : noneDetected ? " (default — no agents detected; choose with --agents)" : " (detected — change with --agents)"}\n`);

  const results: Array<[Agent, Result]> = [];
  for (const agent of agents) {
    console.log(`  ${NAMES[agent]}`);
    const r = SETUP[agent]();
    if (!r.files.length) continue;
    results.push([agent, r]);
  }

  const store = resolveStoreConfig();
  console.log(`\n✅ Done! Storage: ${store.mode === "cloud" ? `cloud · ${store.apiUrl}` : `local · ${store.dbPath}`}`);
  if (goLocal && process.env.JINAMEM_TOKEN) {
    console.log("⚠️  JINAMEM_TOKEN is still set in your environment and takes precedence.");
  }
  console.log("\nNext:");
  for (const [agent, r] of results) console.log(`  • ${NAMES[agent]}: ${r.next}`);
  console.log("\nOne memory is shared by every agent in this project.\n");
}

main();
