#!/usr/bin/env node
import { EventLedger } from "./ledger.js";
import { runCapabilityProbe } from "./capabilityProbe.js";
import { buildWorkOrder } from "./roleContracts.js";
import { createDefaultService } from "./butlerService.js";
import { runDaemon } from "./daemon.js";
import { startWebServer } from "./webServer.js";

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

  if (command === "plan-goal") {
    const objective = args.join(" ");
    if (!objective) throw new Error("usage: codex-butler plan-goal <objective>");
    console.log(JSON.stringify(await createDefaultService().planGoal({ objective }), null, 2));
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
    if (!taskId) {
      throw new Error("usage: codex-butler verify-task <task-id> [-- <command> [args...]]");
    }
    console.log(JSON.stringify(await createDefaultService().runVerifier({
      taskId,
      command: commandArgs.length > 0 ? commandArgs : null
    }), null, 2));
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

  if (command === "dashboard") {
    const result = await createDefaultService().dashboard();
    console.log(args.includes("--json") ? JSON.stringify(result, null, 2) : result.dashboard);
    return 0;
  }

  if (command === "daemon") {
    const [subcommand] = args;
    const service = createDefaultService();
    if (subcommand === "status") {
      console.log(JSON.stringify(await service.daemonStatus(), null, 2));
      return 0;
    }
    if (subcommand === "start") {
      console.log(JSON.stringify(await service.startDaemon(), null, 2));
      return 0;
    }
    if (subcommand === "stop") {
      console.log(JSON.stringify(await service.stopDaemon(), null, 2));
      return 0;
    }
    if (subcommand === "run") {
      await runDaemon({
        projectRoot: process.cwd()
      });
      return 0;
    }
    throw new Error("usage: codex-butler daemon <status|start|stop|run>");
  }

  if (command === "web") {
    const parsed = parseWebArgs(args);
    const result = await startWebServer(parsed);
    console.log(`codex-butler web listening at http://${result.host}:${result.port}`);
    await new Promise(() => {});
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

  plan-goal <objective>
    Compile a natural-language objective into an ordered Butler goal plan.

  create-task <goal-id> <role> <objective>
    Create a role-owned task under a goal.

  dispatch-task <task-id>
    Dispatch a task to an app-server worker turn.

  allocate-worktree <task-id>
    Create an isolated git worktree for a task.

  verify-task <task-id> [-- <command> [args...]]
    Run deterministic verification for a task. Uses the task's stored command when omitted.

  promote-task <task-id>
    Promote a verified task through the promotion gate.

  status
    Print goals, tasks, and control-plane data location.

  dashboard [--json]
    Print a human-readable dashboard, or dashboard data with --json.

  daemon <status|start|stop|run>
    Manage the long-running Butler daemon process.

  web [--host 127.0.0.1] [--port 4177]
    Serve the local web console.
`);
}

function parseWebArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--host") parsed.host = argv[++index];
    else if (item === "--port") parsed.port = argv[++index];
  }
  return parsed;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
