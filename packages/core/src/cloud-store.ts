/**
 * CloudStore — JinamemStore over HTTP.
 * Automatically used by the MCP server when JINAMEM_TOKEN is set.
 * Falls back to SqliteStore for local use.
 */

import type {
  JinamemStore, Memory, Attempt, Session,
  Briefing, RecallResult,
} from "./types.js";

export class CloudStore implements JinamemStore {
  private baseUrl: string;
  private token: string;

  constructor(token: string, apiUrl = "https://jinamem.dev") {
    this.token = token;
    this.baseUrl = apiUrl.replace(/\/$/, "");
  }

  private async fetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(opts.headers ?? {}),
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`jinamem API ${res.status}: ${text}`);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  async remember(userId: string, project: string, note: string, pin = false): Promise<Memory> {
    const raw = await this.fetch<{ id: string; kind: string; content: string; created_at: string; expires_at: string | null }>("/v1/remember", {
      method: "POST",
      body: JSON.stringify({ note, pin, project }),
    });
    return {
      id: raw.id,
      userId,
      project,
      kind: raw.kind as Memory["kind"],
      content: raw.content,
      metadata: {},
      createdAt: new Date(raw.created_at),
      expiresAt: raw.expires_at ? new Date(raw.expires_at) : undefined,
    };
  }

  async recall(userId: string, project: string, query: string, limit = 10): Promise<RecallResult[]> {
    const raw = await this.fetch<Array<{ content: string; kind: string; project: string; created_at: string; score: number }>>("/v1/recall", {
      method: "POST",
      body: JSON.stringify({ query, limit, project }),
    });
    return raw.map(r => ({
      content: r.content,
      kind: r.kind as RecallResult["kind"],
      project: r.project,
      createdAt: new Date(r.created_at),
      score: r.score,
    }));
  }

  async logAttempt(userId: string, project: string, sessionId: string, action: string, result?: string, success = true): Promise<Attempt> {
    const raw = await this.fetch<{ id: string; created_at: string }>("/v1/attempt", {
      method: "POST",
      body: JSON.stringify({ sessionId, action, result, success, project }),
    });
    return { id: raw.id, userId, project, sessionId, action, result, success, createdAt: new Date(raw.created_at) };
  }

  async startSession(userId: string, project: string, task?: string): Promise<Session> {
    const raw = await this.fetch<{ id: string; started_at: string }>("/v1/session/start", {
      method: "POST",
      body: JSON.stringify({ project, task }),
    });
    return { id: raw.id, userId, project, task, startedAt: new Date(raw.started_at) };
  }

  async endSession(sessionId: string, summary?: string): Promise<Session> {
    const raw = await this.fetch<{ id: string; user_id: string; project: string; task: string | null; summary: string | null; started_at: string; ended_at: string | null }>("/v1/session/end", {
      method: "POST",
      body: JSON.stringify({ sessionId, summary }),
    });
    return {
      id: raw.id,
      userId: raw.user_id,
      project: raw.project,
      task: raw.task ?? undefined,
      summary: raw.summary ?? undefined,
      startedAt: new Date(raw.started_at),
      endedAt: raw.ended_at ? new Date(raw.ended_at) : undefined,
    };
  }

  async getLastSession(userId: string, project: string): Promise<Session | null> {
    try {
      const raw = await this.fetch<{ id: string; user_id: string; project: string; task: string | null; summary: string | null; started_at: string; ended_at: string | null } | null>(
        `/v1/session/last?project=${encodeURIComponent(project)}`,
      );
      if (!raw) return null;
      return {
        id: raw.id, userId: raw.user_id, project: raw.project,
        task: raw.task ?? undefined, summary: raw.summary ?? undefined,
        startedAt: new Date(raw.started_at),
        endedAt: raw.ended_at ? new Date(raw.ended_at) : undefined,
      };
    } catch {
      return null;
    }
  }

  async getBriefing(userId: string, project: string): Promise<Briefing> {
    return this.fetch<Briefing>(`/v1/briefing?project=${encodeURIComponent(project)}`);
  }

  async getSessionAttempts(sessionId: string): Promise<Attempt[]> {
    const raw = await this.fetch<Array<{ id: string; user_id: string; project: string; session_id: string; action: string; result: string | null; success: boolean; created_at: string }>>(
      `/v1/session/${encodeURIComponent(sessionId)}/attempts`,
    );
    return raw.map(r => ({
      id: r.id, userId: r.user_id, project: r.project, sessionId: r.session_id,
      action: r.action, result: r.result ?? undefined, success: r.success, createdAt: new Date(r.created_at),
    }));
  }

  async getPinnedFacts(userId: string, project: string): Promise<string[]> {
    const briefing = await this.getBriefing(userId, project);
    return briefing.pinnedFacts;
  }

  async close(): Promise<void> {
    // HTTP client — nothing to close
  }
}
