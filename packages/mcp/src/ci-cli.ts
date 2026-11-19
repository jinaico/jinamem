#!/usr/bin/env node
/**
 * jinamem-ci — pull failed GitHub Actions runs into the project's memory.
 *
 *   jinamem-ci            # in your project directory
 *
 * The MCP server already does this when a session starts and before each
 * briefing; run this by hand, or from cron, to catch failures in between.
 */

import { createStore } from "@jinamem/core";
import { syncCI } from "./ci.js";
import { projectName } from "./project.js";

async function main() {
  const project = projectName();
  const { store } = createStore();
  try {
    const r = await syncCI(store, process.env.JINAMEM_USER_ID ?? "local", project, process.cwd());
    if (r.skipped) console.log(`jinamem-ci: skipped — ${r.skipped}`);
    else console.log(`jinamem-ci: ${project} · ${r.failures} new failure(s), ${r.recoveries} recovery(ies)`);
  } finally {
    await store.close();
  }
}

main().catch(err => {
  console.error("jinamem-ci:", err);
  process.exit(1);
});
