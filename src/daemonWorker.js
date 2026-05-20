#!/usr/bin/env node
import { runDaemon } from "./daemon.js";

const args = parseArgs(process.argv.slice(2));

runDaemon({
  projectRoot: args.projectRoot ?? process.cwd(),
  dataDir: args.dataDir,
  heartbeatMs: args.heartbeatMs ? Number(args.heartbeatMs) : undefined
}).catch((error) => {
  console.error(error.message);
  process.exit(1);
});

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--project-root") parsed.projectRoot = argv[++index];
    else if (item === "--data-dir") parsed.dataDir = argv[++index];
    else if (item === "--heartbeat-ms") parsed.heartbeatMs = argv[++index];
  }
  return parsed;
}
