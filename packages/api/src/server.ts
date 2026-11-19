/**
 * jinamem API server — cloud backend for jinamem.dev
 *
 * Endpoints:
 *   POST /auth/register          — create a user, returns token
 *   GET  /auth/me                — current user info
 *
 *   GET  /v1/briefing            — getBriefing(project)
 *   POST /v1/remember            — remember(note, pin?)
 *   POST /v1/recall              — recall(query, limit?)
 *   POST /v1/attempt             — logAttempt(action, result?, success?)
 *   POST /v1/session/start       — startSession(project, task?)
 *   POST /v1/session/end         — endSession(sessionId, summary?)
 *   GET  /v1/session/last        — getLastSession(project)
 *   GET  /v1/session/:id/attempts
 *
 *   GET  /v1/memories            — list all memories for a project
 *   DELETE /v1/memories/:id      — delete a memory
 *
 * Auth: Bearer token (from JINAMEM_TOKEN) in Authorization header.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import staticPlugin from "@fastify/static";
import postgres from "postgres";
import { nanoid } from "nanoid";
import { z } from "zod";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { PgStore } from "./pg-store.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT   = parseInt(process.env.PORT ?? "3001");
const HOST   = process.env.HOST ?? "0.0.0.0";
const DB_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET ?? "jinamem-change-me-in-production";

if (!DB_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(DB_URL);

// ─── Fastify ──────────────────────────────────────────────────────────────────

const app = Fastify({ logger: { level: "info" } });

await app.register(cors, { origin: true });
await app.register(jwt, { secret: JWT_SECRET });

// ─── Auth middleware ──────────────────────────────────────────────────────────

// Resolve userId from Bearer token (the opaque token stored in users table)
async function resolveUser(token: string): Promise<{ id: string; email: string | null; plan: string } | null> {
  const rows = await sql<{ id: string; email: string | null; plan: string }[]>`
    SELECT id, email, plan FROM users WHERE token = ${token}
  `;
  return rows[0] ?? null;
}

// Fastify hook — verify Authorization: Bearer <token>
app.addHook("onRequest", async (req, reply) => {
  // Skip auth for /auth routes and health check
  if (req.url.startsWith("/auth") || req.url === "/health") return;

  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "Missing token" });
  }
  const token = auth.slice(7);
  const user = await resolveUser(token);
  if (!user) {
    return reply.status(401).send({ error: "Invalid token" });
  }
  (req as any).userId = user.id;
  (req as any).user = user;
});

function getUserId(req: any): string {
  return req.userId as string;
}

function getProject(req: any): string {
  return (req.query as any).project ?? (req.body as any)?.project ?? "default";
}

// ─── Routes: Auth ─────────────────────────────────────────────────────────────

app.get("/health", async () => ({ ok: true, service: "jinamem-api" }));

app.post("/auth/register", async (req, reply) => {
  const body = z.object({
    email: z.string().email().optional(),
    plan: z.enum(["free", "pro"]).optional(),
  }).parse(req.body);

  const id = nanoid(16);
  const token = `am_live_${nanoid(32)}`;

  await sql`
    INSERT INTO users (id, email, token, plan)
    VALUES (${id}, ${body.email ?? null}, ${token}, ${body.plan ?? "free"})
    ON CONFLICT (email) DO NOTHING
  `;

  // If email already existed, return existing token
  const rows = await sql<{ id: string; token: string; plan: string }[]>`
    SELECT id, token, plan FROM users WHERE ${body.email ? sql`email = ${body.email}` : sql`id = ${id}`}
  `;

  const user = rows[0]!;
  reply.status(201).send({
    token: user.token,
    userId: user.id,
    plan: user.plan,
    mcpConfig: {
      mcpServers: {
        jinamem: {
          command: "npx",
          args: ["@jinamem/mcp"],
          env: { JINAMEM_TOKEN: user.token, JINAMEM_API_URL: process.env.PUBLIC_URL ?? "https://jinamem.dev" },
        },
      },
    },
  });
});

app.get("/auth/me", async (req) => {
  return (req as any).user;
});

// ─── Routes: Memory ───────────────────────────────────────────────────────────

app.post("/v1/remember", async (req) => {
  const body = z.object({
    note: z.string(),
    pin: z.boolean().optional(),
    project: z.string().optional(),
  }).parse(req.body);

  const store = new PgStore(sql);
  const memory = await store.remember(getUserId(req), body.project ?? "default", body.note, body.pin ?? false);
  return memory;
});

app.post("/v1/recall", async (req) => {
  const body = z.object({
    query: z.string(),
    limit: z.number().optional(),
    project: z.string().optional(),
  }).parse(req.body);

  const store = new PgStore(sql);
  return store.recall(getUserId(req), body.project ?? "default", body.query, body.limit ?? 10);
});

app.get<{ Querystring: { project?: string } }>("/v1/briefing", async (req) => {
  const store = new PgStore(sql);
  return store.getBriefing(getUserId(req), getProject(req));
});

// ─── Routes: Attempts ─────────────────────────────────────────────────────────

app.post("/v1/attempt", async (req) => {
  const body = z.object({
    sessionId: z.string(),
    action: z.string(),
    result: z.string().optional(),
    success: z.boolean().optional(),
    project: z.string().optional(),
  }).parse(req.body);

  const store = new PgStore(sql);
  return store.logAttempt(
    getUserId(req), body.project ?? "default", body.sessionId,
    body.action, body.result, body.success ?? true,
  );
});

// ─── Routes: Sessions ─────────────────────────────────────────────────────────

app.post("/v1/session/start", async (req) => {
  const body = z.object({
    project: z.string().optional(),
    task: z.string().optional(),
  }).parse(req.body);

  const store = new PgStore(sql);
  return store.startSession(getUserId(req), body.project ?? "default", body.task);
});

app.post("/v1/session/end", async (req) => {
  const body = z.object({
    sessionId: z.string(),
    summary: z.string().optional(),
  }).parse(req.body);

  const store = new PgStore(sql);
  return store.endSession(body.sessionId, body.summary);
});

app.get<{ Querystring: { project?: string } }>("/v1/session/last", async (req) => {
  const store = new PgStore(sql);
  return store.getLastSession(getUserId(req), getProject(req));
});

app.get<{ Params: { id: string } }>("/v1/session/:id/attempts", async (req) => {
  const store = new PgStore(sql);
  return store.getSessionAttempts(req.params.id);
});

// ─── Routes: Dashboard data ───────────────────────────────────────────────────

app.get<{ Querystring: { project?: string; kind?: string; limit?: string } }>("/v1/memories", async (req) => {
  const { project = "default", kind, limit = "50" } = req.query;
  const userId = getUserId(req);

  const rows = await sql<{ id: string; kind: string; content: string; pinned: boolean; created_at: Date; expires_at: Date | null }[]>`
    SELECT id, kind, content, pinned, created_at, expires_at
    FROM memories
    WHERE user_id = ${userId} AND project = ${project}
      ${kind ? sql`AND kind = ${kind}` : sql``}
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY pinned DESC, created_at DESC
    LIMIT ${parseInt(limit)}
  `;
  return rows;
});

app.delete<{ Params: { id: string } }>("/v1/memories/:id", async (req, reply) => {
  await sql`
    DELETE FROM memories WHERE id = ${req.params.id} AND user_id = ${getUserId(req)}
  `;
  return reply.status(204).send();
});

app.get<{ Querystring: { project?: string } }>("/v1/sessions", async (req) => {
  const { project = "default" } = req.query;
  const rows = await sql<{ id: string; task: string | null; started_at: Date; ended_at: Date | null; summary: string | null }[]>`
    SELECT id, task, started_at, ended_at, summary
    FROM sessions
    WHERE user_id = ${getUserId(req)} AND project = ${project}
    ORDER BY started_at DESC
    LIMIT 50
  `;
  return rows;
});

app.get<{ Querystring: { project?: string } }>("/v1/projects", async (req) => {
  const rows = await sql<{ project: string; memory_count: number; last_active: Date }[]>`
    SELECT project,
           COUNT(*)::int AS memory_count,
           MAX(created_at) AS last_active
    FROM memories
    WHERE user_id = ${getUserId(req)}
    GROUP BY project
    ORDER BY last_active DESC
  `;
  return rows;
});

// ─── Serve dashboard static files ─────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardDist = resolve(__dirname, "../../dashboard/dist");

if (existsSync(dashboardDist)) {
  await app.register(staticPlugin, {
    root: dashboardDist,
    prefix: "/",
    decorateReply: false,
  });

  // SPA fallback
  app.setNotFoundHandler(async (req, reply) => {
    if (!req.url.startsWith("/v1") && !req.url.startsWith("/auth")) {
      return reply.sendFile("index.html", dashboardDist);
    }
    return reply.status(404).send({ error: "Not found" });
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

await app.listen({ port: PORT, host: HOST });
console.log(`jinamem API running on http://${HOST}:${PORT}`);
