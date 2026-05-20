import test from "node:test";
import assert from "node:assert/strict";
import { applyTranscriptEvidence, extractSkillReadEvidence } from "../src/evidence.js";

test("extractor verifies skill reads from successful command transcript records", () => {
  const evidence = extractSkillReadEvidence({
    requiredSkill: "review",
    promptText: "requiredSkill: review",
    notifications: [{
      method: "item/completed",
      params: {
        item: {
          type: "command_execution",
          command: "sed -n '1,120p' /Users/wangzhiwen/.codex/skills/review/SKILL.md",
          exitCode: 0
        }
      }
    }]
  });

  assert.equal(evidence.level, "externally-verified");
});

test("extractor does not treat a model claim as external verification", () => {
  const evidence = extractSkillReadEvidence({
    requiredSkill: "review",
    promptText: "requiredSkill: review",
    finalText: "I read review/SKILL.md and followed it."
  });

  assert.equal(evidence.level, "transcript-supported");
});

test("transcript evidence upgrades worker result only when stronger", () => {
  const result = applyTranscriptEvidence({
    status: "done",
    evidence: {
      skill_read: "declared",
      files_changed: [],
      commands_run: []
    },
    risks: []
  }, {
    level: "externally-verified",
    reason: "command transcript"
  });

  assert.equal(result.evidence.skill_read, "externally-verified");
});
