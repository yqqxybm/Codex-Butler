import { homedir } from "node:os";
import { join } from "node:path";

export const EVIDENCE_LEVELS = Object.freeze([
  "declared",
  "prompt-constrained",
  "transcript-supported",
  "externally-verified"
]);

export const ROLE_CONTRACTS = Object.freeze({
  "butler-controller": {
    requiredSkill: "project-lifecycle",
    forbidden: [
      "edit_project_files_directly",
      "promote_changes_directly",
      "claim_worker_result_without_validation"
    ]
  },
  "iteration-worker": {
    requiredSkill: "project-iteration",
    forbidden: [
      "ask_user_directly",
      "edit_main_workspace",
      "promote_changes",
      "claim_unverified_success"
    ]
  },
  "review-worker": {
    requiredSkill: "review",
    forbidden: [
      "edit_files",
      "commit_changes",
      "promote_changes",
      "call_focused_review_deep"
    ]
  },
  "analysis-worker": {
    requiredSkill: "project-analysis",
    forbidden: [
      "edit_files",
      "commit_changes",
      "skip_calibration_when_required"
    ]
  },
  "refine-worker": {
    requiredSkill: "project-refine",
    forbidden: [
      "edit_code",
      "change_project_scope",
      "invent_project_facts"
    ]
  },
  verifier: {
    requiredSkill: null,
    forbidden: [
      "trust_worker_self_report",
      "skip_command_evidence"
    ]
  },
  promoter: {
    requiredSkill: null,
    forbidden: [
      "model_freeform_main_workspace_write",
      "promote_without_review",
      "promote_without_verification"
    ]
  }
});

export const WORKER_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["status", "evidence", "risks"],
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["done", "needs_rework", "blocked"]
    },
    summary: { type: "string" },
    evidence: {
      type: "object",
      required: ["skill_read", "files_changed", "commands_run"],
      additionalProperties: false,
      properties: {
        skill_read: {
          type: "string",
          enum: EVIDENCE_LEVELS
        },
        files_changed: {
          type: "array",
          items: { type: "string" }
        },
        commands_run: {
          type: "array",
          items: { type: "string" }
        }
      }
    },
    risks: {
      type: "array",
      items: { type: "string" }
    }
  }
});

export function buildWorkOrder({ role, taskId, goal, ownedScope, objective, targetTaskId = null }) {
  const contract = ROLE_CONTRACTS[role];
  if (!contract) throw new Error(`Unknown role: ${role}`);
  return {
    role,
    taskId,
    targetTaskId,
    goal,
    objective,
    ownedScope,
    requiredSkill: contract.requiredSkill,
    requiredSkillPath: contract.requiredSkill ? skillPath(contract.requiredSkill) : null,
    forbidden: contract.forbidden,
    outputSchema: WORKER_OUTPUT_SCHEMA
  };
}

export function validateWorkerResult(workOrder, result) {
  const errors = [];
  if (!["done", "needs_rework", "blocked"].includes(result?.status)) {
    errors.push("status must be done, needs_rework, or blocked");
  }
  if (!EVIDENCE_LEVELS.includes(result?.evidence?.skill_read)) {
    errors.push("evidence.skill_read must be a known evidence level");
  }
  if (workOrder.requiredSkill && !workOrder.requiredSkillLoaded && result?.evidence?.skill_read !== "externally-verified") {
    errors.push(`required skill ${workOrder.requiredSkill} is not externally verified`);
  }
  if (!Array.isArray(result?.evidence?.files_changed)) {
    errors.push("evidence.files_changed must be an array");
  }
  if (!Array.isArray(result?.evidence?.commands_run)) {
    errors.push("evidence.commands_run must be an array");
  }
  if (!Array.isArray(result?.risks)) {
    errors.push("risks must be an array");
  }
  return {
    ok: errors.length === 0,
    errors
  };
}

function skillPath(skillName) {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(codexHome, "skills", skillName, "SKILL.md");
}
