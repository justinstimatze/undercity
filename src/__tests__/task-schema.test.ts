/**
 * Tests for task-schema.ts
 *
 * Tests meta-task detection, type extraction, and result parsing.
 */

import { describe, expect, it } from "vitest";
import {
	extractMetaTaskType,
	extractTaskCategory,
	getTaskType,
	isMetaTask,
	isPlanTask,
	parseMetaTaskResult,
} from "../task-schema.js";

describe("task-schema", () => {
	describe("getTaskType", () => {
		it("should return 'meta' for [meta:triage] prefix", () => {
			expect(getTaskType("[meta:triage] Clean up the task board")).toBe("meta");
		});

		it("should return 'meta' for [meta:prune] prefix", () => {
			expect(getTaskType("[meta:prune] Remove test cruft")).toBe("meta");
		});

		it("should return 'meta' for [meta:plan] prefix", () => {
			expect(getTaskType("[meta:plan] Plan the feature implementation")).toBe("meta");
		});

		it("should return 'meta' for [meta:prioritize] prefix", () => {
			expect(getTaskType("[meta:prioritize] Reorder tasks by urgency")).toBe("meta");
		});

		it("should return 'meta' for [meta:generate] prefix", () => {
			expect(getTaskType("[meta:generate] Find improvement opportunities")).toBe("meta");
		});

		it("should return 'meta' for [plan] prefix (shorthand)", () => {
			expect(getTaskType("[plan] Implement user authentication")).toBe("meta");
		});

		it("should return 'implementation' for regular tasks", () => {
			expect(getTaskType("Fix the login bug")).toBe("implementation");
		});

		it("should return 'implementation' for [refactor] prefix", () => {
			expect(getTaskType("[refactor] Clean up the worker module")).toBe("implementation");
		});

		it("should return 'implementation' for [test] prefix", () => {
			expect(getTaskType("[test] Add tests for task-schema")).toBe("implementation");
		});

		it("should be case-insensitive for meta prefixes", () => {
			expect(getTaskType("[META:TRIAGE] Clean up")).toBe("meta");
			expect(getTaskType("[Meta:Prune] Remove cruft")).toBe("meta");
			expect(getTaskType("[PLAN] Big feature")).toBe("meta");
		});
	});

	describe("isMetaTask", () => {
		it("should return true for meta-task prefixes", () => {
			expect(isMetaTask("[meta:triage] Task")).toBe(true);
			expect(isMetaTask("[meta:prune] Task")).toBe(true);
			expect(isMetaTask("[plan] Task")).toBe(true);
		});

		it("should return false for implementation tasks", () => {
			expect(isMetaTask("Fix bug")).toBe(false);
			expect(isMetaTask("[refactor] Clean up")).toBe(false);
			expect(isMetaTask("[test] Add tests")).toBe(false);
		});
	});

	describe("extractMetaTaskType", () => {
		it("should extract triage from [meta:triage]", () => {
			expect(extractMetaTaskType("[meta:triage] Clean up")).toBe("triage");
		});

		it("should extract prune from [meta:prune]", () => {
			expect(extractMetaTaskType("[meta:prune] Remove cruft")).toBe("prune");
		});

		it("should extract plan from [meta:plan]", () => {
			expect(extractMetaTaskType("[meta:plan] Plan feature")).toBe("plan");
		});

		it("should extract plan from [plan] shorthand", () => {
			expect(extractMetaTaskType("[plan] Plan feature")).toBe("plan");
		});

		it("should extract prioritize from [meta:prioritize]", () => {
			expect(extractMetaTaskType("[meta:prioritize] Reorder")).toBe("prioritize");
		});

		it("should extract generate from [meta:generate]", () => {
			expect(extractMetaTaskType("[meta:generate] Find issues")).toBe("generate");
		});

		it("should return null for non-meta tasks", () => {
			expect(extractMetaTaskType("Fix bug")).toBeNull();
			expect(extractMetaTaskType("[refactor] Clean up")).toBeNull();
		});

		it("should return null for invalid meta types", () => {
			expect(extractMetaTaskType("[meta:invalid] Task")).toBeNull();
			expect(extractMetaTaskType("[meta:foo] Task")).toBeNull();
		});

		it("should be case-insensitive", () => {
			expect(extractMetaTaskType("[META:TRIAGE] Task")).toBe("triage");
			expect(extractMetaTaskType("[Meta:Prune] Task")).toBe("prune");
		});
	});

	describe("isPlanTask", () => {
		it("should return true for [plan] prefix", () => {
			expect(isPlanTask("[plan] Implement feature")).toBe(true);
		});

		it("should return true for [meta:plan] prefix", () => {
			expect(isPlanTask("[meta:plan] Implement feature")).toBe(true);
		});

		it("should return false for other meta tasks", () => {
			expect(isPlanTask("[meta:triage] Clean up")).toBe(false);
			expect(isPlanTask("[meta:prune] Remove")).toBe(false);
		});

		it("should return false for regular tasks", () => {
			expect(isPlanTask("Fix bug")).toBe(false);
		});
	});

	describe("extractTaskCategory", () => {
		it("should extract meta:triage category", () => {
			expect(extractTaskCategory("[meta:triage] Clean up")).toBe("meta:triage");
		});

		it("should extract refactor category", () => {
			expect(extractTaskCategory("[refactor] Clean up code")).toBe("refactor");
		});

		it("should extract test category", () => {
			expect(extractTaskCategory("[test] Add tests")).toBe("test");
		});

		it("should return null for unknown categories", () => {
			expect(extractTaskCategory("[unknown] Task")).toBeNull();
		});

		it("should return null for no bracket prefix", () => {
			expect(extractTaskCategory("Fix bug")).toBeNull();
		});

		it("should be case-insensitive", () => {
			expect(extractTaskCategory("[REFACTOR] Clean up")).toBe("refactor");
			expect(extractTaskCategory("[Test] Add tests")).toBe("test");
		});
	});

	describe("parseMetaTaskResult", () => {
		it("should parse valid JSON with recommendations", () => {
			const output = `
				Here's my analysis:
				\`\`\`json
				{
					"summary": "Found 3 issues",
					"recommendations": [
						{
							"action": "remove",
							"taskId": "task-123",
							"reason": "Test artifact",
							"confidence": 0.95
						}
					]
				}
				\`\`\`
			`;

			const result = parseMetaTaskResult(output, "triage");

			expect(result).not.toBeNull();
			expect(result?.metaTaskType).toBe("triage");
			expect(result?.summary).toBe("Found 3 issues");
			expect(result?.recommendations).toHaveLength(1);
			expect(result?.recommendations[0].action).toBe("remove");
			expect(result?.recommendations[0].taskId).toBe("task-123");
		});

		it("should parse JSON without code fence", () => {
			const output = `{
				"summary": "Analysis complete",
				"recommendations": [
					{
						"action": "add",
						"reason": "Missing test",
						"confidence": 0.9,
						"newTask": {
							"objective": "Add test for widget"
						}
					}
				]
			}`;

			const result = parseMetaTaskResult(output, "generate");

			expect(result).not.toBeNull();
			expect(result?.metaTaskType).toBe("generate");
			expect(result?.recommendations[0].action).toBe("add");
		});

		it("should reject invalid action types", () => {
			const output = `{
				"summary": "Bad action",
				"recommendations": [
					{
						"action": "explode",
						"taskId": "task-123",
						"reason": "Invalid",
						"confidence": 0.9
					}
				]
			}`;

			const result = parseMetaTaskResult(output, "triage");
			expect(result).toBeNull();
		});

		it("should reject missing reason", () => {
			const output = `{
				"summary": "No reason",
				"recommendations": [
					{
						"action": "remove",
						"taskId": "task-123",
						"confidence": 0.9
					}
				]
			}`;

			const result = parseMetaTaskResult(output, "triage");
			expect(result).toBeNull();
		});

		it("should reject invalid confidence scores", () => {
			const output = `{
				"summary": "Bad confidence",
				"recommendations": [
					{
						"action": "remove",
						"taskId": "task-123",
						"reason": "Test",
						"confidence": 1.5
					}
				]
			}`;

			const result = parseMetaTaskResult(output, "triage");
			expect(result).toBeNull();
		});

		it("should reject negative confidence scores", () => {
			const output = `{
				"recommendations": [
					{
						"action": "remove",
						"taskId": "task-123",
						"reason": "Test",
						"confidence": -0.5
					}
				]
			}`;

			const result = parseMetaTaskResult(output, "triage");
			expect(result).toBeNull();
		});

		it("should return null for invalid JSON", () => {
			const output = "This is not JSON at all";
			const result = parseMetaTaskResult(output, "triage");
			expect(result).toBeNull();
		});

		it("should return null for missing recommendations array", () => {
			const output = `{ "summary": "No recommendations" }`;
			const result = parseMetaTaskResult(output, "triage");
			expect(result).toBeNull();
		});

		it("should use default summary if not provided", () => {
			const output = `{
				"recommendations": [
					{
						"action": "remove",
						"taskId": "task-123",
						"reason": "Test",
						"confidence": 0.9
					}
				]
			}`;

			const result = parseMetaTaskResult(output, "triage");
			expect(result?.summary).toBe("No summary provided");
		});

		it("should parse metrics if provided", () => {
			const output = `{
				"summary": "Analysis",
				"recommendations": [],
				"metrics": {
					"healthScore": 85,
					"issuesFound": 5,
					"tasksAnalyzed": 50
				}
			}`;

			const result = parseMetaTaskResult(output, "triage");
			expect(result?.metrics?.healthScore).toBe(85);
			expect(result?.metrics?.issuesFound).toBe(5);
		});

		it("should accept valid action types", () => {
			const validActions = [
				"remove",
				"complete",
				"fix_status",
				"merge",
				"add",
				"update",
				"prioritize",
				"decompose",
				"block",
				"unblock",
			];

			for (const action of validActions) {
				const output = `{
					"recommendations": [{
						"action": "${action}",
						"taskId": "task-123",
						"reason": "Test",
						"confidence": 0.9
					}]
				}`;

				const result = parseMetaTaskResult(output, "triage");
				expect(result).not.toBeNull();
				expect(result?.recommendations[0].action).toBe(action);
			}
		});
	});
});
