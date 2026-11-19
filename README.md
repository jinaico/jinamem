# jinamem

**Persistent memory for AI agents. Open source.**

Your AI agent forgets everything between sessions. Jinamem fixes that — it's an MCP server that captures what your agent tried, what failed, and what it discovered, then gives it an instant briefing next time it starts.

```
> what_was_i_doing()

Last session: "fix auth middleware" — completed (8h ago)

📌 Remember
• JWT tokens missing exp field on legacy API
• Token factory now adds default exp — don't revert this

🚫 Don't retry  
• Patching verifyToken directly (causes TypeError)

🔧 Open tasks
• Write regression test for exp field validation

Context loaded in ~340 tokens (vs ~3,200 manual recap)
```

---

## Why

Every agent session starts cold. The agent re-reads the codebase, re-discovers what's broken, re-runs the same exploratory commands it ran yesterday. We call it **AI Groundhog Day** — and it costs you tokens, time, and accuracy.

Jinamem gives your agent a memory layer that persists across sessions, so it picks up exactly where it stopped.

---

## Quickstart — Claude Code (30 seconds)

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

That's it. Restart Claude Code and jinamem starts capturing your session automatically.

What `jinamem-setup` does:
- Adds the MCP server to `.mcp.json` and approves it in `.claude/settings.json`
- Adds `PostToolUse` and `PostToolUseFailure` hooks so every Bash/Edit/Write call — including the ones that fail — is logged automatically
- Safe to re-run; it never duplicates entries
- No manual tool calls needed — capture is automatic

---

## How automatic capture works

jinamem ships a hook that Claude Code fires after every tool call — `PostToolUse` when it succeeds, `PostToolUseFailure` when it fails:

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

## Watching app logs (jinamem-watch)

Run `jinamem-watch` alongside your app and it captures errors, crashes, and warnings into memory automatically — even when no agent is active. Next time you open Claude Code, your briefing already knows what broke.

Run it from your project directory so captures land in the same project your agent's briefing reads. (Or set the same `JINAMEM_PROJECT` for both the watcher and the MCP server.)

**Tail a log file:**
```bash
jinamem-watch --follow /var/log/myapp.log
```

**Wrap a process (output passes through, errors are captured):**
```bash
jinamem-watch --pipe "npm run dev"
jinamem-watch --pipe "node server.js"
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

## Manual setup (Cursor, Windsurf, other MCP hosts)

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

---

## Architecture

```
packages/
  core/     — Storage interface + SQLite backend
              types.ts, sqlite-store.ts, embedder.ts, similarity.ts, summarizer.ts
  mcp/      — MCP server + CLI tools
              server.ts    — 4 MCP tools + briefing resource + prompt injection
              hook.ts      — PostToolUse/PostToolUseFailure hook (jinamem-hook binary)
              setup.ts     — One-command setup (jinamem-setup binary)
              watch.ts     — Sidecar log watcher (jinamem-watch binary)
  api/        — Cloud API server (Postgres + pgvector)
  dashboard/  — Web UI for browsing memory
```

The `JinamemStore` interface in `@jinamem/core` is designed to be implemented for any backend — SQLite for local use, Postgres for the hosted cloud version, or your own store.

---

## Hosted version

Don't want to manage infrastructure? [jinamem.dev](https://jinamem.dev) is the hosted version — same tools, cloud-synced across all your machines, with a dashboard to browse your memory.

$20/month · 14-day free trial · no credit card required

Add your token to the config:

```json
{
  "mcpServers": {
    "jinamem": {
      "command": "npx",
      "args": ["-y", "-p", "@jinamem/mcp", "jinamem-mcp"],
      "env": {
        "JINAMEM_TOKEN": "am_live_your_token_here",
        "JINAMEM_API_URL": "https://jinamem.dev"
      }
    }
  }
}
```

The MCP server auto-detects the token at startup and switches to cloud mode. Local SQLite mode is used when no token is set — no config change needed.

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
# → returns {"token": "am_live_..."}
```

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
