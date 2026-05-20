#!/usr/bin/env node
import { EventLedger } from "./ledger.js";
import { runCapabilityProbe } from "./capabilityProbe.js";
import { buildWorkOrder } from "./roleContracts.js";

async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help") {
    printHelp();
    return 0;
  }

  if (command === "probe") {
    const result = await runCapabilityProbe({
      cwd: process.cwd(),
      withTurn: args.includes("--with-turn")
    });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (command === "work-order") {
    const [role, taskId, ...objectiveParts] = args;
    if (!role || !taskId || objectiveParts.length === 0) {
      throw new Error("usage: codex-butler work-order <role> <task-id> <objective>");
    }
    const workOrder = buildWorkOrder({
      role,
      taskId,
      goal: "manual",
      objective: objectiveParts.join(" "),
      ownedScope: "specified by Butler"
    });
    console.log(JSON.stringify(workOrder, null, 2));
    return 0;
  }

  if (command === "ledger-append") {
    const [path, type, payloadJson = "{}"] = args;
    if (!path || !type) {
      throw new Error("usage: codex-butler ledger-append <path> <type> [payload-json]");
    }
    const ledger = new EventLedger(path);
    const event = await ledger.append(type, JSON.parse(payloadJson));
    console.log(JSON.stringify(event, null, 2));
    return 0;
  }

  throw new Error(`unknown command: ${command}`);
}

function printHelp() {
  console.log(`codex-butler

Commands:
  probe
    Run Codex CLI, app-server schema, JSONL transport, and read-only sandbox checks.

  probe --with-turn
    Also run a real app-server turn/start with outputSchema. This uses the model.

  work-order <role> <task-id> <objective>
    Print a role-constrained worker work order.

  ledger-append <path> <type> [payload-json]
    Append one event to a JSONL ledger.
`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
