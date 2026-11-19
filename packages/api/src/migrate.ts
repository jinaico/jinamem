/**
 * jinamem Postgres migration
 * Run once: node dist/migrate.js
 * Or: DATABASE_URL=... npm run migrate
 */

import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

await sql`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT UNIQUE,
    token       TEXT UNIQUE NOT NULL,
    plan        TEXT NOT NULL DEFAULT 'free',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

await sql`
  CREATE TABLE IF NOT EXISTS memories (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project     TEXT NOT NULL,
    kind        TEXT NOT NULL,
    content     TEXT NOT NULL,
    metadata    JSONB NOT NULL DEFAULT '{}',
    pinned      BOOLEAN NOT NULL DEFAULT FALSE,
    embedding   vector(384),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ
  )
`;

await sql`
  CREATE TABLE IF NOT EXISTS attempts (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project     TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    action      TEXT NOT NULL,
    result      TEXT,
    success     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

await sql`
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project     TEXT NOT NULL,
    task        TEXT,
    summary     TEXT,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at    TIMESTAMPTZ
  )
`;

// Indexes
await sql`CREATE INDEX IF NOT EXISTS idx_memories_project ON memories (user_id, project, kind)`;
await sql`CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories (user_id, project) WHERE pinned = TRUE`;
await sql`CREATE INDEX IF NOT EXISTS idx_attempts_session ON attempts (session_id)`;
await sql`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (user_id, project, started_at DESC)`;

// Try to create pgvector extension (requires superuser on some hosts)
try {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await sql`CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`;
  console.log("pgvector extension and index created.");
} catch {
  console.warn("pgvector not available — semantic search will fall back to keyword only.");
}

console.log("Migration complete.");
await sql.end();
