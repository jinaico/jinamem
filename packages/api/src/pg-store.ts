/**
 * PgStore — JinamemStore backed by Postgres.
 * Used by the API server directly (server-side).
 */

import postgres from "postgres";
import { randomUUID } from "crypto";
import type {
  JinamemStore, Memory, Attempt, Session,
  Briefing, RecallResult, MemoryKind,
} from "@jinamem/core";
import {
  getEmbedder, fixKey, legacyAction, describeFix, formatFixed, FIXED_VISIBLE_DAYS, type DeadEndMeta,
} from "@jinamem/core";

// Whether memories.embedding exists (only created when pgvector is installed).
// Checked once per process; without it, recall is keyword-only.
let hasVectorColumn: Promise<boolean> | null = null;

export class PgStore implements JinamemStore {
  constructor(private sql: postgres.Sql) {}

  private vectorsEnabled(): Promise<boolean> {
    if (!hasVectorColumn) {
      hasVectorColumn = this.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'memories' AND column_name = 'embedding'
      `.then(r => r[0]!.n > 0).catch(() => false);
    }
    return hasVectorColumn;
  }

  async remember(userId: string, project: string, note: string, pin = false): Promise<Memory> {
    const id = randomUUID();
    const expiresAt = pin ? null : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

    // Try to embed
    let embeddingStr: string | null = null;
    const vectors = await this.vectorsEnabled();
    try {
      const embedder = vectors ? await getEmbedder() : null;
      if (embedder) {
        const vec = await embedder.embed(note);
        embeddingStr = `[${vec.join(",")}]`;
      }
    } catch { /* non-fatal */ }

    const rows = vectors
      ? await this.sql<{ id: string; created_at: Date; expires_at: Date | null }[]>`
          INSERT INTO memories (id, user_id, project, kind, content, pinned, embedding, created_at, expires_at)
          VALUES (
            ${id}, ${userId}, ${project}, 'fact', ${note}, ${pin},
            ${embeddingStr ? this.sql`${embeddingStr}::vector` : this.sql`NULL`},
            NOW(), ${expiresAt}
          )
          RETURNING id, created_at, expires_at
        `
      : await this.sql<{ id: string; created_at: Date; expires_at: Date | null }[]>`
          INSERT INTO memories (id, user_id, project, kind, content, pinned, created_at, expires_at)
          VALUES (${id}, ${userId}, ${project}, 'fact', ${note}, ${pin}, NOW(), ${expiresAt})
          RETURNING id, created_at, expires_at
        `;

    const row = rows[0]!;
    return {
      id: row.id,
      userId,
      project,
      kind: "fact",
      content: note,
      metadata: {},
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
    };
  }

  async recall(userId: string, project: string, query: string, limit = 10): Promise<RecallResult[]> {
    // Always run keyword search
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const keywordRows = await this.sql<{ content: string; created_at: Date }[]>`
      SELECT content, created_at FROM memories
      WHERE user_id = ${userId} AND project = ${project}
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY pinned DESC, created_at DESC
      LIMIT 200
    `;

    const keywordScored = keywordRows
      .map(r => {
        const text = r.content.toLowerCase();
        const hits = terms.filter(t => text.includes(t)).length;
        return { content: r.content, createdAt: r.created_at, score: hits / Math.max(terms.length, 1) };
      })
      .filter(r => r.score > 0 || terms.length === 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Try semantic search
    try {
      const embedder = (await this.vectorsEnabled()) ? await getEmbedder() : null;
      if (embedder) {
        const vec = await embedder.embed(query);
        const vecStr = `[${vec.join(",")}]`;

        const semanticRows = await this.sql<{ content: string; created_at: Date; score: number }[]>`
          SELECT content, created_at,
                 1 - (embedding <=> ${vecStr}::vector) AS score
          FROM memories
          WHERE user_id = ${userId} AND project = ${project}
            AND embedding IS NOT NULL
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT ${limit * 3}
        `;

        // Simple RRF merge
        const keywordRanks = new Map(keywordScored.map((r, i) => [r.content, i]));
        const semanticRanks = new Map(semanticRows.map((r, i) => [r.content, i]));
        const all = new Set([...keywordRanks.keys(), ...semanticRanks.keys()]);

        const merged = Array.from(all).map(content => {
          const kr = keywordRanks.has(content) ? 1 / (60 + keywordRanks.get(content)!) : 0;
          const sr = semanticRanks.has(content) ? 1 / (60 + semanticRanks.get(content)!) : 0;
          const kw = keywordScored.find(r => r.content === content);
          const createdAt = kw ? kw.createdAt : semanticRows.find(r => r.content === content)!.created_at;
          return { content, createdAt, score: kr + sr };
        }).sort((a, b) => b.score - a.score).slice(0, limit);

        return merged.map(r => ({
          content: r.content,
          kind: "fact" as MemoryKind,
          project,
          createdAt: r.createdAt,
          score: r.score,
        }));
      }
    } catch { /* fall through to keyword */ }

    return keywordScored.slice(0, limit).map(r => ({
      content: r.content,
      kind: "fact" as MemoryKind,
      project,
      createdAt: r.createdAt,
      score: r.score,
    }));
  }

  async logAttempt(userId: string, project: string, sessionId: string, action: string, result?: string, success = true): Promise<Attempt> {
    const id = randomUUID();
    const [{ created_at: now }] = await this.sql<{ created_at: Date }[]>`
      INSERT INTO attempts (id, user_id, project, session_id, action, result, success)
      VALUES (${id}, ${userId}, ${project}, ${sessionId}, ${action}, ${result ?? null}, ${success})
      RETURNING created_at
    `;
    if (!success) {
      // Dead end, keyed so a later success can resolve it
      const mem = await this.remember(userId, project, `[dead end] ${action}${result ? `: ${result}` : ""}`, false);
      const meta: DeadEndMeta = { deadEnd: true, key: fixKey(action), action };
      await this.sql`UPDATE memories SET metadata = ${this.sql.json(meta as never)} WHERE id = ${mem.id}`;
    } else {
      await this.resolveDeadEnds(userId, project, action, result, now);
    }
    return { id, userId, project, sessionId, action, result, success, createdAt: now };
  }

  /** A success resolves earlier dead ends for the same command or workflow. */
  private async resolveDeadEnds(userId: string, project: string, action: string, result: string | undefined, now: Date) {
    const key = fixKey(action);
    if (!key) return;
    const rows = await this.sql<{ id: string; content: string; metadata: DeadEndMeta | null; created_at: Date }[]>`
      SELECT id, content, metadata, created_at FROM memories
      WHERE user_id = ${userId} AND project = ${project}
        AND content LIKE '[dead end]%'
        AND (metadata->'resolved') IS NULL
        AND created_at > NOW() - INTERVAL '30 days'
    `;
    for (const row of rows) {
      const meta: DeadEndMeta = row.metadata ?? {};
      if ((meta.key ?? fixKey(legacyAction(row.content))) !== key) continue;
      const between = (await this.sql<{ action: string }[]>`
        SELECT action FROM attempts
        WHERE user_id = ${userId} AND project = ${project} AND success = TRUE
          AND created_at > ${row.created_at} AND created_at < ${now}
        ORDER BY created_at ASC
      `).map(r => r.action);
      meta.resolved = { at: now.toISOString(), fix: describeFix(key, action, result, between), via: action };
      await this.sql`UPDATE memories SET metadata = ${this.sql.json(meta as never)} WHERE id = ${row.id}`;
    }
  }

  async startSession(userId: string, project: string, task?: string): Promise<Session> {
    const id = randomUUID();
    await this.sql`
      INSERT INTO sessions (id, user_id, project, task)
      VALUES (${id}, ${userId}, ${project}, ${task ?? null})
    `;
    return { id, userId, project, task, startedAt: new Date() };
  }

  async endSession(sessionId: string, summary?: string): Promise<Session> {
    const rows = await this.sql<{ id: string; user_id: string; project: string; task: string | null; summary: string | null; started_at: Date; ended_at: Date | null }[]>`
      UPDATE sessions SET ended_at = NOW(), summary = ${summary ?? null}
      WHERE id = ${sessionId}
      RETURNING *
    `;
    const r = rows[0]!;
    return {
      id: r.id, userId: r.user_id, project: r.project,
      task: r.task ?? undefined, summary: r.summary ?? undefined,
      startedAt: r.started_at, endedAt: r.ended_at ?? undefined,
    };
  }

  async getLastSession(userId: string, project: string): Promise<Session | null> {
    const rows = await this.sql<{ id: string; user_id: string; project: string; task: string | null; summary: string | null; started_at: Date; ended_at: Date | null }[]>`
      SELECT * FROM sessions
      WHERE user_id = ${userId} AND project = ${project}
      ORDER BY started_at DESC LIMIT 1
    `;
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: r.id, userId: r.user_id, project: r.project,
      task: r.task ?? undefined, summary: r.summary ?? undefined,
      startedAt: r.started_at, endedAt: r.ended_at ?? undefined,
    };
  }

  async getBriefing(userId: string, project: string): Promise<Briefing> {
    const lastSession = await this.getLastSession(userId, project);

    const pinnedRows = await this.sql<{ content: string }[]>`
      SELECT content FROM memories
      WHERE user_id = ${userId} AND project = ${project} AND pinned = TRUE
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC LIMIT 20
    `;

    const deadEndRows = await this.sql<{ content: string }[]>`
      SELECT content FROM memories
      WHERE user_id = ${userId} AND project = ${project}
        AND content LIKE '[dead end]%'
        AND (metadata->'resolved') IS NULL
        AND created_at > NOW() - INTERVAL '30 days'
      ORDER BY created_at DESC LIMIT 10
    `;

    const fixedRows = await this.sql<{ content: string; metadata: DeadEndMeta }[]>`
      SELECT content, metadata FROM memories
      WHERE user_id = ${userId} AND project = ${project}
        AND content LIKE '[dead end]%'
        AND (metadata->'resolved'->>'at')::timestamptz > NOW() - make_interval(days => ${FIXED_VISIBLE_DAYS})
      ORDER BY (metadata->'resolved'->>'at') DESC LIMIT 5
    `;

    const taskRows = await this.sql<{ content: string }[]>`
      SELECT content FROM memories
      WHERE user_id = ${userId} AND project = ${project} AND kind = 'task'
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC LIMIT 10
    `;

    const pinnedFacts = pinnedRows.map(r => r.content);
    const deadEnds = deadEndRows.map(r => r.content.replace("[dead end] ", ""));
    const fixed = fixedRows.map(r => formatFixed(r.content, r.metadata.resolved!.fix));
    const openTasks = taskRows.map(r => r.content);
    const totalChars = [...pinnedFacts, ...deadEnds, ...fixed, ...openTasks].join(" ").length;

    return {
      lastSession: lastSession ? {
        task: lastSession.task,
        endedAt: lastSession.endedAt ?? lastSession.startedAt,
        status: lastSession.endedAt ? "completed" : "in_progress",
      } : undefined,
      pinnedFacts,
      deadEnds,
      fixed,
      openTasks,
      tokenEstimate: Math.round(totalChars / 4),
    };
  }

  async getProjectAttempts(userId: string, project: string, since: Date, limit = 500): Promise<Attempt[]> {
    const rows = await this.sql<{ id: string; user_id: string; project: string; session_id: string; action: string; result: string | null; success: boolean; created_at: Date }[]>`
      SELECT * FROM (
        SELECT * FROM attempts
        WHERE user_id = ${userId} AND project = ${project} AND created_at >= ${since}
        ORDER BY created_at DESC LIMIT ${limit}
      ) recent ORDER BY created_at ASC
    `;
    return rows.map(r => ({
      id: r.id, userId: r.user_id, project: r.project, sessionId: r.session_id,
      action: r.action, result: r.result ?? undefined, success: r.success, createdAt: r.created_at,
    }));
  }

  async getSessionAttempts(sessionId: string): Promise<Attempt[]> {
    const rows = await this.sql<{ id: string; user_id: string; project: string; session_id: string; action: string; result: string | null; success: boolean; created_at: Date }[]>`
      SELECT * FROM attempts WHERE session_id = ${sessionId} ORDER BY created_at ASC
    `;
    return rows.map(r => ({
      id: r.id, userId: r.user_id, project: r.project, sessionId: r.session_id,
      action: r.action, result: r.result ?? undefined, success: r.success, createdAt: r.created_at,
    }));
  }

  async getPinnedFacts(userId: string, project: string): Promise<string[]> {
    const rows = await this.sql<{ content: string }[]>`
      SELECT content FROM memories
      WHERE user_id = ${userId} AND project = ${project} AND pinned = TRUE
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC LIMIT 30
    `;
    return rows.map(r => r.content);
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
