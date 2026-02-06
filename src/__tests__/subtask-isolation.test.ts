/**
 * Tests for subtask isolation improvements:
 * - mergeOverlappingSubtasks (task-decomposer.ts)
 * - getSiblingTasks / getParentTask (task.ts)
 * - buildNextBatch (orchestrator.ts, tested indirectly)
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "../storage.js";
import { addTask, decomposeTaskIntoSubtasks, getParentTask, getSiblingTasks } from "../task.js";
import type { Subtask } from "../task-decomposer.js";
import { mergeOverlappingSubtasks } from "../task-decomposer.js";

describe("mergeOverlappingSubtasks", () => {
	it("should return empty array for empty input", () => {
		expect(mergeOverlappingSubtasks([])).toEqual([]);
	});

	it("should return single subtask unchanged", () => {
		const subtasks: Subtask[] = [{ objective: "Fix auth", estimatedFiles: ["src/auth.ts"], order: 1 }];
		expect(mergeOverlappingSubtasks(subtasks)).toEqual(subtasks);
	});

	it("should not merge subtasks with disjoint files", () => {
		const subtasks: Subtask[] = [
			{ objective: "In src/auth.ts, add validation", estimatedFiles: ["src/auth.ts"], order: 1 },
			{ objective: "In src/types.ts, add UserRole enum", estimatedFiles: ["src/types.ts"], order: 2 },
			{ objective: "In src/routes.ts, add middleware", estimatedFiles: ["src/routes.ts"], order: 3 },
		];
		const result = mergeOverlappingSubtasks(subtasks);
		expect(result).toHaveLength(3);
	});

	it("should merge two subtasks targeting the same file", () => {
		const subtasks: Subtask[] = [
			{ objective: "In src/auth.ts, add validation", estimatedFiles: ["src/auth.ts"], order: 1 },
			{ objective: "In src/auth.ts, add error handling", estimatedFiles: ["src/auth.ts"], order: 2 },
		];
		const result = mergeOverlappingSubtasks(subtasks);
		expect(result).toHaveLength(1);
		expect(result[0].objective).toContain("add validation");
		expect(result[0].objective).toContain("add error handling");
		expect(result[0].estimatedFiles).toEqual(["src/auth.ts"]);
		expect(result[0].order).toBe(1); // keeps lower order
	});

	it("should merge transitively (A overlaps B, B overlaps C -> merge all three)", () => {
		const subtasks: Subtask[] = [
			{ objective: "Task A", estimatedFiles: ["src/a.ts", "src/shared.ts"], order: 1 },
			{ objective: "Task B", estimatedFiles: ["src/shared.ts", "src/b.ts"], order: 2 },
			{ objective: "Task C", estimatedFiles: ["src/c.ts"], order: 3 },
		];
		const result = mergeOverlappingSubtasks(subtasks);
		expect(result).toHaveLength(2);
		// A and B merged (share src/shared.ts), C stays separate
		const mergedTask = result.find((s) => s.objective.includes("Task A"));
		expect(mergedTask?.objective).toContain("Task B");
		expect(mergedTask?.estimatedFiles).toContain("src/a.ts");
		expect(mergedTask?.estimatedFiles).toContain("src/shared.ts");
		expect(mergedTask?.estimatedFiles).toContain("src/b.ts");
	});

	it("should handle subtasks without estimatedFiles", () => {
		const subtasks: Subtask[] = [
			{ objective: "Task A", order: 1 },
			{ objective: "Task B", estimatedFiles: ["src/b.ts"], order: 2 },
		];
		const result = mergeOverlappingSubtasks(subtasks);
		// No overlap possible when files are missing
		expect(result).toHaveLength(2);
	});

	it("should be case-insensitive for file paths", () => {
		const subtasks: Subtask[] = [
			{ objective: "Task A", estimatedFiles: ["src/Auth.ts"], order: 1 },
			{ objective: "Task B", estimatedFiles: ["src/auth.ts"], order: 2 },
		];
		const result = mergeOverlappingSubtasks(subtasks);
		expect(result).toHaveLength(1);
	});

	it("should deduplicate files in merged result", () => {
		const subtasks: Subtask[] = [
			{ objective: "Task A", estimatedFiles: ["src/auth.ts", "src/types.ts"], order: 1 },
			{ objective: "Task B", estimatedFiles: ["src/auth.ts", "src/utils.ts"], order: 2 },
		];
		const result = mergeOverlappingSubtasks(subtasks);
		expect(result).toHaveLength(1);
		// Should have unique files
		const files = result[0].estimatedFiles ?? [];
		expect(new Set(files).size).toBe(files.length);
	});
});

describe("getSiblingTasks and getParentTask", () => {
	let testDir: string;
	let tasksPath: string;

	beforeEach(() => {
		resetDatabase();
		testDir = mkdtempSync(join(tmpdir(), "sibling-test-"));
		mkdirSync(join(testDir, ".undercity"), { recursive: true });
		tasksPath = join(testDir, ".undercity", "tasks.json");
	});

	afterEach(() => {
		resetDatabase();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("getSiblingTasks should return empty array for task without parent", () => {
		const task = addTask("Standalone task", undefined, tasksPath);
		const siblings = getSiblingTasks(task.id, tasksPath);
		expect(siblings).toEqual([]);
	});

	it("getSiblingTasks should return sibling subtasks", () => {
		const parent = addTask("Parent task", undefined, tasksPath);
		const subtaskIds = decomposeTaskIntoSubtasks(
			parent.id,
			[
				{ objective: "In src/a.ts, do A", estimatedFiles: ["src/a.ts"], order: 1 },
				{ objective: "In src/b.ts, do B", estimatedFiles: ["src/b.ts"], order: 2 },
				{ objective: "In src/c.ts, do C", estimatedFiles: ["src/c.ts"], order: 3 },
			],
			tasksPath,
		);

		const siblings = getSiblingTasks(subtaskIds[0], tasksPath);
		expect(siblings).toHaveLength(2);
		expect(siblings.map((s) => s.id)).toContain(subtaskIds[1]);
		expect(siblings.map((s) => s.id)).toContain(subtaskIds[2]);
		// Should not contain self
		expect(siblings.map((s) => s.id)).not.toContain(subtaskIds[0]);
	});

	it("getParentTask should return undefined for task without parent", () => {
		const task = addTask("No parent", undefined, tasksPath);
		const parent = getParentTask(task.id, tasksPath);
		expect(parent).toBeUndefined();
	});

	it("getParentTask should return the parent task", () => {
		const parent = addTask("Parent goal", undefined, tasksPath);
		const subtaskIds = decomposeTaskIntoSubtasks(
			parent.id,
			[{ objective: "In src/a.ts, do A", estimatedFiles: ["src/a.ts"], order: 1 }],
			tasksPath,
		);

		const result = getParentTask(subtaskIds[0], tasksPath);
		expect(result).toBeDefined();
		expect(result?.id).toBe(parent.id);
		expect(result?.objective).toBe("Parent goal");
	});

	it("getSiblingTasks should return non-existent task as empty", () => {
		const siblings = getSiblingTasks("nonexistent-id", tasksPath);
		expect(siblings).toEqual([]);
	});

	it("getParentTask should return undefined for non-existent task", () => {
		const parent = getParentTask("nonexistent-id", tasksPath);
		expect(parent).toBeUndefined();
	});
});

describe("buildNextBatch logic", () => {
	// We test the batching logic by simulating what buildNextBatch does,
	// since it's a private method. The logic is simple enough to verify directly.
	function buildNextBatch(
		remainingTasks: string[],
		maxSize: number,
		parentIds: Map<string, string>,
	): { batch: string[]; deferred: string[] } {
		const batch: string[] = [];
		const deferred: string[] = [];
		const parentIdsInBatch = new Set<string>();

		for (const task of remainingTasks) {
			if (batch.length >= maxSize) {
				deferred.push(task);
				continue;
			}

			const parentId = parentIds.get(task);
			if (!parentId) {
				batch.push(task);
			} else if (!parentIdsInBatch.has(parentId)) {
				parentIdsInBatch.add(parentId);
				batch.push(task);
			} else {
				deferred.push(task);
			}
		}

		return { batch, deferred };
	}

	it("should batch all tasks when no siblings", () => {
		const parentIds = new Map<string, string>();
		const { batch, deferred } = buildNextBatch(["a", "b", "c"], 5, parentIds);
		expect(batch).toEqual(["a", "b", "c"]);
		expect(deferred).toEqual([]);
	});

	it("should allow one sibling per parent per batch", () => {
		const parentIds = new Map([
			["a", "parent-1"],
			["b", "parent-1"],
			["c", "parent-1"],
		]);
		const { batch, deferred } = buildNextBatch(["a", "b", "c"], 5, parentIds);
		expect(batch).toEqual(["a"]);
		expect(deferred).toEqual(["b", "c"]);
	});

	it("should mix independent tasks with siblings", () => {
		const parentIds = new Map([
			["sub1-a", "parent-1"],
			["sub1-b", "parent-1"],
			["sub2-a", "parent-2"],
			["sub2-b", "parent-2"],
		]);
		const tasks = ["sub1-a", "standalone", "sub2-a", "sub1-b", "sub2-b"];
		const { batch, deferred } = buildNextBatch(tasks, 5, parentIds);
		expect(batch).toEqual(["sub1-a", "standalone", "sub2-a"]);
		expect(deferred).toEqual(["sub1-b", "sub2-b"]);
	});

	it("should respect maxSize even with eligible tasks", () => {
		const parentIds = new Map<string, string>();
		const { batch, deferred } = buildNextBatch(["a", "b", "c", "d"], 2, parentIds);
		expect(batch).toEqual(["a", "b"]);
		expect(deferred).toEqual(["c", "d"]);
	});

	it("should handle empty input", () => {
		const parentIds = new Map<string, string>();
		const { batch, deferred } = buildNextBatch([], 5, parentIds);
		expect(batch).toEqual([]);
		expect(deferred).toEqual([]);
	});

	it("should process all siblings across multiple batches", () => {
		const parentIds = new Map([
			["a", "parent-1"],
			["b", "parent-1"],
			["c", "parent-1"],
		]);

		// First batch: takes only one
		const result1 = buildNextBatch(["a", "b", "c"], 5, parentIds);
		expect(result1.batch).toEqual(["a"]);
		expect(result1.deferred).toEqual(["b", "c"]);

		// Second batch from deferred: takes next one
		const result2 = buildNextBatch(result1.deferred, 5, parentIds);
		expect(result2.batch).toEqual(["b"]);
		expect(result2.deferred).toEqual(["c"]);

		// Third batch: last one
		const result3 = buildNextBatch(result2.deferred, 5, parentIds);
		expect(result3.batch).toEqual(["c"]);
		expect(result3.deferred).toEqual([]);
	});
});
