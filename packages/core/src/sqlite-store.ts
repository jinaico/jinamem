import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { resolve } from "path";
import { homedir } from "os";
import type {
  JinamemStore, Memory, Attempt, Session,
  Briefing, RecallResult, MemoryKind,
} from "./types.js";
import {
  getEmbedder, embedBatch,
  serializeEmbedding, deserializeEmbedding,
} from "./embedder.js";
import {
  cosineSimilarity, reciprocalRankFusion, SIMILARITY_THRESHOLD,
} from "./similarity.js";

// ─── SQLite Store (self-hosted / local) ──────────────────────────────────────

export class SqliteStore implements JinamemStore {
  private db: Database.Database;
  private retroactiveIndexDone = false;

  constructor(dbPath?: string) {
    const path = dbPath ?? resolve(homedir(), ".jinamem", "memory.db");
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    // Trigger retroactive embedding in background after store is ready
    this.retroactiveIndex().catch(() => {});
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        project    TEXT NOT NULL,
        kind       TEXT NOT NULL,
        content    TEXT NOT NULL,
        metadata   TEXT NOT NULL DEFAULT '{}',
        pinned     INTEGER NOT NULL DEFAULT 0,
        embedding  BLOB,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS attempts (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        project     TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        action      TEXT NOT NULL,
        result      TEXT,
        success     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        project     TEXT NOT NULL,
        task        TEXT,
        summary     TEXT,
        started_at  TEXT NOT NULL,
        ended_at    TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(user_id, project, kind);
      CREATE INDEX IF NOT EXISTS idx_attempts_session ON attempts(session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(user_id, project, started_at DESC);
    `);
  }

  // Retroactively embed any facts that were stored before an embedder was available
  private async retroactiveIndex() {
    if (this.retroactiveIndexDone) return;
    this.retroactiveIndexDone = true;

    const embedder = await getEmbedder();
    if (!embedder) return;

    const rows = this.db.prepare(`
      SELECT id, content FROM memories WHERE embedding IS NULL
    `).all() as Array<{ id: string; content: string }>;

    if (rows.length === 0) return;

    console.error(`[jinamem] retroactively embedding ${rows.length} stored facts...`);
    const vectors = await embedBatch(rows.map(r => r.content), embedder);

    const update = this.db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`);
    rows.forEach((row, i) => {
      const vec = vectors[i];
      if (vec) update.run(serializeEmbedding(vec), row.id);
    });

    console.error(`[jinamem] retroactive embedding complete`);
  }

  async remember(userId: string, project: string, note: string, pin = false): Promise<Memory> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = pin ? null : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    // Generate embedding if available
    let embedding: Buffer | null = null;
    const embedder = await getEmbedder();
    if (embedder) {
      try {
        const vec = await embedder.embed(note);
        embedding = serializeEmbedding(vec);
      } catch {
        // Embedding failed — store without it, recall degrades to keyword
      }
    }

    this.db.prepare(`
      INSERT INTO memories (id, user_id, project, kind, content, pinned, embedding, created_at, expires_at)
      VALUES (?, ?, ?, 'fact', ?, ?, ?, ?, ?)
    `).run(id, userId, project, note, pin ? 1 : 0, embedding, now, expiresAt);

    return {
      id, userId, project, kind: "fact",
      content: note, metadata: {},
      createdAt: new Date(now),
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    };
  }

  async recall(userId: string, project: string, query: string, limit = 10): Promise<RecallResult[]> {
    // Always run keyword search — fast, works offline
    const keywordResults = this.keywordSearch(userId, project, query, limit * 3);

    // Try semantic search if embedder available
    const embedder = await getEmbedder();
    const toRecallResult = (r: { content: string; score: number }): RecallResult => ({
      content: r.content,
      kind: "fact" as MemoryKind,
      project,
      createdAt: new Date(),
      score: r.score,
    });

    if (!embedder) {
      // No embedder — return keyword results only
      return keywordResults.slice(0, limit).map(toRecallResult);
    }

    let queryVec: number[];
    try {
      queryVec = await embedder.embed(query);
    } catch {
      // Embedding failed — fall back to keyword
      return keywordResults.slice(0, limit).map(toRecallResult);
    }

    const semanticResults = this.vectorSearch(userId, project, queryVec, limit * 3);

    // Merge with Reciprocal Rank Fusion
    const merged = reciprocalRankFusion(semanticResults, keywordResults);

    return merged.slice(0, limit).map(r => ({
      content: r.content,
      kind: "fact" as MemoryKind,
      project,
      createdAt: new Date(), // RRF result doesn't carry date — acceptable for ranking
      score: r.score,
    }));
  }

  private keywordSearch(
    userId: string, project: string, query: string, limit: number,
  ): Array<{ id: string; content: string; score: number }> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    const rows = this.db.prepare(`
      SELECT id, content
      FROM memories
      WHERE user_id = ? AND project = ?
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY pinned DESC, created_at DESC
      LIMIT 200
    `).all(userId, project) as Array<{ id: string; content: string }>;

    return rows
      .map(row => {
        const text = row.content.toLowerCase();
        const hits = terms.filter(t => text.includes(t)).length;
        return { id: row.id, content: row.content, score: hits / Math.max(terms.length, 1) };
      })
      .filter(r => r.score > 0 || terms.length === 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private vectorSearch(
    userId: string, project: string, queryVec: number[], limit: number,
  ): Array<{ id: string; content: string; score: number }> {
    // Load all embeddings for this project and compute cosine similarity in JS
    // This is fast enough for hundreds of facts; at thousands, switch to sqlite-vec
    const rows = this.db.prepare(`
      SELECT id, content, embedding
      FROM memories
      WHERE user_id = ? AND project = ?
        AND embedding IS NOT NULL
        AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).all(userId, project) as Array<{ id: string; content: string; embedding: Buffer }>;

    return rows
      .map(row => {
        const vec = deserializeEmbedding(row.embedding);
        const score = cosineSimilarity(queryVec, vec);
        return { id: row.id, content: row.content, score };
      })
      .filter(r => r.score >= SIMILARITY_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async logAttempt(
    userId: string, project: string, sessionId: string,
    action: string, result?: string, success = true,
  ): Promise<Attempt> {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO attempts (id, user_id, project, session_id, action, result, success, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, project, sessionId, action, result ?? null, success ? 1 : 0, now);

    // Auto-store failed attempts as dead ends
    if (!success) {
      await this.remember(
        userId, project,
        `[dead end] ${action}${result ? `: ${result}` : ""}`,
        false,
      );
    }

    return { id, userId, project, sessionId, action, result, success, createdAt: new Date(now) };
  }

  async startSession(userId: string, project: string, task?: string): Promise<Session> {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO sessions (id, user_id, project, task, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, userId, project, task ?? null, now);

    return { id, userId, project, task, startedAt: new Date(now) };
  }

  async endSession(sessionId: string, summary?: string): Promise<Session> {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE sessions SET ended_at = ?, summary = ? WHERE id = ?`)
      .run(now, summary ?? null, sessionId);

    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as {
      id: string; user_id: string; project: string; task: string | null;
      summary: string | null; started_at: string; ended_at: string | null;
    };

    return {
      id: row.id, userId: row.user_id, project: row.project,
      task: row.task ?? undefined, summary: row.summary ?? undefined,
      startedAt: new Date(row.started_at),
      endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
    };
  }

  async getLastSession(userId: string, project: string): Promise<Session | null> {
    const row = this.db.prepare(`
      SELECT * FROM sessions
      WHERE user_id = ? AND project = ?
      ORDER BY started_at DESC LIMIT 1
    `).get(userId, project) as {
      id: string; user_id: string; project: string; task: string | null;
      summary: string | null; started_at: string; ended_at: string | null;
    } | undefined;

    if (!row) return null;
    return {
      id: row.id, userId: row.user_id, project: row.project,
      task: row.task ?? undefined, summary: row.summary ?? undefined,
      startedAt: new Date(row.started_at),
      endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
    };
  }

  async getBriefing(userId: string, project: string): Promise<Briefing> {
    const lastSession = await this.getLastSession(userId, project);

    const pinnedRows = this.db.prepare(`
      SELECT content FROM memories
      WHERE user_id = ? AND project = ? AND pinned = 1
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY created_at DESC LIMIT 20
    `).all(userId, project) as Array<{ content: string }>;

    const deadEndRows = this.db.prepare(`
      SELECT content FROM memories
      WHERE user_id = ? AND project = ? AND kind = 'fact'
        AND content LIKE '[dead end]%'
        AND created_at > datetime('now', '-30 days')
      ORDER BY created_at DESC LIMIT 10
    `).all(userId, project) as Array<{ content: string }>;

    const taskRows = this.db.prepare(`
      SELECT content FROM memories
      WHERE user_id = ? AND project = ? AND kind = 'task'
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY created_at DESC LIMIT 10
    `).all(userId, project) as Array<{ content: string }>;

    const pinnedFacts = pinnedRows.map(r => r.content);
    const deadEnds = deadEndRows.map(r => r.content.replace("[dead end] ", ""));
    const openTasks = taskRows.map(r => r.content);

    const totalChars = [...pinnedFacts, ...deadEnds, ...openTasks].join(" ").length;
    const tokenEstimate = Math.round(totalChars / 4);

    return {
      lastSession: lastSession ? {
        task: lastSession.task,
        endedAt: lastSession.endedAt ?? lastSession.startedAt,
        status: lastSession.endedAt ? "completed" : "in_progress",
      } : undefined,
      pinnedFacts,
      deadEnds,
      openTasks,
      tokenEstimate,
    };
  }

  async getProjectAttempts(userId: string, project: string, since: Date, limit = 500): Promise<Attempt[]> {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM attempts
        WHERE user_id = ? AND project = ? AND created_at >= ?
        ORDER BY created_at DESC LIMIT ?
      ) ORDER BY created_at ASC
    `).all(userId, project, since.toISOString(), limit) as Array<{
      id: string; user_id: string; project: string; session_id: string;
      action: string; result: string | null; success: number; created_at: string;
    }>;
    return rows.map(r => ({
      id: r.id, userId: r.user_id, project: r.project, sessionId: r.session_id,
      action: r.action, result: r.result ?? undefined, success: r.success === 1,
      createdAt: new Date(r.created_at),
    }));
  }

  async getSessionAttempts(sessionId: string): Promise<Attempt[]> {
    const rows = this.db.prepare(`
      SELECT * FROM attempts WHERE session_id = ? ORDER BY created_at ASC
    `).all(sessionId) as Array<{
      id: string; user_id: string; project: string; session_id: string;
      action: string; result: string | null; success: number; created_at: string;
    }>;

    return rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      project: r.project,
      sessionId: r.session_id,
      action: r.action,
      result: r.result ?? undefined,
      success: r.success === 1,
      createdAt: new Date(r.created_at),
    }));
  }

  async getPinnedFacts(userId: string, project: string): Promise<string[]> {
    const rows = this.db.prepare(`
      SELECT content FROM memories
      WHERE user_id = ? AND project = ? AND pinned = 1
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY created_at DESC LIMIT 30
    `).all(userId, project) as Array<{ content: string }>;

    return rows.map(r => r.content);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
