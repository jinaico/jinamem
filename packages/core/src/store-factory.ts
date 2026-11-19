/**
 * createStore — picks the right backend for every jinamem process
 * (MCP server, hook, log watcher) from one shared configuration.
 *
 * Cloud mode is used when a token is found, in this order:
 *   1. JINAMEM_TOKEN / JINAMEM_API_URL environment variables
 *   2. ~/.jinamem/config.json  → { "token": "...", "apiUrl": "..." }
 *
 * The config file matters because Claude Code hooks run as separate
 * processes: env vars set on the MCP server in .mcp.json are not visible
 * to them. `jinamem-setup --token ...` writes the file.
 *
 * Otherwise local SQLite is used (JINAMEM_DB_PATH or ~/.jinamem/memory.db).
 * JINAMEM_HOME relocates the whole ~/.jinamem directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import type { JinamemStore } from "./types.js";
import { SqliteStore } from "./sqlite-store.js";
import { CloudStore } from "./cloud-store.js";

export const DEFAULT_API_URL = "https://jinamem.dev";

export interface JinamemConfig {
  token?: string;
  apiUrl?: string;
}

export function jinamemDir(): string {
  return process.env.JINAMEM_HOME ?? resolve(homedir(), ".jinamem");
}

export function configPath(): string {
  return resolve(jinamemDir(), "config.json");
}

export function readConfig(): JinamemConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JinamemConfig;
  } catch {
    return {};
  }
}

/** Writes ~/.jinamem/config.json, readable only by the current user. */
export function writeConfig(update: JinamemConfig): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const merged = { ...readConfig(), ...update };
  for (const k of Object.keys(merged) as (keyof JinamemConfig)[]) {
    if (merged[k] === undefined || merged[k] === "") delete merged[k];
  }
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* non-POSIX filesystems */ }
  return path;
}

export interface ResolvedStoreConfig {
  mode: "cloud" | "local";
  token?: string;
  apiUrl?: string;
  dbPath?: string;
}

export function resolveStoreConfig(): ResolvedStoreConfig {
  const file = readConfig();
  const token = process.env.JINAMEM_TOKEN || file.token;
  if (token) {
    return {
      mode: "cloud",
      token,
      apiUrl: process.env.JINAMEM_API_URL || file.apiUrl || DEFAULT_API_URL,
    };
  }
  return { mode: "local", dbPath: process.env.JINAMEM_DB_PATH || resolve(jinamemDir(), "memory.db") };
}

export interface CreateStoreOptions {
  /** Per-request timeout for cloud mode, in ms. */
  timeoutMs?: number;
}

export function createStore(opts: CreateStoreOptions = {}): { store: JinamemStore; config: ResolvedStoreConfig } {
  const config = resolveStoreConfig();
  if (config.mode === "cloud") {
    return { store: new CloudStore(config.token!, config.apiUrl, opts.timeoutMs), config };
  }
  mkdirSync(jinamemDir(), { recursive: true });
  return { store: new SqliteStore(config.dbPath), config };
}
