// ─── Core Types ───────────────────────────────────────────────────────────────

export type MemoryKind = "fact" | "attempt" | "dead_end" | "task";

export interface Memory {
  id: string;
  userId: string;
  project: string;          // e.g. "acme-api", "my-app" — derived from cwd or set explicitly
  kind: MemoryKind;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  expiresAt?: Date;         // null = permanent (pinned facts)
}

export interface Attempt {
  id: string;
  userId: string;
  project: string;
  sessionId: string;
  action: string;           // what the agent tried
  result?: string;          // what happened
  success: boolean;
  createdAt: Date;
}

export interface Session {
  id: string;
  userId: string;
  project: string;
  task?: string;            // what the agent was working on
  startedAt: Date;
  endedAt?: Date;
  summary?: string;
}

export interface Briefing {
  lastSession?: {
    task?: string;
    endedAt: Date;
    status: "completed" | "in_progress" | "abandoned";
  };
  pinnedFacts: string[];
  deadEnds: string[];
  openTasks: string[];
  tokenEstimate: number;
}

export interface RecallResult {
  content: string;
  kind: MemoryKind;
  project: string;
  createdAt: Date;
  score: number;            // relevance 0–1
}

// ─── Storage Interface ────────────────────────────────────────────────────────
// Implement this for SQLite (self-host) or Postgres (cloud)

export interface JinamemStore {
  // Facts
  remember(userId: string, project: string, note: string, pin?: boolean): Promise<Memory>;
  recall(userId: string, project: string, query: string, limit?: number): Promise<RecallResult[]>;

  // Attempts
  logAttempt(userId: string, project: string, sessionId: string, action: string, result?: string, success?: boolean): Promise<Attempt>;

  // Sessions
  startSession(userId: string, project: string, task?: string): Promise<Session>;
  endSession(sessionId: string, summary?: string): Promise<Session>;
  getLastSession(userId: string, project: string): Promise<Session | null>;

  // Briefing
  getBriefing(userId: string, project: string): Promise<Briefing>;

  // Summarization
  getSessionAttempts(sessionId: string): Promise<Attempt[]>;
  getPinnedFacts(userId: string, project: string): Promise<string[]>;

  // Housekeeping
  close(): Promise<void>;
}
