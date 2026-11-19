import { useState, useEffect, useCallback } from "react";
import {
  isLoggedIn, setToken, clearToken, getMe, getProjects,
  getBriefing, getMemories, getSessions, recall, deleteMemory, register,
  type Project, type Memory, type Briefing, type Session, type RecallResult,
} from "./api.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function cls(...args: (string | boolean | undefined | null)[]): string {
  return args.filter(Boolean).join(" ");
}

// ─── Styles (inline) ─────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  app: { display: "flex", height: "100vh", overflow: "hidden" },
  sidebar: {
    width: 220, background: "var(--bg2)", borderRight: "1px solid var(--border)",
    display: "flex", flexDirection: "column", flexShrink: 0,
  },
  sidebarHeader: {
    padding: "20px 16px 12px",
    borderBottom: "1px solid var(--border)",
  },
  logo: {
    fontFamily: "var(--font-head)", fontSize: 18, fontWeight: 700,
    color: "var(--text)", letterSpacing: "-0.3px",
  },
  logoAccent: { color: "var(--accent)" },
  projectList: { flex: 1, overflowY: "auto", padding: "8px 0" },
  projectItem: {
    padding: "8px 16px", cursor: "pointer", borderRadius: 0,
    display: "flex", flexDirection: "column", gap: 2,
    transition: "background 0.1s",
  },
  projectName: { fontWeight: 500, fontSize: 13 },
  projectMeta: { fontSize: 11, color: "var(--text2)" },
  main: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  topbar: {
    height: 52, borderBottom: "1px solid var(--border)", background: "var(--bg2)",
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "0 20px", flexShrink: 0,
  },
  topbarTitle: { fontFamily: "var(--font-head)", fontWeight: 600, fontSize: 15 },
  content: { flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 16 },
  card: {
    background: "var(--bg2)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", padding: "16px 20px",
  },
  cardTitle: {
    fontFamily: "var(--font-head)", fontWeight: 600, fontSize: 13,
    color: "var(--text2)", textTransform: "uppercase" as const,
    letterSpacing: "0.08em", marginBottom: 12,
    display: "flex", alignItems: "center", gap: 6,
  },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 },
  memoryItem: {
    padding: "10px 14px", background: "var(--bg3)",
    borderRadius: 8, border: "1px solid var(--border)",
    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
    gap: 8,
  },
  memContent: { fontSize: 13, lineHeight: 1.5, flex: 1 },
  memMeta: { fontSize: 11, color: "var(--text2)", marginTop: 4 },
  deleteBtn: {
    background: "transparent", color: "var(--text2)", fontSize: 16,
    padding: "0 4px", lineHeight: 1, flexShrink: 0,
    border: "none", cursor: "pointer",
  },
  badge: {
    display: "inline-flex", alignItems: "center", fontSize: 11, fontWeight: 500,
    padding: "2px 7px", borderRadius: 20,
  },
  searchBar: {
    width: "100%", background: "var(--bg3)", border: "1px solid var(--border)",
    borderRadius: 8, padding: "9px 14px", color: "var(--text)", fontSize: 14,
    marginBottom: 12,
  },
  btn: {
    background: "var(--accent)", color: "#fff", fontWeight: 600, fontSize: 13,
    padding: "8px 16px", borderRadius: 8, border: "none", cursor: "pointer",
  },
  btnSm: {
    background: "var(--bg3)", color: "var(--text)", fontWeight: 500, fontSize: 12,
    padding: "5px 10px", borderRadius: 6, border: "1px solid var(--border)", cursor: "pointer",
  },
  emptyState: {
    color: "var(--text2)", fontSize: 13, padding: "24px 0", textAlign: "center" as const,
  },
  tabs: { display: "flex", gap: 2, marginBottom: 14 },
  tab: {
    padding: "6px 12px", borderRadius: 6, fontSize: 13, fontWeight: 500,
    border: "1px solid transparent", cursor: "pointer", background: "transparent", color: "var(--text2)",
  },
  tabActive: {
    background: "var(--bg3)", border: "1px solid var(--border)", color: "var(--text)",
  },
  statRow: {
    display: "flex", gap: 12,
  },
  stat: {
    flex: 1, background: "var(--bg3)", border: "1px solid var(--border)",
    borderRadius: 8, padding: "14px 16px",
  },
  statNum: { fontFamily: "var(--font-head)", fontSize: 28, fontWeight: 700, lineHeight: 1 },
  statLabel: { fontSize: 12, color: "var(--text2)", marginTop: 4 },
  loginWrap: {
    display: "flex", alignItems: "center", justifyContent: "center",
    height: "100vh", background: "var(--bg)",
  },
  loginBox: {
    background: "var(--bg2)", border: "1px solid var(--border)",
    borderRadius: 16, padding: 40, width: 380, display: "flex",
    flexDirection: "column", gap: 16,
  },
  input: {
    background: "var(--bg3)", border: "1px solid var(--border)",
    borderRadius: 8, padding: "10px 14px", color: "var(--text)",
    fontSize: 14, width: "100%",
  },
  errorText: { color: "var(--red)", fontSize: 12 },
};

// ─── Login screen ─────────────────────────────────────────────────────────────

function Login({ onLogin }: { onLogin: () => void }) {
  const [token, setTokenVal] = useState("");
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setErr(""); setLoading(true);
    try {
      if (mode === "login") {
        setToken(token.trim());
        await getMe(); // validate
        onLogin();
      } else {
        const res = await register(email || undefined);
        setToken(res.token);
        onLogin();
      }
    } catch (e: any) {
      setErr(e.message ?? "Failed");
      clearToken();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={S.loginWrap}>
      <div style={S.loginBox}>
        <div style={{ ...S.logo, fontSize: 22, marginBottom: 4 }}>
          jina<span style={S.logoAccent}>mem</span>
        </div>
        <p style={{ color: "var(--text2)", fontSize: 14 }}>
          Persistent memory for AI agents.
        </p>

        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ ...S.btnSm, ...(mode === "login" ? S.tabActive : {}) }} onClick={() => setMode("login")}>Sign in</button>
          <button style={{ ...S.btnSm, ...(mode === "register" ? S.tabActive : {}) }} onClick={() => setMode("register")}>Create account</button>
        </div>

        {mode === "login" ? (
          <input
            style={S.input} placeholder="Paste your JINAMEM_TOKEN"
            value={token} onChange={e => setTokenVal(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
          />
        ) : (
          <input
            style={S.input} placeholder="Email (optional)"
            value={email} onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
          />
        )}

        {err && <p style={S.errorText}>{err}</p>}

        <button style={S.btn} onClick={submit} disabled={loading}>
          {loading ? "..." : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </div>
    </div>
  );
}

// ─── Memory list ──────────────────────────────────────────────────────────────

function MemoryList({ project, kind, refresh }: { project: string; kind?: string; refresh: number }) {
  const [items, setItems] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getMemories(project, kind)
      .then(setItems)
      .finally(() => setLoading(false));
  }, [project, kind, refresh]);

  const handleDelete = async (id: string) => {
    await deleteMemory(id);
    setItems(prev => prev.filter(m => m.id !== id));
  };

  if (loading) return <p style={S.emptyState}>Loading...</p>;
  if (items.length === 0) return <p style={S.emptyState}>No memories yet.</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map(m => (
        <div key={m.id} style={S.memoryItem}>
          <div style={{ flex: 1 }}>
            <p style={S.memContent}>{m.content}</p>
            <p style={S.memMeta}>
              {m.pinned && (
                <span style={{ ...S.badge, background: "#2d2560", color: "var(--accent)", marginRight: 6 }}>📌 pinned</span>
              )}
              {timeAgo(m.created_at)}
              {m.expires_at && ` · expires ${timeAgo(m.expires_at)}`}
            </p>
          </div>
          <button style={S.deleteBtn} onClick={() => handleDelete(m.id)} title="Delete">×</button>
        </div>
      ))}
    </div>
  );
}

// ─── Search tab ───────────────────────────────────────────────────────────────

function SearchPanel({ project }: { project: string }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<RecallResult[]>([]);
  const [loading, setLoading] = useState(false);

  const search = async () => {
    if (!q.trim()) return;
    setLoading(true);
    try {
      const res = await recall(project, q);
      setResults(res);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          style={{ ...S.searchBar, marginBottom: 0, flex: 1 }}
          placeholder="Search memories..."
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => e.key === "Enter" && search()}
        />
        <button style={S.btn} onClick={search} disabled={loading}>
          {loading ? "..." : "Search"}
        </button>
      </div>
      {results.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {results.map((r, i) => (
            <div key={i} style={S.memoryItem}>
              <div style={{ flex: 1 }}>
                <p style={S.memContent}>{r.content}</p>
                <p style={S.memMeta}>
                  score {Math.round(r.score * 100)}% · {timeAgo(r.created_at)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Sessions tab ─────────────────────────────────────────────────────────────

function SessionsPanel({ project }: { project: string }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getSessions(project).then(setSessions).finally(() => setLoading(false));
  }, [project]);

  if (loading) return <p style={S.emptyState}>Loading...</p>;
  if (sessions.length === 0) return <p style={S.emptyState}>No sessions yet.</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {sessions.map(s => (
        <div key={s.id} style={S.memoryItem}>
          <div style={{ flex: 1 }}>
            <p style={{ ...S.memContent, fontWeight: 500 }}>
              {s.task ?? "Untitled session"}
            </p>
            <p style={S.memMeta}>
              {timeAgo(s.started_at)}
              {s.ended_at
                ? ` · ${Math.round((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 60000)}min`
                : " · in progress"}
            </p>
            {s.summary && <p style={{ ...S.memMeta, marginTop: 4, fontStyle: "italic" }}>{s.summary}</p>}
          </div>
          <span style={{
            ...S.badge,
            background: s.ended_at ? "#1a3326" : "#2d2a10",
            color: s.ended_at ? "var(--green)" : "var(--yellow)",
          }}>
            {s.ended_at ? "done" : "active"}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Project view ─────────────────────────────────────────────────────────────

function ProjectView({ project, onLogout }: { project: string; onLogout: () => void }) {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [tab, setTab] = useState<"overview" | "facts" | "deadends" | "search" | "sessions">("overview");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    getBriefing(project).then(setBriefing).catch(() => {});
  }, [project, refresh]);

  const tabs: Array<{ id: typeof tab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "facts", label: "📌 Facts" },
    { id: "deadends", label: "🚫 Dead ends" },
    { id: "search", label: "🔍 Search" },
    { id: "sessions", label: "Sessions" },
  ];

  return (
    <>
      <div style={S.topbar}>
        <span style={S.topbarTitle}>{project}</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button style={S.btnSm} onClick={() => setRefresh(r => r + 1)}>↻ Refresh</button>
          <button style={S.btnSm} onClick={onLogout}>Sign out</button>
        </div>
      </div>

      <div style={S.content}>
        {briefing && (
          <div style={S.statRow}>
            {[
              { num: briefing.pinnedFacts.length, label: "Pinned facts" },
              { num: briefing.deadEnds.length, label: "Dead ends" },
              { num: briefing.openTasks.length, label: "Open tasks" },
              { num: briefing.tokenEstimate, label: "Est. tokens" },
            ].map(s => (
              <div key={s.label} style={S.stat}>
                <div style={S.statNum}>{s.num}</div>
                <div style={S.statLabel}>{s.label}</div>
              </div>
            ))}
          </div>
        )}

        <div style={S.tabs}>
          {tabs.map(t => (
            <button
              key={t.id}
              style={{ ...S.tab, ...(tab === t.id ? S.tabActive : {}) }}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "overview" && briefing && (
          <div>
            {briefing.lastSession && (
              <div style={{ ...S.card, marginBottom: 12 }}>
                <div style={S.cardTitle}>Last session</div>
                <p>{briefing.lastSession.task ?? "Untitled"}</p>
                <p style={{ color: "var(--text2)", fontSize: 12, marginTop: 4 }}>
                  {timeAgo(briefing.lastSession.endedAt)} · {briefing.lastSession.status}
                </p>
              </div>
            )}

            {briefing.pinnedFacts.length > 0 && (
              <div style={{ ...S.card, marginBottom: 12 }}>
                <div style={S.cardTitle}>📌 Always remember</div>
                {briefing.pinnedFacts.map((f, i) => (
                  <p key={i} style={{ fontSize: 13, padding: "4px 0", borderBottom: i < briefing.pinnedFacts.length - 1 ? "1px solid var(--border)" : "none" }}>
                    {f}
                  </p>
                ))}
              </div>
            )}

            {briefing.deadEnds.length > 0 && (
              <div style={S.card}>
                <div style={S.cardTitle}>🚫 Don't retry</div>
                {briefing.deadEnds.map((d, i) => (
                  <p key={i} style={{ fontSize: 13, padding: "4px 0", color: "var(--text2)", borderBottom: i < briefing.deadEnds.length - 1 ? "1px solid var(--border)" : "none" }}>
                    {d}
                  </p>
                ))}
              </div>
            )}

            {!briefing.lastSession && briefing.pinnedFacts.length === 0 && briefing.deadEnds.length === 0 && (
              <p style={S.emptyState}>No memory yet for this project. Start a session with jinamem to capture context.</p>
            )}
          </div>
        )}

        {tab === "facts" && (
          <div style={S.card}>
            <MemoryList project={project} kind="fact" refresh={refresh} />
          </div>
        )}

        {tab === "deadends" && (
          <div style={S.card}>
            <MemoryList project={project} refresh={refresh} />
          </div>
        )}

        {tab === "search" && (
          <div style={S.card}>
            <SearchPanel project={project} />
          </div>
        )}

        {tab === "sessions" && (
          <div style={S.card}>
            <SessionsPanel project={project} />
          </div>
        )}
      </div>
    </>
  );
}

// ─── App root ─────────────────────────────────────────────────────────────────

export default function App() {
  const [loggedIn, setLoggedIn] = useState(isLoggedIn());
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const ps = await getProjects();
      setProjects(ps);
      if (ps.length > 0 && !activeProject) {
        setActiveProject(ps[0].project);
      }
    } catch {}
  }, [activeProject]);

  useEffect(() => {
    if (loggedIn) loadProjects();
  }, [loggedIn, loadProjects]);

  const handleLogin = () => { setLoggedIn(true); };
  const handleLogout = () => { clearToken(); setLoggedIn(false); setProjects([]); setActiveProject(null); };

  if (!loggedIn) return <Login onLogin={handleLogin} />;

  return (
    <div style={S.app}>
      <aside style={S.sidebar}>
        <div style={S.sidebarHeader}>
          <div style={S.logo}>jina<span style={S.logoAccent}>mem</span></div>
        </div>
        <div style={S.projectList}>
          {projects.length === 0 && (
            <p style={{ ...S.emptyState, padding: "16px", textAlign: "left" }}>No projects yet</p>
          )}
          {projects.map(p => (
            <div
              key={p.project}
              style={{
                ...S.projectItem,
                background: activeProject === p.project ? "var(--bg3)" : "transparent",
              }}
              onClick={() => setActiveProject(p.project)}
            >
              <span style={S.projectName}>{p.project}</span>
              <span style={S.projectMeta}>{p.memory_count} memories · {timeAgo(p.last_active)}</span>
            </div>
          ))}
        </div>
      </aside>

      <main style={S.main}>
        {activeProject ? (
          <ProjectView project={activeProject} onLogout={handleLogout} />
        ) : (
          <div style={{ ...S.content, alignItems: "center", justifyContent: "center", flex: 1 }}>
            <p style={S.emptyState}>No projects found. Connect jinamem to a project to get started.</p>
          </div>
        )}
      </main>
    </div>
  );
}
