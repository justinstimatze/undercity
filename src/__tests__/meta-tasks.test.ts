/**
 * Tests for meta-tasks.ts
 *
 * Tests meta-task detection, type extraction, prompt generation,
 * and result parsing.
 */

import { describe, expect, it } from "vitest";
import {
	getMetaTaskPrompt,
	getMetaTaskType,
	isMetaTask,
	META_TASK_PROMPTS,
	parseMetaTaskResult,
} from "../meta-tasks.js";

describe("meta-tasks", () => {
	describe("isMetaTask", () => {
		it("detects [meta:triage] prefix", () => {
			expect(isMetaTask("[meta:triage] Analyze task board")).toBe(true);
		});

		it("detects [meta:prune] prefix", () => {
			expect(isMetaTask("[meta:prune] Remove stale tasks")).toBe(true);
		});

		it("detects [meta:plan] prefix", () => {
			expect(isMetaTask("[meta:plan] Break down feature X")).toBe(true);
		});

		it("detects [meta:prioritize] prefix", () => {
			expect(isMetaTask("[meta:prioritize] Reorder task board")).toBe(true);
		});

		it("detects [meta:generate] prefix", () => {
			expect(isMetaTask("[meta:generate] Find improvement tasks")).toBe(true);
		});

		it("is case-insensitive", () => {
			expect(isMetaTask("[META:TRIAGE] uppercase")).toBe(true);
			expect(isMetaTask("[Meta:Triage] mixed case")).toBe(true);
		});

		it("returns false for non-meta tasks", () => {
			expect(isMetaTask("Fix bug in task.ts")).toBe(false);
			expect(isMetaTask("[plan] Add feature")).toBe(false);
			expect(isMetaTask("meta:triage without brackets")).toBe(false);
		});

		it("returns false for partial meta prefixes", () => {
			expect(isMetaTask("[meta:] empty type")).toBe(false);
			expect(isMetaTask("[meta:unknown] unknown type")).toBe(false);
		});

		it("requires prefix at start of string", () => {
			expect(isMetaTask("Some text [meta:triage] in middle")).toBe(false);
		});
	});

	describe("getMetaTaskType", () => {
		it("extracts triage type", () => {
			expect(getMetaTaskType("[meta:triage] Analyze board")).toBe("triage");
		});

		it("extracts prune type", () => {
			expect(getMetaTaskType("[meta:prune] Clean up")).toBe("prune");
		});

		it("extracts plan type", () => {
			expect(getMetaTaskType("[meta:plan] Decompose")).toBe("plan");
		});

		it("extracts prioritize type", () => {
			expect(getMetaTaskType("[meta:prioritize] Reorder")).toBe("prioritize");
		});

		it("extracts generate type", () => {
			expect(getMetaTaskType("[meta:generate] Find tasks")).toBe("generate");
		});

		it("returns lowercase type regardless of input case", () => {
			expect(getMetaTaskType("[META:TRIAGE] uppercase")).toBe("triage");
			expect(getMetaTaskType("[Meta:Plan] mixed")).toBe("plan");
		});

		it("returns null for non-meta tasks", () => {
			expect(getMetaTaskType("Regular task")).toBeNull();
			expect(getMetaTaskType("[plan] Plan prefix")).toBeNull();
		});

		it("returns null for invalid meta types", () => {
			expect(getMetaTaskType("[meta:invalid] unknown")).toBeNull();
			expect(getMetaTaskType("[meta:] empty")).toBeNull();
		});
	});

	describe("getMetaTaskPrompt", () => {
		it("returns triage prompt for triage type", () => {
			const prompt = getMetaTaskPrompt("triage");
			expect(prompt).toContain("analyzing a task board for health issues");
			expect(prompt).toContain("TEST CRUFT");
			expect(prompt).toContain("DUPLICATES");
		});

		it("returns prune prompt for prune type", () => {
			const prompt = getMetaTaskPrompt("prune");
			expect(prompt).toContain("cleaning up a task board");
			expect(prompt).toContain("TEST ARTIFACTS");
			expect(prompt).toContain("ABANDONED TASKS");
		});

		it("returns prioritize prompt for prioritize type", () => {
			const prompt = getMetaTaskPrompt("prioritize");
			expect(prompt).toContain("priority adjustments");
			expect(prompt).toContain("BLOCKING TASKS");
			expect(prompt).toContain("Priority scale");
		});

		it("returns generate prompt for generate type", () => {
			const prompt = getMetaTaskPrompt("generate");
			expect(prompt).toContain("generate improvement tasks");
			expect(prompt).toContain("CODE QUALITY");
			expect(prompt).toContain("TESTING GAPS");
		});

		it("returns plan prompt for plan type", () => {
			const prompt = getMetaTaskPrompt("plan");
			expect(prompt).toContain("decomposing a high-level objective");
			expect(prompt).toContain("atomic, implementable tasks");
		});

		it("returns empty string for unknown type", () => {
			// @ts-expect-error - Testing invalid input
			const prompt = getMetaTaskPrompt("unknown");
			expect(prompt).toBe("");
		});
	});

	describe("META_TASK_PROMPTS constant", () => {
		it("exports all prompt types", () => {
			expect(META_TASK_PROMPTS.triage).toBeTruthy();
			expect(META_TASK_PROMPTS.prune).toBeTruthy();
			expect(META_TASK_PROMPTS.prioritize).toBeTruthy();
			expect(META_TASK_PROMPTS.generate).toBeTruthy();
			expect(META_TASK_PROMPTS.plan).toBeTruthy();
		});

		it("prompts contain JSON examples", () => {
			for (const prompt of Object.values(META_TASK_PROMPTS)) {
				expect(prompt).toContain("```json");
				expect(prompt).toContain("recommendations");
			}
		});
	});

	describe("parseMetaTaskResult", () => {
		describe("with JSON in code block", () => {
			it("parses valid JSON with recommendations array", () => {
				const output = `Some text before
\`\`\`json
{
  "summary": "Found 2 issues",
  "recommendations": [
    {"action": "remove", "taskId": "task-1", "reason": "Test task", "confidence": 0.95}
  ],
  "metrics": {"healthScore": 85}
}
\`\`\`
Some text after`;

				const result = parseMetaTaskResult(output, "triage");

				expect(result).not.toBeNull();
				expect(result?.metaTaskType).toBe("triage");
				expect(result?.summary).toBe("Found 2 issues");
				expect(result?.recommendations).toHaveLength(1);
				expect(result?.recommendations[0].action).toBe("remove");
				expect(result?.metrics?.healthScore).toBe(85);
			});

			it("handles multiline JSON in code block", () => {
				const output = `\`\`\`json
{
  "summary": "Analysis complete",
  "recommendations": [
    {
      "action": "merge",
      "taskId": "task-a",
      "relatedTaskIds": ["task-b"],
      "reason": "Duplicates",
      "confidence": 0.9
    },
    {
      "action": "remove",
      "taskId": "task-c",
      "reason": "Test artifact",
      "confidence": 0.95
    }
  ]
}
\`\`\``;

				const result = parseMetaTaskResult(output, "prune");

				expect(result?.recommendations).toHaveLength(2);
				expect(result?.recommendations[0].action).toBe("merge");
				expect(result?.recommendations[1].action).toBe("remove");
			});

			it("provides default summary when missing", () => {
				const output = `\`\`\`json
{"recommendations": []}
\`\`\``;

				const result = parseMetaTaskResult(output, "plan");

				expect(result?.summary).toBe("No summary provided");
			});
		});

		describe("with raw JSON", () => {
			it("parses raw JSON without code block", () => {
				const output = JSON.stringify({
					summary: "Direct JSON",
					recommendations: [{ action: "add", reason: "New task", confidence: 0.85 }],
				});

				const result = parseMetaTaskResult(output, "generate");

				expect(result).not.toBeNull();
				expect(result?.summary).toBe("Direct JSON");
				expect(result?.recommendations).toHaveLength(1);
			});
		});

		describe("error handling", () => {
			it("returns null for invalid JSON", () => {
				const output = "This is not JSON at all";
				expect(parseMetaTaskResult(output, "triage")).toBeNull();
			});

			it("returns null for JSON without recommendations array", () => {
				const output = `\`\`\`json
{"summary": "No recommendations key"}
\`\`\``;
				expect(parseMetaTaskResult(output, "prune")).toBeNull();
			});

			it("returns null when recommendations is not an array", () => {
				const output = `\`\`\`json
{"recommendations": "not an array"}
\`\`\``;
				expect(parseMetaTaskResult(output, "plan")).toBeNull();
			});

			it("returns null for malformed JSON in code block", () => {
				const output = `\`\`\`json
{invalid json here}
\`\`\``;
				expect(parseMetaTaskResult(output, "triage")).toBeNull();
			});

			it("returns null for empty output", () => {
				expect(parseMetaTaskResult("", "triage")).toBeNull();
			});
		});

		describe("meta task type passthrough", () => {
			it("passes through triage type", () => {
				const output = `\`\`\`json
{"recommendations": []}
\`\`\``;
				expect(parseMetaTaskResult(output, "triage")?.metaTaskType).toBe("triage");
			});

			it("passes through prune type", () => {
				const output = `\`\`\`json
{"recommendations": []}
\`\`\``;
				expect(parseMetaTaskResult(output, "prune")?.metaTaskType).toBe("prune");
			});

			it("passes through generate type", () => {
				const output = `\`\`\`json
{"recommendations": []}
\`\`\``;
				expect(parseMetaTaskResult(output, "generate")?.metaTaskType).toBe("generate");
			});
		});

		describe("metrics handling", () => {
			it("includes metrics when present", () => {
				const output = `\`\`\`json
{
  "recommendations": [],
  "metrics": {
    "healthScore": 92,
    "issuesFound": 3,
    "tasksAnalyzed": 50
  }
}
\`\`\``;

				const result = parseMetaTaskResult(output, "triage");

				expect(result?.metrics).toEqual({
					healthScore: 92,
					issuesFound: 3,
					tasksAnalyzed: 50,
				});
			});

			it("handles missing metrics gracefully", () => {
				const output = `\`\`\`json
{"recommendations": [], "summary": "No metrics"}
\`\`\``;

				const result = parseMetaTaskResult(output, "triage");

				expect(result?.metrics).toBeUndefined();
			});
		});
	});

	describe("recommendation action types", () => {
		it("triage prompt documents remove action", () => {
			expect(META_TASK_PROMPTS.triage).toContain('"action": "remove"');
		});

		it("triage prompt documents merge action", () => {
			expect(META_TASK_PROMPTS.triage).toContain('"action": "merge"');
		});

		it("triage prompt documents fix_status action", () => {
			expect(META_TASK_PROMPTS.triage).toContain('"action": "fix_status"');
		});

		it("prioritize prompt documents prioritize action", () => {
			expect(META_TASK_PROMPTS.prioritize).toContain('"action": "prioritize"');
		});

		it("generate prompt documents add action", () => {
			expect(META_TASK_PROMPTS.generate).toContain('"action": "add"');
		});
	});

	describe("confidence scoring documentation", () => {
		it("triage prompt specifies confidence thresholds", () => {
			const prompt = META_TASK_PROMPTS.triage;
			expect(prompt).toContain("confidence >= 0.8");
			expect(prompt).toContain("0.9-0.95");
			expect(prompt).toContain("0.8-0.9");
		});
	});
});
