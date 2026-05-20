#!/usr/bin/env node
import { EventLedger } from "./ledger.js";
import { runCapabilityProbe } from "./capabilityProbe.js";
import { buildWorkOrder } from "./roleContracts.js";
import { createDefaultService } from "./butlerService.js";

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

  if (command === "submit-goal") {
    const objective = args.join(" ");
    if (!objective) throw new Error("usage: codex-butler submit-goal <objective>");
    console.log(JSON.stringify(await createDefaultService().submitGoal({ objective }), null, 2));
    return 0;
  }

  if (command === "create-task") {
    const [goalId, role, ...objectiveParts] = args;
    if (!goalId || !role || objectiveParts.length === 0) {
      throw new Error("usage: codex-butler create-task <goal-id> <role> <objective>");
    }
    console.log(JSON.stringify(await createDefaultService().createTask({
      goalId,
      role,
      objective: objectiveParts.join(" ")
    }), null, 2));
    return 0;
  }

  if (command === "dispatch-task") {
    const [taskId] = args;
    if (!taskId) throw new Error("usage: codex-butler dispatch-task <task-id>");
    console.log(JSON.stringify(await createDefaultService().dispatchTask({ taskId }), null, 2));
    return 0;
  }

  if (command === "allocate-worktree") {
    const [taskId] = args;
    if (!taskId) throw new Error("usage: codex-butler allocate-worktree <task-id>");
    console.log(JSON.stringify(await createDefaultService().allocateTaskWorktree({ taskId }), null, 2));
    return 0;
  }

  if (command === "verify-task") {
    const separator = args.indexOf("--");
    const taskId = args[0];
    const commandArgs = separator >= 0 ? args.slice(separator + 1) : args.slice(1);
    if (!taskId || commandArgs.length === 0) {
      throw new Error("usage: codex-butler verify-task <task-id> -- <command> [args...]");
    }
    console.log(JSON.stringify(await createDefaultService().runVerifier({ taskId, command: commandArgs }), null, 2));
    return 0;
  }

  if (command === "promote-task") {
    const [taskId] = args;
    if (!taskId) throw new Error("usage: codex-butler promote-task <task-id>");
    console.log(JSON.stringify(await createDefaultService().promoteTask({ taskId }), null, 2));
    return 0;
  }

  if (command === "status") {
    console.log(JSON.stringify(await createDefaultService().status(), null, 2));
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

  submit-goal <objective>
    Create a Butler goal.

  create-task <goal-id> <role> <objective>
    Create a role-owned task under a goal.

  dispatch-task <task-id>
    Dispatch a task to an app-server worker turn.

  allocate-worktree <task-id>
    Create an isolated git worktree for a task.

  verify-task <task-id> -- <command> [args...]
    Run deterministic verification for a task.

  promote-task <task-id>
    Promote a verified task through the promotion gate.

  status
    Print goals, tasks, and control-plane data location.
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
