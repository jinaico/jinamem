# jinamem

**Persistent memory for AI agents. Open source.**

Your AI agent forgets everything between sessions. Jinamem fixes that — it's an MCP server that captures what your agent tried, what failed, and what it discovered, then gives it an instant briefing next time it starts.

Works with **Claude Code, Codex, Cursor and Gemini CLI** — and they share one memory, so a dead end hit in Cursor is a dead end your Claude Code session already knows about.

```
> what_was_i_doing()

Last session: "fix auth middleware" — completed (8h ago)

📌 Remember
• JWT tokens missing exp field on legacy API
• Token factory now adds default exp — don't revert this

🚫 Don't retry  
• Patching verifyToken directly (causes TypeError)

✅ Fixed
• npm test: "Cannot find module 'express'" — fixed after `npm install express`

🔧 Open tasks
• Write regression test for exp field validation

Context loaded in ~340 tokens (vs ~3,200 manual recap)
```

---

## Why

Every agent session starts cold. The agent re-reads the codebase, re-discovers what's broken, re-runs the same exploratory commands it ran yesterday. We call it **AI Groundhog Day** — and it costs you tokens, time, and accuracy.

Jinamem gives your agent a memory layer that persists across sessions, so it picks up exactly where it stopped.

---

## Quickstart (30 seconds)

Requires Node.js 20 or later.

```bash
# Recommended: install once, globally (the hook runs after every tool call, so this keeps it fast)
npm install -g @jinamem/mcp

# Then, in your project directory:
jinamem-setup
```

No global install? This works too (slightly slower hooks):

```bash
npx -y -p @jinamem/mcp jinamem-setup
```

That's it. `jinamem-setup` detects which coding agents you have installed and configures each one for this project. Restart your agent and jinamem starts capturing automatically. To pick agents yourself:

```bash
jinamem-setup --agents claude,codex,cursor,gemini
```

What it writes, per agent:

| Agent | MCP server | Automatic capture |
|-------|-----------|-------------------|
| Claude Code | `.mcp.json` (approved in `.claude/settings.json`) | `PostToolUse` + `PostToolUseFailure` hooks in `.claude/settings.json` |
| Codex | `.codex/config.toml` | `PostToolUse` hook in `.codex/hooks.json` — run `/hooks` once to approve it, since Codex asks before running project hooks |
| Cursor | `.cursor/mcp.json` | `afterShellExecution` + `postToolUseFailure` hooks in `.cursor/hooks.json` |
| Gemini CLI | `.gemini/settings.json` | `AfterTool` hook in `.gemini/settings.json` |

- Shell commands, failed edits and failed tool calls are captured — including the ones that fail
- Existing config in those files is kept; re-running never duplicates entries
- No manual tool calls needed — capture is automatic

---

## How automatic capture works

jinamem ships one hook, `jinamem-hook`, that each agent runs after its tools. It understands every agent's event format — Claude Code's `PostToolUse`/`PostToolUseFailure`, Codex's `PostToolUse` (where a failed command shows up as a non-zero exit code), Cursor's `afterShellExecution`/`postToolUseFailure`, and Gemini CLI's `AfterTool`:

```
Agent runs: Bash("npm test")
              ↓
Claude Code fires: jinamem-hook (stdin: tool name + result or error)
              ↓
jinamem detects: exit code 1 / "3 tests failed" → logs as dead end
              ↓
Next session briefing: "🚫 Bash: npm test: error: Exit code 1 · 3 tests failed"
```

You don't have to tell the agent to log anything. The hook does it.

---

## What fixed it

A failure doesn't stay a "don't retry" forever. When the same command — or the same CI workflow on the same branch — succeeds later, jinamem moves it to **✅ Fixed** and records what made the difference:

```
✅ Fixed
• npm test: "Error: Cannot find module 'express'" — fixed after `npm install express`
• CI: CI on main: "TypeError … src/orders.ts:42" — fixed in c2d3e4f "Fix orders test"
```

- "Same command" ignores the noise agents add: `2>&1 | tail -20`, `cd dir && …`, a different description
- The fix is the last meaningful commands run in between — `ls`, `cat`, `git status` and other looking-around commands are skipped
- For CI it's the commit whose run passed
- Fixes stay in the briefing for 14 days, so the next session knows both the problem and the answer

---

## MCP Tools (also available manually)

| Tool | What it does |
|------|-------------|
| `remember(note, pin?)` | Pin a fact to memory. Pinned facts never expire. |
| `recall(query)` | Search memory for past facts, attempts, dead ends. |
| `what_was_i_doing()` | Full briefing of last session — also auto-loaded at startup. |
| `log_attempt(action, result?, success?)` | Record what you tried. Called automatically by the hook. |

---

## Decision log (auto-summarization)

At the end of each session, jinamem calls a model to distill what happened into durable decision-log entries — the *why* behind your code, not just the *what*.

```
# jinamem briefing — jinai-server

## 📌 Architecture decisions
• switched from JWT to session tokens — JWT expiry was causing mobile logout issues
• postgres pool set to 5 — higher caused timeouts on small VPS  
• decided against websockets — SSE is simpler and covers our use case
```

**Setup:** add one env var to your MCP config — jinamem auto-detects which client to use:

| Env var | Model used | Cost/session |
|---------|-----------|--------------|
| `JINAMEM_ANTHROPIC_KEY` | Claude Haiku | ~$0.001 |
| `JINAMEM_OPENAI_KEY` | GPT-4o-mini | ~$0.001 |
| `OPENAI_API_KEY` | GPT-4o-mini | ~$0.001 |
| Ollama running locally | llama3.2 (or first available) | free |
| (none) | — summarization skipped | free |

Without a key, jinamem still works — agents use `remember()` manually and the hook captures attempts. The decision log just won't be auto-generated.

---

## Build errors, runtime crashes and CI failures

jinamem doesn't only remember what the agent's commands did — it also catches what broke in the build, in the running app and in CI, so the next session starts knowing.

### Build errors — automatic

When the agent runs a build or test command, jinamem keeps **the actual error**, not the first screenful of progress output. A 400-line `next build` becomes:

```
🚫 Bash: npm run build: error: ./src/app/api/orders/route.ts:42:18 Type error: Property 'userId' does not exist on type 'Session'.
```

It picks out error lines and their file:line location (TypeScript, Rust, Python tracebacks, Go, Java…), and drops boilerplate like `npm error code 1` or `make: *** Error 2`.

### Dev servers the agent starts — automatic (Claude Code)

When Claude Code starts a dev server or watcher in the background (`npm run dev`, `uvicorn`, `cargo watch`…), jinamem notes the file its output goes to and the MCP server keeps reading it for the rest of the session. A crash ten minutes later is saved even if the agent never looks:

```
🚫 Runtime: npm run dev: error: ⨯ TypeError: Cannot read properties of undefined (reading 'userId') at GET (src/app/api/orders/route.ts:42:18)
```

The agent's commands are never changed — jinamem only reads the output file the agent itself writes. The same error repeating is saved once.

### Servers you start yourself — `jinamem-run`

Put `jinamem-run` in front of any command. Output passes through unchanged; errors and crashes go to memory:

```bash
jinamem-run npm run dev
jinamem-run python manage.py runserver
jinamem-run --level error -- docker compose up
```

### CI failures — automatic (GitHub Actions)

If the project is on GitHub and you have the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`), jinamem checks for failed workflow runs when a session starts and before each briefing — and pulls the real error out of the failed step's log:

```
🚫 CI: Deploy on main (d3e4f5a): failed: npm error ERESOLVE could not resolve dependency peer react@"^18" from next@15.2 · Bump deps · https://github.com/…/runs/103
```

- No tokens or webhooks to set up — it uses your existing `gh` login
- First use imports only the last 7 days; at most 5 new failures per check
- A run that passes after a failure is recorded as a recovery
- `jinamem-ci` runs the check by hand (or from cron); `JINAMEM_CI=off` turns it off

### Log files and production — `jinamem-watch`

Run `jinamem-watch` alongside your app and it captures errors, crashes, and warnings into memory automatically — even when no agent is active.

Run it from your project directory so captures land in the same project your agent's briefing reads. (Or set the same `JINAMEM_PROJECT` for both the watcher and the MCP server.)

**Tail a log file:**
```bash
jinamem-watch --follow /var/log/myapp.log
```

**Wrap a process** (same as `jinamem-run`):
```bash
jinamem-watch --pipe "npm run dev"
```

**Filter level** (default: `warn`):
```bash
jinamem-watch --follow app.log --level error   # errors only
jinamem-watch --follow app.log --level warn    # errors + warnings
jinamem-watch --follow app.log --level all     # everything
```

**Run as a systemd service** so it captures production logs 24/7:
```ini
[Unit]
Description=jinamem log watcher for myapp
After=network.target

[Service]
ExecStart=jinamem-watch --follow /var/log/myapp.log --level error
Restart=always
Environment=JINAMEM_DB_PATH=/home/user/.jinamem/memory.db
Environment=JINAMEM_PROJECT=/home/user/myapp

[Install]
WantedBy=multi-user.target
```

What jinamem-watch captures gets surfaced in your next briefing:
```
🚫 Don't retry
• [app error] OOM in /api/process-upload (×3)
• [app error] Cannot connect to Redis: ECONNREFUSED
```

---

## Manual setup (Windsurf and other MCP hosts)

Add to your MCP config:

```json
{
  "mcpServers": {
    "jinamem": {
      "command": "npx",
      "args": ["-y", "-p", "@jinamem/mcp", "jinamem-mcp"]
    }
  }
}
```

For hosts that support Claude Code–style hooks, add to `.claude/settings.json` (or equivalent). Register both events — `PostToolUse` only fires for successful calls:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Bash|Edit|MultiEdit|Write",
      "hooks": [{ "type": "command", "command": "jinamem-hook" }]
    }],
    "PostToolUseFailure": [{
      "matcher": "Bash|Edit|MultiEdit|Write",
      "hooks": [{ "type": "command", "command": "jinamem-hook" }]
    }]
  }
}
```

Without hooks, the agent can still call tools manually — add this to your system prompt:

```
At the start of each session, call what_was_i_doing().
When you discover something important, call remember().
When you try something that fails, call log_attempt() with success: false.
```

---

## Self-hosting

Jinamem stores everything locally by default — no account needed.

```bash
# Data lives at ~/.jinamem/memory.db (SQLite)
# Override with:
JINAMEM_DB_PATH=/path/to/memory.db jinamem-mcp
```

**Custom project name** (defaults to the last two parts of the working directory, e.g. `code-myapp`)

```bash
JINAMEM_PROJECT=my-project jinamem-mcp
```

---

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `JINAMEM_DB_PATH` | `~/.jinamem/memory.db` | SQLite database path |
| `JINAMEM_PROJECT` | Working directory (`parent-dir`) | Project namespace — must match across the MCP server, hook and watcher |
| `JINAMEM_USER_ID` | `"local"` | User ID (for multi-user setups) |
| `JINAMEM_TOKEN` | — | Cloud token (jinamem.dev hosted version) |
| `JINAMEM_API_URL` | `https://jinamem.dev` | Cloud API URL (for self-hosted cloud) |
| `JINAMEM_HOME` | `~/.jinamem` | Directory for the local DB, `config.json` and the offline outbox |
| `JINAMEM_HOOK_TIMEOUT_MS` | `3000` | Max time the hook waits on the cloud API before queueing |
| `JINAMEM_CI` | on | Set to `off` to skip GitHub Actions checks |
| `JINAMEM_BG_POLL_MS` | `10000` | How often background command output is checked |

The token and API URL can also be saved with `jinamem-setup --token ... [--api-url ...]`; environment variables take precedence over the saved config.

---

## Architecture

```
packages/
  core/     — Storage interface + SQLite backend
              types.ts, sqlite-store.ts, embedder.ts, similarity.ts, summarizer.ts
  mcp/      — MCP server + CLI tools
              server.ts    — 4 MCP tools + briefing resource + prompt injection
              hook.ts      — Capture hook for every agent (jinamem-hook binary)
              agents.ts    — Parses Claude Code, Codex, Cursor and Gemini CLI hook events
              setup.ts     — One-command setup (jinamem-setup binary)
              watch.ts     — Sidecar log watcher (jinamem-watch binary)
              run.ts       — jinamem-run wrapper
              logscan.ts   — Error-line detection and extraction from long output
              background.ts — Watches output of background commands the agent starts
              ci.ts        — GitHub Actions failures via gh (jinamem-ci binary)
              project.ts   — One project name shared by every process
  api/        — Cloud API server (Postgres + pgvector)
  dashboard/  — Web UI for browsing memory
```

The `JinamemStore` interface in `@jinamem/core` is designed to be implemented for any backend — SQLite for local use, Postgres for the hosted cloud version, or your own store.

---

## Hosted version

Don't want to manage infrastructure? [jinamem.dev](https://jinamem.dev) is the hosted version — same tools, cloud-synced across all your machines, with a dashboard to browse your memory.

$20/month · 14-day free trial · no credit card required

Point jinamem at the cloud with your token:

```bash
jinamem-setup --token am_live_your_token_here
```

This saves the token to `~/.jinamem/config.json` (readable only by you), where the MCP server, the capture hook and `jinamem-watch` all pick it up, so everything they capture goes to the cloud. Run `jinamem-setup --local` to switch back to local SQLite.

If the API is unreachable, the hook queues captures in `~/.jinamem/outbox.jsonl` and sends them on a later run. It never blocks your agent for more than ~3 seconds.

**Other MCP hosts (no hooks):** you can instead pass the token as env on the server:

```json
{
  "mcpServers": {
    "jinamem": {
      "command": "npx",
      "args": ["-y", "-p", "@jinamem/mcp", "jinamem-mcp"],
      "env": { "JINAMEM_TOKEN": "am_live_your_token_here" }
    }
  }
}
```

With no token anywhere, jinamem runs in local SQLite mode with no config change needed.

---

## Self-hosting the cloud version

The API server (`packages/api`) + dashboard (`packages/dashboard`) can be deployed anywhere Docker runs.

```bash
# 1. Clone the repo
git clone https://github.com/jinaico/jinamem
cd jinamem

# 2. Build the dashboard
cd packages/dashboard && npm install && npm run build && cd ../..

# 3. Configure
cp .env.example .env
# Edit .env — set POSTGRES_PASSWORD, JWT_SECRET, PUBLIC_URL

# 4. Start
docker compose -f docker-compose.cloud.yml up -d

# 5. Create your first user
curl -X POST http://localhost:3001/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'
# → returns {"token": "am_live_...", "setupCommand": "npx -y -p @jinamem/mcp jinamem-setup --token am_live_... --api-url ..."}

# 6. Connect a project: run the returned setupCommand in your project directory
```

Set `PUBLIC_URL` in `.env` to the address clients use to reach the API; it goes into the returned `setupCommand`.

pgvector is optional. With it, recall is semantic plus keyword; without it, recall is keyword only, and the migration handles both.

The dashboard is served at `http://localhost:3001` — sign in with your token to browse memory.

**API endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/register` | Create user, returns token + ready-to-paste MCP config |
| `GET`  | `/auth/me` | Current user info |
| `GET`  | `/v1/briefing?project=` | Full session briefing |
| `POST` | `/v1/remember` | Store a fact |
| `POST` | `/v1/recall` | Semantic + keyword search |
| `POST` | `/v1/attempt` | Log an attempt |
| `POST` | `/v1/session/start` | Start a session |
| `POST` | `/v1/session/end` | End a session |
| `GET`  | `/v1/memories?project=` | List all memories |
| `DELETE` | `/v1/memories/:id` | Delete a memory |
| `GET`  | `/v1/projects` | List all projects |
| `GET`  | `/v1/sessions?project=` | Session history |

---

## Roadmap

- [x] SQLite local storage
- [x] 4 core MCP tools
- [x] PostToolUse hook (auto-capture)
- [x] Session summarizer (decision log)
- [x] Sidecar log watcher (jinamem-watch)
- [x] Claude Code, Codex, Cursor and Gemini CLI capture
- [x] Build error extraction, background dev-server watching, GitHub Actions failures
- [x] Link fixes to failures ("fixed after…")
- [ ] Session goal from the first prompt
- [x] Cloud API + Postgres backend
- [x] Dashboard (browse memory, search, sessions)
- [ ] Hosted cloud version (jinamem.dev)
- [ ] Team / org shared memory
- [ ] VS Code extension

---

## Contributing

PRs and issues welcome at [github.com/jinaico/jinamem](https://github.com/jinaico/jinamem/issues).

## License

MIT — free to use, self-host, modify, and build on. No restrictions.
