#!/usr/bin/env node
/**
 * jinamem-run — run any command with jinamem watching its output.
 *
 *   jinamem-run npm run dev
 *   jinamem-run python manage.py runserver
 *   jinamem-run --level error -- docker compose up
 *
 * Output passes through unchanged; errors and crashes are saved to the
 * project's memory, so the next agent session knows what broke. Same as
 * `jinamem-watch --pipe "<command>"`, without the quoting.
 */

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const flags = sep === -1 ? [] : argv.slice(0, sep);
const command = sep === -1 ? argv : argv.slice(sep + 1);

if (command.length === 0) {
  console.error("Usage: jinamem-run [--level error|warn|all] [--project <name>] [--] <command...>");
  console.error("Example: jinamem-run npm run dev");
  process.exit(1);
}

// Re-quote arguments so the shell sees them exactly as typed
const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

process.argv = [process.argv[0], process.argv[1], ...flags, "--pipe", command.map(quote).join(" ")];
require("./watch.js");
