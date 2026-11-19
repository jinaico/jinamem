import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createStore,
  getSummaryClient,
  buildSummaryPrompt,
  parseSummaryOutput,
  type JinamemStore,
} from "@jinamem/core";
import { randomUUID } from "crypto";

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const USER_ID = process.env.JINAMEM_USER_ID ?? "local";

// Cloud if a token is set (JINAMEM_TOKEN or ~/.jinamem/config.json), local SQLite otherwise.
// Shared with jinamem-hook and jinamem-watch so all three write to the same place.
const { store, config } = createStore();
console.error(config.mode === "cloud"
  ? `[jinamem] cloud mode · ${config.apiUrl}`
  : `[jinamem] local mode · ${config.dbPath}`);

// One session per process — one MCP server process = one agent session.
// Replaced by the store's own session ID once the session row exists.
let SESSION_ID: string = randomUUID();
// When this session began — the decision log covers everything captured in
// the project from here on (hook and watcher captures use other session IDs).
// Store time when available, so cloud comparisons use the server's clock.
let SESSION_STARTED_AT = new Date();

// Derive project from cwd or env override
function getProject(): string {
  const cwd = process.env.JINAMEM_PROJECT ?? process.cwd();
  return cwd.split("/").filter(Boolean).slice(-2).join("-") || "default";
}

// Auto-start session on process start
let sessionStarted = false;
async function ensureSession() {
  if (sessionStarted) return;
  try {
    const session = await store.startSession(USER_ID, getProject());
    SESSION_ID = session.id;   // attempts and endSession must use the stored ID
    SESSION_STARTED_AT = session.startedAt;
    sessionStarted = true;
  } catch (err) {
    // e.g. cloud unreachable at startup — keep serving, retry on next tool call
    console.error("[jinamem] could not start session (will retry):", (err as Error).message);
  }
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "jinamem",
  version: "0.1.0",
});

// ═══════════════════════════════════════════════════════════════════════════
// RESOURCE: jinamem://briefing
// Auto-loaded by Claude Code at session start — agent reads this without
// being asked. Contains last session summary, pinned facts, dead ends.
// ═══════════════════════════════════════════════════════════════════════════

server.resource(
  "briefing",
  "jinamem://briefing",
  {
    description: "What you were working on last session, pinned facts, and known dead ends for this project. Read this at the start of every session.",
    mimeType: "text/plain",
  },
  async () => {
    await ensureSession();
    const project = getProject();
    const briefing = await store.getBriefing(USER_ID, project);
    const lines: string[] = [
      `# jinamem briefing — ${project}`,
      "",
    ];

    if (briefing.lastSession) {
      const ago = timeAgo(briefing.lastSession.endedAt);
      lines.push(`## Last session (${ago})`);
      if (briefing.lastSession.task) {
        lines.push(`Working on: "${briefing.lastSession.task}" — ${briefing.lastSession.status}`);
      }
    } else {
      lines.push("## No previous sessions — this is a fresh start.");
    }

    if (briefing.pinnedFacts.length > 0) {
      lines.push("", "## 📌 Always remember");
      briefing.pinnedFacts.forEach(f => lines.push(`• ${f}`));
    }

    if (briefing.deadEnds.length > 0) {
      lines.push("", "## 🚫 Don't retry these — already failed");
      briefing.deadEnds.forEach(d => lines.push(`• ${d}`));
    }

    if (briefing.openTasks.length > 0) {
      lines.push("", "## 🔧 Open tasks from last session");
      briefing.openTasks.forEach(t => lines.push(`• ${t}`));
    }

    if (
      briefing.pinnedFacts.length === 0 &&
      briefing.deadEnds.length === 0 &&
      briefing.openTasks.length === 0 &&
      !briefing.lastSession
    ) {
      lines.push("No memory stored yet for this project.");
      lines.push("Use remember() to pin important facts as you work.");
    }

    lines.push("", `---`, `~${briefing.tokenEstimate} tokens of context loaded.`);

    return {
      contents: [{
        uri: "jinamem://briefing",
        mimeType: "text/plain",
        text: lines.join("\n"),
      }],
    };
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT: jinamem-usage
// Injected by Claude Code automatically — tells the agent how and when
// to use each tool. Developer configures nothing.
// ═══════════════════════════════════════════════════════════════════════════

server.prompt(
  "jinamem-usage",
  "Instructions for using jinamem memory tools effectively",
  async () => {
    const project = getProject();
    const briefing = await store.getBriefing(USER_ID, project);

    const hasHistory = briefing.pinnedFacts.length > 0 ||
      briefing.deadEnds.length > 0 ||
      !!briefing.lastSession;

    return {
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "You have access to jinamem — a persistent memory layer for this project.",
            "",
            hasHistory
              ? `Your session briefing (jinamem://briefing) has been loaded. It contains your previous context for project: ${project}.`
              : `This is your first session on project: ${project}. No memory stored yet.`,
            "",
            "## How to use jinamem tools:",
            "",
            "**Before starting any task:**",
            "  → call recall(query) to check if you've worked on something similar before",
            "  → this surfaces relevant past facts, dead ends, and discoveries",
            "",
            "**When you discover something important:**",
            "  → call remember(note) for things worth knowing next session",
            "  → call remember(note, pin: true) for critical facts that must never be forgotten",
            "  → examples: a gotcha, a constraint, a decision, a workaround that works",
            "",
            "**When something fails:**",
            "  → call log_attempt(action, result, success: false)",
            "  → this prevents you from retrying the same dead end next session",
            "",
            "**When something succeeds:**",
            "  → call log_attempt(action, result, success: true)",
            "  → builds the execution history for this project",
            "",
            "The goal: future sessions should start knowing exactly what you know now.",
          ].join("\n"),
        },
      }],
    };
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// TOOLS
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  "remember",
  "Pin a fact, decision, or discovery to memory. Use for things that must survive across sessions — gotchas, constraints, decisions, known workarounds. Pin important facts so they always appear in future briefings.",
  {
    note: z.string().describe("The fact to remember. Be specific and self-contained — it will be read without the surrounding context of this session."),
    pin: z.boolean().optional().default(false).describe("Pin permanently. Pinned facts never expire and always appear in briefings. Use for critical discoveries."),
  },
  async ({ note, pin }) => {
    await ensureSession();
    await store.remember(USER_ID, getProject(), note, pin ?? false);
    return {
      content: [{
        type: "text",
        text: pin
          ? `📌 Pinned permanently: "${note}"`
          : `✓ Remembered for 90 days: "${note}"`,
      }],
    };
  },
);

server.tool(
  "recall",
  "Search memory for facts, past attempts, and known dead ends related to a topic. Call this before starting any significant task — it surfaces what you already know so you don't repeat work or hit the same dead ends.",
  {
    query: z.string().describe("What to search for. Plain language: 'JWT authentication', 'database migrations', 'why we changed the API structure'."),
    limit: z.number().optional().default(10).describe("Max results (default 10)."),
  },
  async ({ query, limit }) => {
    await ensureSession();
    const project = getProject();
    const results = await store.recall(USER_ID, project, query, limit ?? 10);

    if (results.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No memories found for "${query}" in project ${project}. This may be new territory — if you discover anything important, use remember().`,
        }],
      };
    }

    const formatted = results
      .map((r, i) => `${i + 1}. ${r.content}\n   (${r.createdAt.toLocaleDateString()} · score: ${Math.round(r.score * 100)}%)`)
      .join("\n\n");

    return {
      content: [{
        type: "text",
        text: `Found ${results.length} memories for "${query}":\n\n${formatted}`,
      }],
    };
  },
);

server.tool(
  "what_was_i_doing",
  "Get a full briefing of previous sessions — last task, pinned facts, dead ends, open tasks. The jinamem://briefing resource loads this automatically, but call this tool if you need a fresh copy mid-session.",
  {},
  async () => {
    await ensureSession();
    const project = getProject();
    const briefing = await store.getBriefing(USER_ID, project);
    const lines: string[] = [];

    if (briefing.lastSession) {
      const ago = timeAgo(briefing.lastSession.endedAt);
      lines.push(`## Last session (${ago})`);
      if (briefing.lastSession.task) {
        lines.push(`Task: "${briefing.lastSession.task}" — ${briefing.lastSession.status}`);
      }
    } else {
      lines.push("No previous sessions found for this project.");
    }

    if (briefing.pinnedFacts.length > 0) {
      lines.push(`\n## 📌 Remember`);
      briefing.pinnedFacts.forEach(f => lines.push(`• ${f}`));
    }

    if (briefing.deadEnds.length > 0) {
      lines.push(`\n## 🚫 Don't retry`);
      briefing.deadEnds.forEach(d => lines.push(`• ${d}`));
    }

    if (briefing.openTasks.length > 0) {
      lines.push(`\n## 🔧 Open tasks`);
      briefing.openTasks.forEach(t => lines.push(`• ${t}`));
    }

    lines.push(`\n---\n~${briefing.tokenEstimate} tokens loaded.`);

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  },
);

server.tool(
  "log_attempt",
  "Record what you tried and what happened. Failed attempts are stored as dead ends automatically — they will appear in future briefings so you never retry them. Call this for any significant action, especially failures.",
  {
    action: z.string().describe("What you tried. Be specific: include file, function, or approach."),
    result: z.string().optional().describe("What happened. Include error messages for failures."),
    success: z.boolean().optional().default(true).describe("Did it work? Set false for failures, errors, dead ends."),
  },
  async ({ action, result, success }) => {
    await ensureSession();
    await store.logAttempt(
      USER_ID, getProject(), SESSION_ID,
      action, result, success ?? true,
    );

    const icon = (success ?? true) ? "✓" : "✗";
    const label = (success ?? true) ? "logged" : "logged as dead end";

    return {
      content: [{
        type: "text",
        text: `${icon} ${label}: "${action}"${result ? `\n  Result: ${result}` : ""}`,
      }],
    };
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// SHUTDOWN HANDLER
// Catches SIGTERM/SIGINT when Claude Code closes.
// Auto-summarises the session so next briefing is accurate.
// ═══════════════════════════════════════════════════════════════════════════

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;   // stdin close and SIGTERM often arrive together
  shuttingDown = true;
  console.error(`[jinamem] ${signal} received — saving session...`);

  try {
    const project = getProject();

    // 1. Try to summarize the session into decision-log entries
    const summaryClient = await getSummaryClient();
    if (summaryClient) {
      try {
        console.error(`[jinamem] summarizing session with ${summaryClient.name}...`);

        const [attempts, pinnedFacts] = await Promise.all([
          // Every attempt in the project since this session started: the
          // agent's own log_attempt calls plus hook and watcher captures
          store.getProjectAttempts(USER_ID, project, SESSION_STARTED_AT),
          store.getPinnedFacts(USER_ID, project),
        ]);

        if (attempts.length > 0) {
          const prompt = buildSummaryPrompt(project, attempts, pinnedFacts);
          const output = await summaryClient.summarize(prompt);
          const decisions = parseSummaryOutput(output);

          if (decisions.length > 0) {
            // Write each decision as a pinned fact
            for (const decision of decisions) {
              await store.remember(USER_ID, project, decision, true);
            }
            console.error(`[jinamem] stored ${decisions.length} decisions from this session.`);
          } else {
            console.error("[jinamem] no decisions worth storing this session.");
          }
        }
      } catch (err) {
        // Summarization failed — don't block shutdown
        console.error("[jinamem] summarization failed (non-fatal):", err);
      }
    }

    // 2. End the session with a timestamp
    if (sessionStarted) await store.endSession(SESSION_ID);
    console.error("[jinamem] session saved.");

  } catch (err) {
    console.error("[jinamem] failed to save session:", err);
  } finally {
    await store.close();
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP",  () => shutdown("SIGHUP"));
// MCP clients usually end a stdio server by closing its stdin, not by
// signalling it — without this the session is never ended or summarized.
process.stdin.on("end",   () => shutdown("stdin closed"));
process.stdin.on("close", () => shutdown("stdin closed"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// Also handle uncaught errors gracefully — save session before crashing
process.on("uncaughtException", async (err) => {
  console.error("[jinamem] uncaught exception:", err);
  await shutdown("uncaughtException").catch(() => process.exit(1));
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ─── Start ───────────────────────────────────────────────────────────────────

export async function startServer() {
  await ensureSession();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[jinamem] running · project: ${getProject()} · session: ${SESSION_ID}`);
}
