#!/usr/bin/env node
import { EventLedger } from "./ledger.js";
import { runCapabilityProbe } from "./capabilityProbe.js";
import { buildWorkOrder } from "./roleContracts.js";
import { createDefaultService, SESSION_ROLES } from "./butlerService.js";
import { runDaemon } from "./daemon.js";
import {
  installLaunchdServices,
  launchdLogPaths,
  statusLaunchdServices,
  uninstallLaunchdServices
} from "./launchd.js";
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

  if (command === "register-session") {
    const parsed = parseSessionArgs(args);
    console.log(JSON.stringify(await createDefaultService().registerSession(parsed), null, 2));
    return 0;
  }

  if (command === "add-butler-session") {
    const parsed = parseSessionArgs(args);
    console.log(JSON.stringify(await createDefaultService().addButlerSession(parsed), null, 2));
    return 0;
  }

  if (command === "sessions") {
    const parsed = parseSessionArgs(args, { allowMissingThreadId: true });
    console.log(JSON.stringify(await createDefaultService().listSessions({ role: parsed.role }), null, 2));
    return 0;
  }

  if (command === "probe-session") {
    const [sessionIdOrThreadId] = args;
    if (!sessionIdOrThreadId) throw new Error("usage: codex-butler probe-session <session-id-or-thread-id>");
    console.log(JSON.stringify(await createDefaultService().probeSession({ sessionIdOrThreadId }), null, 2));
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

  if (command === "launchd") {
    const [subcommand, ...subcommandArgs] = args;
    const parsed = parseLaunchdArgs(subcommandArgs);
    if (subcommand === "install" || subcommand === "restart") {
      console.log(JSON.stringify(await installLaunchdServices({
        projectRoot: process.cwd(),
        target: parsed.target,
        host: parsed.host,
        port: parsed.port,
        nodePath: parsed.nodePath
      }), null, 2));
      return 0;
    }
    if (subcommand === "status") {
      console.log(JSON.stringify(await statusLaunchdServices({
        projectRoot: process.cwd(),
        target: parsed.target
      }), null, 2));
      return 0;
    }
    if (subcommand === "logs") {
      console.log(JSON.stringify(launchdLogPaths({
        projectRoot: process.cwd(),
        target: parsed.target
      }), null, 2));
      return 0;
    }
    if (subcommand === "uninstall") {
      console.log(JSON.stringify(await uninstallLaunchdServices({
        projectRoot: process.cwd(),
        target: parsed.target
      }), null, 2));
      return 0;
    }
    throw new Error("usage: codex-butler launchd <install|status|restart|logs|uninstall>");
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

  register-session <thread-id> [role] [--label name] [--cwd path] [--source existing-local|app-server|manual] [--notes text]
    Register an existing local Codex session/thread as Butler-managed state.

  add-butler-session <thread-id> [--label name] [--cwd path] [--notes text]
    Register an existing local Codex session/thread as the Butler controller.

  sessions [role]
    List managed sessions, optionally filtered by role.

  probe-session <session-id-or-thread-id>
    Send a minimal turn to a managed session to verify current transport reachability.

  status
    Print goals, tasks, and control-plane data location.

  dashboard [--json]
    Print a human-readable dashboard, or dashboard data with --json.

  daemon <status|start|stop|run>
    Manage the long-running Butler daemon process.

  web [--host 127.0.0.1] [--port 4177]
    Serve the local web console.

  launchd <install|status|restart|logs|uninstall> [--target all|daemon|web] [--host 127.0.0.1] [--port 4177]
    Manage persistent macOS launchd services for the daemon and web console.
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

function parseLaunchdArgs(argv) {
  const parsed = { target: "all" };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--target") parsed.target = argv[++index];
    else if (item === "--host") parsed.host = argv[++index];
    else if (item === "--port") parsed.port = argv[++index];
    else if (item === "--node-path") parsed.nodePath = argv[++index];
  }
  return parsed;
}

function parseSessionArgs(argv, options = {}) {
  const positionals = [];
  const parsed = { source: "existing-local" };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--label") parsed.label = argv[++index];
    else if (item === "--cwd") parsed.cwd = argv[++index];
    else if (item === "--source") parsed.source = argv[++index];
    else if (item === "--notes") parsed.notes = argv[++index];
    else positionals.push(item);
  }
  if (!options.allowMissingThreadId && !positionals[0]) {
    throw new Error("usage: codex-butler register-session <thread-id> [role]");
  }
  if (positionals[0]) parsed.threadId = positionals[0];
  if (positionals[1]) parsed.role = positionals[1];
  if (options.allowMissingThreadId && positionals[0] && SESSION_ROLES.includes(positionals[0])) {
    parsed.role = positionals[0];
    delete parsed.threadId;
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
