export function compilePlan(options = {}) {
  const objective = requiredText(options.objective, "objective");
  const projectRoot = options.projectRoot ?? process.cwd();
  const ownedScope = options.ownedScope ?? projectRoot;
  const verificationCommand = options.verificationCommand ?? ["npm", "test"];
  const classification = classifyObjective(objective);
  const tasks = [];

  const add = (role, taskObjective, fields = {}) => {
    const task = {
      id: `plan-${String(tasks.length + 1).padStart(2, "0")}`,
      role,
      objective: taskObjective,
      ownedScope: fields.ownedScope ?? ownedScope,
      prerequisites: fields.prerequisites ?? [],
      verificationCommand: fields.verificationCommand ?? null,
      targetPlanItemId: fields.targetPlanItemId ?? null
    };
    tasks.push(task);
    return task;
  };

  if (classification.reviewOnly) {
    const review = add("review-worker", `Review target: ${objective}`);
    add("verifier", "Verify review evidence, inspected surfaces, and residual-risk disclosure.", {
      prerequisites: [review.id],
      verificationCommand,
      targetPlanItemId: review.id
    });
    return { objective, classification, tasks };
  }

  let previous = null;
  if (classification.needsAnalysis) {
    previous = add("analysis-worker", `Analyze implementation strategy and risk boundaries for: ${objective}`);
  }

  const implementationRole = classification.refineOnly ? "refine-worker" : "iteration-worker";
  const implementation = add(implementationRole, `Execute the requested project change: ${objective}`, {
    prerequisites: previous ? [previous.id] : []
  });
  const review = add("review-worker", `Review the completed work for: ${objective}`, {
    prerequisites: [implementation.id],
    targetPlanItemId: implementation.id
  });
  const verifier = add("verifier", "Run deterministic verification for the completed work.", {
    prerequisites: [review.id],
    verificationCommand,
    targetPlanItemId: implementation.id
  });
  add("promoter", "Promote verified changes through the deterministic promotion gate.", {
    prerequisites: [verifier.id],
    targetPlanItemId: implementation.id
  });

  return { objective, classification, tasks };
}

export function classifyObjective(objective) {
  const text = objective.toLowerCase();
  const hasReview = hasAny(text, ["review", "audit", "审查", "检查", "复核"]);
  const hasImplementation = hasAny(text, [
    "build",
    "implement",
    "fix",
    "change",
    "add",
    "create",
    "ship",
    "推进",
    "实现",
    "修",
    "改",
    "新增",
    "构建"
  ]);
  const refineOnly = hasAny(text, ["docs", "readme", "runbook", "prompt", "polish", "refine", "文档", "润色", "优化说明"])
    && !hasAny(text, ["api", "cli", "server", "worker", "daemon", "test", "code", "代码"]);
  const needsAnalysis = hasAny(text, ["architecture", "migration", "refactor", "plan", "strategy", "架构", "迁移", "重构", "方案"])
    || objective.length > 120;
  return {
    reviewOnly: hasReview && !hasImplementation,
    refineOnly,
    needsAnalysis
  };
}

function hasAny(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function requiredText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}
