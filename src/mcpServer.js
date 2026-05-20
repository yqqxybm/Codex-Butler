#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { createDefaultService, SESSION_ROLES, SESSION_SOURCES } from "./butlerService.js";

export function createMcpServer(service = createDefaultService()) {
  const server = new McpServer({ name: "codex-butler", version: "0.1.0" });

  registerJsonTool(server, "butler_submit_goal", {
    description: "Create a Butler goal in the persistent control-plane state.",
    inputSchema: { objective: z.string().min(1) }
  }, ({ objective }) => service.submitGoal({ objective }));

  registerJsonTool(server, "butler_plan_goal", {
    description: "Compile a natural-language objective into an ordered Butler goal and role-owned tasks.",
    inputSchema: { objective: z.string().min(1) }
  }, ({ objective }) => service.planGoal({ objective }));

  registerJsonTool(server, "butler_advance_goal", {
    description: "Advance the next runnable step for a Butler goal, or continue up to maxSteps.",
    inputSchema: {
      goalId: z.string().min(1),
      maxSteps: z.number().int().positive().optional()
    }
  }, ({ goalId, maxSteps }) => service.advanceGoal({ goalId, maxSteps }));

  registerJsonTool(server, "butler_replan_goal", {
    description: "Replace queued tasks for a Butler goal with a fresh compiled plan.",
    inputSchema: {
      goalId: z.string().min(1)
    }
  }, ({ goalId }) => service.replanGoal({ goalId }));

  registerJsonTool(server, "butler_create_task", {
    description: "Create a task owned by a specific worker role.",
    inputSchema: {
      goalId: z.string().min(1),
      role: z.enum(["iteration-worker", "review-worker", "analysis-worker", "refine-worker", "verifier", "promoter"]),
      objective: z.string().min(1),
      ownedScope: z.string().optional(),
      prerequisites: z.array(z.string()).optional(),
      verificationCommand: z.array(z.string()).optional(),
      targetTaskId: z.string().optional()
    }
  }, ({ goalId, role, objective, ownedScope, prerequisites, verificationCommand, targetTaskId }) => service.createTask({
    goalId,
    role,
    objective,
    ownedScope,
    prerequisites,
    verificationCommand,
    targetTaskId
  }));

  registerJsonTool(server, "butler_dispatch_task", {
    description: "Dispatch a task to a real app-server worker turn and validate its structured handoff.",
    inputSchema: { taskId: z.string().min(1) }
  }, ({ taskId }) => service.dispatchTask({ taskId }));

  registerJsonTool(server, "butler_allocate_worktree", {
    description: "Allocate an isolated git worktree for a task.",
    inputSchema: { taskId: z.string().min(1) }
  }, ({ taskId }) => service.allocateTaskWorktree({ taskId }));

  registerJsonTool(server, "butler_run_verifier", {
    description: "Run a deterministic verification command for a task.",
    inputSchema: {
      taskId: z.string().min(1),
      command: z.array(z.string()).min(1)
    }
  }, ({ taskId, command }) => service.runVerifier({ taskId, command }));

  registerJsonTool(server, "butler_promote_task", {
    description: "Promote a verified task through the deterministic promotion gate.",
    inputSchema: { taskId: z.string().min(1) }
  }, ({ taskId }) => service.promoteTask({ taskId }));

  registerJsonTool(server, "butler_retry_task", {
    description: "Requeue a Butler task that stopped in rework or blocked state.",
    inputSchema: { taskId: z.string().min(1) }
  }, ({ taskId }) => service.retryTask({ taskId }));

  registerJsonTool(server, "butler_register_session", {
    description: "Register an existing local Codex session/thread as Butler-managed state.",
    inputSchema: {
      threadId: z.string().min(1),
      role: z.enum(SESSION_ROLES).optional(),
      label: z.string().optional(),
      source: z.enum(SESSION_SOURCES).optional(),
      cwd: z.string().optional(),
      notes: z.string().optional()
    }
  }, ({ threadId, role, label, source, cwd, notes }) => service.registerSession({ threadId, role, label, source, cwd, notes }));

  registerJsonTool(server, "butler_add_butler_session", {
    description: "Register an existing local Codex session/thread as the Butler controller session.",
    inputSchema: {
      threadId: z.string().min(1),
      label: z.string().optional(),
      source: z.enum(SESSION_SOURCES).optional(),
      cwd: z.string().optional(),
      notes: z.string().optional()
    }
  }, ({ threadId, label, source, cwd, notes }) => service.addButlerSession({ threadId, label, source, cwd, notes }));

  registerJsonTool(server, "butler_add_current_butler_session", {
    description: "Register the current Codex session from CODEX_THREAD_ID as an attached Butler controller.",
    inputSchema: {
      label: z.string().optional(),
      cwd: z.string().optional(),
      notes: z.string().optional()
    }
  }, ({ label, cwd, notes }) => service.addCurrentButlerSession({ label, cwd, notes }));

  registerJsonTool(server, "butler_sessions", {
    description: "List Butler-managed existing local sessions.",
    inputSchema: {
      role: z.enum(SESSION_ROLES).optional()
    }
  }, ({ role }) => service.listSessions({ role }));

  registerJsonTool(server, "butler_probe_session", {
    description: "Send a minimal turn to a managed session to verify current transport reachability.",
    inputSchema: {
      sessionIdOrThreadId: z.string().min(1)
    }
  }, ({ sessionIdOrThreadId }) => service.probeSession({ sessionIdOrThreadId }));

  registerJsonTool(server, "butler_probe_sessions", {
    description: "Probe every registered session and record current transport reachability.",
    inputSchema: {}
  }, () => service.probeAllSessions());

  registerJsonTool(server, "butler_status", {
    description: "Read Butler goals, tasks, states, and data location.",
    inputSchema: {}
  }, () => service.status());

  registerJsonTool(server, "butler_dashboard", {
    description: "Render a human-readable Butler dashboard with active goals, tasks, and recent events.",
    inputSchema: {}
  }, () => service.dashboard());

  registerJsonTool(server, "butler_daemon_status", {
    description: "Read the Butler daemon process status.",
    inputSchema: {}
  }, () => service.daemonStatus());

  registerJsonTool(server, "butler_daemon_start", {
    description: "Start the long-running Butler daemon process.",
    inputSchema: {}
  }, () => service.startDaemon());

  registerJsonTool(server, "butler_daemon_stop", {
    description: "Stop the long-running Butler daemon process.",
    inputSchema: {}
  }, () => service.stopDaemon());

  registerJsonTool(server, "butler_read_ledger", {
    description: "Read append-only Butler event ledger entries.",
    inputSchema: {}
  }, () => service.readLedger());

  return server;
}

function registerJsonTool(server, name, config, handler) {
  server.registerTool(name, config, async (args) => {
    const result = await handler(args);
    const structuredContent = Array.isArray(result) ? { items: result } : result;
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent
    };
  });
}

async function main() {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error("codex-butler MCP server running on stdio");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
