/**
 * Fix tracking: when something that failed later succeeds, its dead end is
 * resolved and the briefing shows what fixed it instead of "don't retry".
 *
 *   ✗ Bash: npm test → Cannot find module 'express'
 *   ✓ Bash: npm install express
 *   ✓ Bash: npm test                  → resolves the dead end
 *   briefing: ✅ npm test: "Cannot find module 'express'" — fixed after `npm install express`
 *
 * Shared by the SQLite and Postgres stores so both behave identically.
 */

/** Dead-end memory metadata. */
export interface DeadEndMeta {
  deadEnd?: true;
  key?: string;          // fixKey of the failing action
  action?: string;
  resolved?: { at: string; fix: string; via: string };
}

/** Days a fix stays in the briefing. */
export const FIXED_VISIBLE_DAYS = 14;

/**
 * What has to succeed for a failure to count as fixed. Same key = same thing.
 * Returns undefined for actions a later success can't resolve (runtime
 * crashes, failed edits).
 *
 *   "Bash: npm test 2>&1 | tail -20 (Run tests)" → "Bash: npm test"
 *   "CI: CI on main (b1c2d3e)"                    → "CI: CI on main"
 */
export function fixKey(action: string): string | undefined {
  const ci = action.match(/^CI: (.+?) \([0-9a-f]{7,40}\)$/);
  if (ci) return `CI: ${ci[1]}`;

  const bash = action.match(/^Bash: (.+)$/s);
  if (!bash) return undefined;
  let cmd = bash[1]
    .replace(/\s+\([^()]*\)$/, "")                                   // Claude Code's description
    .replace(/^\s*cd\s+\S+\s*&&\s*/, "")                             // cd dir && …
    .replace(/\s+2>&1/g, "")
    .replace(/\s*\|&?\s*(tail|head|grep|less|more|cat|tee)\b.*$/, "")  // output filters
    .replace(/\s+/g, " ")
    .trim();
  return cmd ? `Bash: ${cmd}` : undefined;
}

/** The action of a dead end stored before metadata existed. */
export function legacyAction(content: string): string {
  return content.replace(/^\[dead end\] /, "").split(/: (?=(error|failed|timed out|interrupted)\b)/)[0];
}

// Commands that look around rather than change anything — never "the fix"
const LOOKING = /^(ls|ll|cat|less|more|head|tail|grep|rg|find|fd|pwd|cd|echo|which|whoami|env|printenv|tree|wc|file|stat|du|df|ps|top|clear|history|man|git (status|diff|log|show|branch|remote|fetch)|npm (ls|list|view|outdated)|pip (list|show|freeze)|cargo tree|docker (ps|images|logs))\b/;

/**
 * What fixed it.
 *  - CI: the commit that made it pass
 *  - commands: the last meaningful commands run between the failure and the success
 */
export function describeFix(
  failedKey: string, successAction: string, successResult: string | undefined, between: string[],
): string {
  if (failedKey.startsWith("CI: ")) {
    const sha = successAction.match(/\(([0-9a-f]{7,40})\)$/)?.[1]?.slice(0, 7);
    const title = (successResult ?? "").replace(/^passing again after a failure\s*·\s*/, "").trim();
    return sha ? `fixed in ${sha}${title ? ` "${title}"` : ""}` : "passing again";
  }

  const steps: string[] = [];
  for (const a of between) {
    const m = a.match(/^Bash: (.+)$/s);
    if (!m) continue;
    const cmd = (fixKey(a) ?? a).replace(/^Bash: /, "");
    if (fixKey(a) === failedKey || LOOKING.test(cmd)) continue;
    if (!steps.includes(cmd)) steps.push(cmd);
  }
  const last = steps.slice(-2).map(s => `\`${s.length > 80 ? s.slice(0, 77) + "…" : s}\``);
  return last.length ? `fixed after ${last.join(", then ")}` : "passing now";
}

/** One briefing line for a resolved dead end. */
export function formatFixed(deadEndContent: string, fix: string): string {
  const body = deadEndContent.replace(/^\[dead end\] /, "");
  const action = legacyAction(deadEndContent);
  const what = (fixKey(action) ?? action).replace(/^Bash: /, "");
  let error = body.slice(action.length).replace(/^:\s*(error|failed|timed out):?\s*/i, "").trim();
  error = error.replace(/\s*·\s*https?:\/\/\S+$/, "");          // CI run URL
  if (error.length > 100) error = error.slice(0, 97) + "…";
  return `${what}${error ? `: "${error}"` : ""} — ${fix}`;
}
