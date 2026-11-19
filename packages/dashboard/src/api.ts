/**
 * API client for the jinamem dashboard.
 * Token stored in localStorage; API_BASE auto-detected.
 */

export const API_BASE = import.meta.env.VITE_API_URL ?? "";

function getToken(): string | null {
  try { return localStorage.getItem("jinamem_token"); } catch { return null; }
}

export function setToken(t: string) {
  try { localStorage.setItem("jinamem_token", t); } catch {}
}

export function clearToken() {
  try { localStorage.removeItem("jinamem_token"); } catch {}
}

export function isLoggedIn() {
  return !!getToken();
}

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// Auth
export async function register(email?: string) {
  return apiFetch<{ token: string; userId: string; plan: string; mcpConfig: object }>(
    "/auth/register", { method: "POST", body: JSON.stringify({ email }) },
  );
}

export async function getMe() {
  return apiFetch<{ id: string; email: string | null; plan: string }>("/auth/me");
}

// Projects
export type Project = { project: string; memory_count: number; last_active: string };
export async function getProjects(): Promise<Project[]> {
  return apiFetch("/v1/projects");
}

// Memories
export type Memory = {
  id: string; kind: string; content: string;
  pinned: boolean; created_at: string; expires_at: string | null;
};
export async function getMemories(project: string, kind?: string): Promise<Memory[]> {
  const q = new URLSearchParams({ project });
  if (kind) q.set("kind", kind);
  return apiFetch(`/v1/memories?${q}`);
}

export async function deleteMemory(id: string): Promise<void> {
  return apiFetch(`/v1/memories/${id}`, { method: "DELETE" });
}

// Briefing
export type Briefing = {
  lastSession?: { task?: string; endedAt: string; status: string };
  pinnedFacts: string[];
  deadEnds: string[];
  openTasks: string[];
  tokenEstimate: number;
};
export async function getBriefing(project: string): Promise<Briefing> {
  return apiFetch(`/v1/briefing?project=${encodeURIComponent(project)}`);
}

// Sessions
export type Session = {
  id: string; task: string | null; started_at: string;
  ended_at: string | null; summary: string | null;
};
export async function getSessions(project: string): Promise<Session[]> {
  return apiFetch(`/v1/sessions?project=${encodeURIComponent(project)}`);
}

// Recall
export type RecallResult = { content: string; kind: string; score: number; created_at: string };
export async function recall(project: string, query: string): Promise<RecallResult[]> {
  return apiFetch("/v1/recall", {
    method: "POST",
    body: JSON.stringify({ query, project, limit: 20 }),
  });
}
