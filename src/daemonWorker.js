#!/usr/bin/env node
import { runDaemon } from "./daemon.js";
import { createDefaultService } from "./butlerService.js";

const args = parseArgs(process.argv.slice(2));
const projectRoot = args.projectRoot ?? process.cwd();
const dataDir = args.dataDir;
const service = createDefaultService({ projectRoot, dataDir });

runDaemon({
  projectRoot,
  dataDir,
  heartbeatMs: args.heartbeatMs ? Number(args.heartbeatMs) : undefined,
  onHeartbeat: () => service.advanceActiveSessionRuns({ maxRuns: 1, maxTurns: 1 })
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
