/**
 * Tests for orchestrator/conflict-detection.ts
 *
 * Pure functions for detecting file conflicts between parallel tasks.
 */

import { describe, expect, it } from "vitest";
import {
	buildPredictedConflicts,
	CONFLICT_PRONE_PATHS,
	detectFileConflicts,
	isConflictPronePath,
	type TaskWithModifiedFiles,
} from "../orchestrator/conflict-detection.js";

describe("orchestrator/conflict-detection", () => {
	describe("detectFileConflicts", () => {
		it("returns empty map when no tasks", () => {
			const result = detectFileConflicts([]);
			expect(result.size).toBe(0);
		});

		it("returns empty map when single task", () => {
			const tasks: TaskWithModifiedFiles[] = [
				{ taskId: "task-1", modifiedFiles: ["file1.ts", "file2.ts"] },
			];
			const result = detectFileConflicts(tasks);
			expect(result.size).toBe(0);
		});

		it("returns empty map when tasks modify different files", () => {
			const tasks: TaskWithModifiedFiles[] = [
				{ taskId: "task-1", modifiedFiles: ["file1.ts"] },
				{ taskId: "task-2", modifiedFiles: ["file2.ts"] },
			];
			const result = detectFileConflicts(tasks);
			expect(result.size).toBe(0);
		});

		it("detects conflict when two tasks modify same file", () => {
			const tasks: TaskWithModifiedFiles[] = [
				{ taskId: "task-1", modifiedFiles: ["shared.ts"] },
				{ taskId: "task-2", modifiedFiles: ["shared.ts"] },
			];
			const result = detectFileConflicts(tasks);

			expect(result.size).toBe(1);
			expect(result.get("shared.ts")).toEqual(["task-1", "task-2"]);
		});

		it("detects conflict when three tasks modify same file", () => {
			const tasks: TaskWithModifiedFiles[] = [
				{ taskId: "task-1", modifiedFiles: ["shared.ts"] },
				{ taskId: "task-2", modifiedFiles: ["shared.ts"] },
				{ taskId: "task-3", modifiedFiles: ["shared.ts"] },
			];
			const result = detectFileConflicts(tasks);

			expect(result.get("shared.ts")).toEqual(["task-1", "task-2", "task-3"]);
		});

		it("detects multiple conflicts across different files", () => {
			const tasks: TaskWithModifiedFiles[] = [
				{ taskId: "task-1", modifiedFiles: ["a.ts", "b.ts"] },
				{ taskId: "task-2", modifiedFiles: ["a.ts", "c.ts"] },
				{ taskId: "task-3", modifiedFiles: ["b.ts", "c.ts"] },
			];
			const result = detectFileConflicts(tasks);

			expect(result.size).toBe(3);
			expect(result.get("a.ts")).toEqual(["task-1", "task-2"]);
			expect(result.get("b.ts")).toEqual(["task-1", "task-3"]);
			expect(result.get("c.ts")).toEqual(["task-2", "task-3"]);
		});

		it("ignores tasks without modifiedFiles", () => {
			const tasks: TaskWithModifiedFiles[] = [
				{ taskId: "task-1", modifiedFiles: ["shared.ts"] },
				{ taskId: "task-2" }, // No modifiedFiles
			];
			const result = detectFileConflicts(tasks);
			expect(result.size).toBe(0);
		});

		it("ignores tasks with empty modifiedFiles array", () => {
			const tasks: TaskWithModifiedFiles[] = [
				{ taskId: "task-1", modifiedFiles: ["shared.ts"] },
				{ taskId: "task-2", modifiedFiles: [] },
			];
			const result = detectFileConflicts(tasks);
			expect(result.size).toBe(0);
		});
	});

	describe("isConflictPronePath", () => {
		it("returns true for .claude/rules/ paths", () => {
			expect(isConflictPronePath(".claude/rules/00-critical.md")).toBe(true);
		});

		it("returns true for .claude/ paths", () => {
			expect(isConflictPronePath(".claude/settings.json")).toBe(true);
		});

		it("returns true for docs/ paths", () => {
			expect(isConflictPronePath("docs/api.md")).toBe(true);
		});

		it("returns true for ARCHITECTURE.md", () => {
			expect(isConflictPronePath("ARCHITECTURE.md")).toBe(true);
		});

		it("returns true for README.md", () => {
			expect(isConflictPronePath("README.md")).toBe(true);
		});

		it("returns false for regular source files", () => {
			expect(isConflictPronePath("src/task.ts")).toBe(false);
		});

		it("returns false for test files", () => {
			expect(isConflictPronePath("src/__tests__/task.test.ts")).toBe(false);
		});

		it("matches paths containing conflict-prone patterns anywhere", () => {
			expect(isConflictPronePath("project/.claude/config.json")).toBe(true);
		});
	});

	describe("CONFLICT_PRONE_PATHS", () => {
		it("includes expected paths", () => {
			expect(CONFLICT_PRONE_PATHS).toContain(".claude/rules/");
			expect(CONFLICT_PRONE_PATHS).toContain(".claude/");
			expect(CONFLICT_PRONE_PATHS).toContain("docs/");
			expect(CONFLICT_PRONE_PATHS).toContain("ARCHITECTURE.md");
			expect(CONFLICT_PRONE_PATHS).toContain("README.md");
		});
	});

	describe("buildPredictedConflicts", () => {
		it("returns empty array when no overlapping files", () => {
			const predictions = new Map<string, string[]>([
				["task-1", ["a.ts"]],
				["task-2", ["b.ts"]],
			]);
			const objectives = new Map<string, string>();

			const result = buildPredictedConflicts(predictions, objectives);
			expect(result).toEqual([]);
		});

		it("detects predicted conflicts", () => {
			const predictions = new Map<string, string[]>([
				["task-1", ["shared.ts"]],
				["task-2", ["shared.ts"]],
			]);
			const objectives = new Map<string, string>([
				["task-1", "Fix bug in shared module"],
				["task-2", "Add feature to shared module"],
			]);

			const result = buildPredictedConflicts(predictions, objectives);

			expect(result).toHaveLength(1);
			expect(result[0].file).toBe("shared.ts");
			expect(result[0].tasks).toHaveLength(2);
		});

		it("assigns warning severity to normal files", () => {
			const predictions = new Map<string, string[]>([
				["task-1", ["src/utils.ts"]],
				["task-2", ["src/utils.ts"]],
			]);
			const objectives = new Map<string, string>();

			const result = buildPredictedConflicts(predictions, objectives);
			expect(result[0].severity).toBe("warning");
		});

		it("assigns error severity to conflict-prone paths", () => {
			const predictions = new Map<string, string[]>([
				["task-1", [".claude/rules/00-critical.md"]],
				["task-2", [".claude/rules/00-critical.md"]],
			]);
			const objectives = new Map<string, string>();

			const result = buildPredictedConflicts(predictions, objectives);
			expect(result[0].severity).toBe("error");
		});

		it("truncates long task objectives to 50 chars", () => {
			const predictions = new Map<string, string[]>([
				["task-1", ["file.ts"]],
				["task-2", ["file.ts"]],
			]);
			const longObjective = "A".repeat(100);
			const objectives = new Map<string, string>([
				["task-1", longObjective],
				["task-2", "short"],
			]);

			const result = buildPredictedConflicts(predictions, objectives);

			expect(result[0].tasks[0]).toBe("A".repeat(50));
			expect(result[0].tasks[1]).toBe("short");
		});

		it("uses task ID when objective not found", () => {
			const predictions = new Map<string, string[]>([
				["task-1", ["file.ts"]],
				["task-2", ["file.ts"]],
			]);
			const objectives = new Map<string, string>(); // Empty objectives

			const result = buildPredictedConflicts(predictions, objectives);

			expect(result[0].tasks).toContain("task-1");
			expect(result[0].tasks).toContain("task-2");
		});

		it("handles multiple predicted conflicts", () => {
			const predictions = new Map<string, string[]>([
				["task-1", ["a.ts", "b.ts"]],
				["task-2", ["a.ts"]],
				["task-3", ["b.ts"]],
			]);
			const objectives = new Map<string, string>();

			const result = buildPredictedConflicts(predictions, objectives);

			expect(result).toHaveLength(2);
			const files = result.map((r) => r.file);
			expect(files).toContain("a.ts");
			expect(files).toContain("b.ts");
		});
	});
});
