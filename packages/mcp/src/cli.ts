#!/usr/bin/env node
import { startServer } from "./server.js";

startServer().catch((err) => {
  console.error("jinamem MCP server failed to start:", err);
  process.exit(1);
});
