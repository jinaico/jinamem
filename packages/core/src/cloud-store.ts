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
  private timeoutMs: number;

  constructor(token: string, apiUrl = "https://jinamem.dev", timeoutMs = 15_000) {
    this.token = token;
    this.baseUrl = apiUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  private async fetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...opts,
      signal: AbortSignal.timeout(this.timeoutMs),
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

  // The API serialises store objects as-is: camelCase fields, dates as ISO
  // strings. Revive the date fields so callers get real Date objects.
  private static revive<T>(raw: Record<string, unknown>): T {
    const out: Record<string, unknown> = { ...raw };
    for (const k of ["createdAt", "expiresAt", "startedAt", "endedAt"]) {
      const v = out[k];
      if (typeof v === "string") out[k] = new Date(v);
      else if (v === null) out[k] = undefined;
    }
    return out as T;
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.fetch<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  async remember(userId: string, project: string, note: string, pin = false): Promise<Memory> {
    return CloudStore.revive<Memory>(await this.post("/v1/remember", { note, pin, project }));
  }

  async recall(userId: string, project: string, query: string, limit = 10): Promise<RecallResult[]> {
    const raw = await this.post<Record<string, unknown>[]>("/v1/recall", { query, limit, project });
    return raw.map(r => CloudStore.revive<RecallResult>(r));
  }

  async logAttempt(userId: string, project: string, sessionId: string, action: string, result?: string, success = true): Promise<Attempt> {
    return CloudStore.revive<Attempt>(await this.post("/v1/attempt", { sessionId, action, result, success, project }));
  }

  async startSession(userId: string, project: string, task?: string): Promise<Session> {
    return CloudStore.revive<Session>(await this.post("/v1/session/start", { project, task }));
  }

  async endSession(sessionId: string, summary?: string): Promise<Session> {
    return CloudStore.revive<Session>(await this.post("/v1/session/end", { sessionId, summary }));
  }

  async getLastSession(userId: string, project: string): Promise<Session | null> {
    try {
      const raw = await this.fetch<Record<string, unknown> | null>(
        `/v1/session/last?project=${encodeURIComponent(project)}`,
      );
      return raw ? CloudStore.revive<Session>(raw) : null;
    } catch {
      return null;
    }
  }

  async getBriefing(userId: string, project: string): Promise<Briefing> {
    const raw = await this.fetch<Briefing & { lastSession?: Record<string, unknown> }>(
      `/v1/briefing?project=${encodeURIComponent(project)}`,
    );
    return {
      ...raw,
      lastSession: raw.lastSession
        ? CloudStore.revive<NonNullable<Briefing["lastSession"]>>(raw.lastSession)
        : undefined,
    };
  }

  async getSessionAttempts(sessionId: string): Promise<Attempt[]> {
    const raw = await this.fetch<Record<string, unknown>[]>(
      `/v1/session/${encodeURIComponent(sessionId)}/attempts`,
    );
    return raw.map(r => CloudStore.revive<Attempt>(r));
  }

  async getProjectAttempts(userId: string, project: string, since: Date, limit = 500): Promise<Attempt[]> {
    const q = new URLSearchParams({ project, since: since.toISOString(), limit: String(limit) });
    const raw = await this.fetch<Record<string, unknown>[]>(`/v1/attempts?${q}`);
    return raw.map(r => CloudStore.revive<Attempt>(r));
  }

  async getPinnedFacts(userId: string, project: string): Promise<string[]> {
    const briefing = await this.getBriefing(userId, project);
    return briefing.pinnedFacts;
  }

  async close(): Promise<void> {
    // HTTP client — nothing to close
  }
}
