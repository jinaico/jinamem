import { existsSync } from "fs";
import { isAbsolute } from "path";

/**
 * One project name for every jinamem process. The MCP server, the hook,
 * jinamem-watch and CI capture must agree, or captures land in a project the
 * briefing never reads.
 *
 * JINAMEM_PROJECT (a path or a name) wins; otherwise the working directory.
 * Paths become their last two parts: /home/dev/code/shop-api → code-shop-api.
 */
/** The project's directory: JINAMEM_PROJECT when it's an existing path
 *  (Codex/Gemini/Cursor configs pin it), else the working directory. */
export function projectDir(): string {
  const p = process.env.JINAMEM_PROJECT;
  if (p && isAbsolute(p) && existsSync(p)) return p;
  return process.cwd();
}

export function projectName(cwd: string = process.cwd()): string {
  const base = process.env.JINAMEM_PROJECT || cwd;
  return base.split(/[\\/]/).filter(Boolean).slice(-2).join("-") || "default";
}
