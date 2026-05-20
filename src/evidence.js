const EVIDENCE_STRENGTH = Object.freeze({
  declared: 0,
  "prompt-constrained": 1,
  "transcript-supported": 2,
  "externally-verified": 3
});

export function extractSkillReadEvidence(options = {}) {
  const requiredSkill = options.requiredSkill;
  if (!requiredSkill) {
    return { level: "externally-verified", reason: "no required skill" };
  }

  const promptText = options.promptText ?? "";
  const finalText = options.finalText ?? "";
  const notifications = options.notifications ?? [];
  const externalRecords = notifications
    .filter((notification) => looksLikeToolOrCommand(notification))
    .map((notification) => JSON.stringify(notification));
  const allTranscript = [
    finalText,
    ...notifications.map((notification) => JSON.stringify(notification))
  ].join("\n");

  if (externalRecords.some((record) => referencesSkill(record, requiredSkill) && looksSuccessful(record))) {
    return { level: "externally-verified", reason: "successful transcript command/tool record references required SKILL.md" };
  }
  if (referencesSkill(allTranscript, requiredSkill)) {
    return { level: "transcript-supported", reason: "transcript references required SKILL.md without external success evidence" };
  }
  if (promptText.includes(requiredSkill)) {
    return { level: "prompt-constrained", reason: "worker prompt required the skill" };
  }
  return { level: "declared", reason: "no transcript evidence found" };
}

export function applyTranscriptEvidence(result, transcriptEvidence) {
  if (!result?.evidence) return result;
  const current = result.evidence.skill_read ?? "declared";
  const next = strongestEvidence(current, transcriptEvidence?.level ?? "declared");
  return {
    ...result,
    evidence: {
      ...result.evidence,
      skill_read: next
    }
  };
}

export function strongestEvidence(left, right) {
  return EVIDENCE_STRENGTH[right] > EVIDENCE_STRENGTH[left] ? right : left;
}

function referencesSkill(text, requiredSkill) {
  const normalized = String(text).toLowerCase();
  const skill = String(requiredSkill).toLowerCase();
  return normalized.includes("skill.md")
    && (normalized.includes(`/skills/${skill}/`)
      || normalized.includes(`skills/${skill}/`)
      || normalized.includes(`/${skill}/skill.md`)
      || normalized.includes(`${skill}/skill.md`));
}

function looksLikeToolOrCommand(notification) {
  const text = JSON.stringify(notification).toLowerCase();
  return text.includes("command")
    || text.includes("exec")
    || text.includes("tool")
    || text.includes("stdout")
    || text.includes("stderr");
}

function looksSuccessful(text) {
  return /"exitcode"\s*:\s*0/i.test(text)
    || /"status"\s*:\s*"completed"/i.test(text)
    || /"ok"\s*:\s*true/i.test(text);
}
