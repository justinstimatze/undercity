/**
 * Tests for task.ts
 *
 * Tests task board CRUD operations and state transitions.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "../storage.js";
import {
	addTask,
	addTasks,
	areAllSubtasksComplete,
	blockTask,
	completeParentIfAllSubtasksDone,
	decomposeTaskIntoSubtasks,
	getAllTasks,
	getNextTask,
	getTaskById,
	markTaskCanceled,
	markTaskComplete,
	markTaskFailed,
	markTaskInProgress,
	markTaskObsolete,
	removeTask,
	removeTasks,
	unblockTask,
} from "../task.js";

describe("task.ts", () => {
	let testDir: string;
	let tasksPath: string;

	beforeEach(() => {
		// Reset database singleton between tests
		resetDatabase();

		// Create a temp directory for each test
		testDir = mkdtempSync(join(tmpdir(), "task-test-"));
		mkdirSync(join(testDir, ".undercity"), { recursive: true });
		tasksPath = join(testDir, ".undercity", "tasks.json");
	});

	afterEach(() => {
		// Close database before removing temp directory
		resetDatabase();

		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("getAllTasks", () => {
		it("should return empty array if no tasks exist", () => {
			const tasks = getAllTasks(tasksPath);
			expect(tasks).toEqual([]);
		});

		it("should return tasks added via addTask", () => {
			const task = addTask("Test task", undefined, tasksPath);
			const tasks = getAllTasks(tasksPath);

			expect(tasks).toHaveLength(1);
			expect(tasks[0].id).toBe(task.id);
			expect(tasks[0].objective).toBe("Test task");
		});
	});

	describe("addTask", () => {
		it("should add a task with generated ID", () => {
			const task = addTask("Fix the bug", undefined, tasksPath);

			expect(task.id).toMatch(/^task-/);
			expect(task.objective).toBe("Fix the bug");
			expect(task.status).toBe("pending");
			expect(task.createdAt).toBeInstanceOf(Date);
		});

		it("should add task with priority", () => {
			const task = addTask("High priority task", 10, tasksPath);

			expect(task.priority).toBe(10);
		});

		it("should persist task to board", () => {
			addTask("Test task", undefined, tasksPath);

			const tasks = getAllTasks(tasksPath);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].objective).toBe("Test task");
		});
	});

	describe("addTasks", () => {
		it("should add multiple tasks", () => {
			const tasks = addTasks(["Task 1", "Task 2", "Task 3"], tasksPath);

			expect(tasks).toHaveLength(3);
			expect(tasks[0].objective).toBe("Task 1");
			expect(tasks[1].objective).toBe("Task 2");
			expect(tasks[2].objective).toBe("Task 3");

			const allTasks = getAllTasks(tasksPath);
			expect(allTasks).toHaveLength(3);
		});
	});

	describe("removeTask", () => {
		it("should remove existing task", () => {
			const task = addTask("To be removed", undefined, tasksPath);

			const removed = removeTask(task.id, tasksPath);

			expect(removed).toBe(true);
			const tasks = getAllTasks(tasksPath);
			expect(tasks).toHaveLength(0);
		});

		it("should return false for non-existent task", () => {
			const removed = removeTask("nonexistent-id", tasksPath);
			expect(removed).toBe(false);
		});
	});

	describe("removeTasks", () => {
		it("should remove multiple tasks", () => {
			const t1 = addTask("Task 1", undefined, tasksPath);
			const t2 = addTask("Task 2", undefined, tasksPath);
			addTask("Task 3", undefined, tasksPath);

			const removed = removeTasks([t1.id, t2.id], tasksPath);

			expect(removed).toBe(2);
			const tasks = getAllTasks(tasksPath);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].objective).toBe("Task 3");
		});

		it("should return 0 for empty array", () => {
			addTask("Task 1", undefined, tasksPath);

			const removed = removeTasks([], tasksPath);
			expect(removed).toBe(0);
		});
	});

	describe("getTaskById", () => {
		it("should find task by ID", () => {
			const task = addTask("Find me", undefined, tasksPath);

			const found = getTaskById(task.id, tasksPath);

			expect(found).not.toBeUndefined();
			expect(found?.objective).toBe("Find me");
		});

		it("should return undefined for non-existent ID", () => {
			const found = getTaskById("nonexistent", tasksPath);
			expect(found).toBeUndefined();
		});
	});

	describe("markTaskInProgress", () => {
		it("should update task status to in_progress", () => {
			const task = addTask("Start me", undefined, tasksPath);

			markTaskInProgress(task.id, "session-123", tasksPath);

			const updated = getTaskById(task.id, tasksPath);
			expect(updated?.status).toBe("in_progress");
			expect(updated?.sessionId).toBe("session-123");
			// Dates are stored as ISO strings in JSON, check they exist
			expect(updated?.startedAt).toBeDefined();
		});
	});

	describe("markTaskComplete", () => {
		it("should update task status to complete", () => {
			const task = addTask("Complete me", undefined, tasksPath);

			markTaskComplete(task.id, tasksPath);

			const updated = getTaskById(task.id, tasksPath);
			expect(updated?.status).toBe("complete");
			// Dates are stored as ISO strings in JSON, check they exist
			expect(updated?.completedAt).toBeDefined();
		});
	});

	describe("markTaskFailed", () => {
		it("should update task status to failed with error", () => {
			const task = addTask("Fail me", undefined, tasksPath);

			markTaskFailed(task.id, "Something went wrong", tasksPath);

			const updated = getTaskById(task.id, tasksPath);
			expect(updated?.status).toBe("failed");
			expect(updated?.error).toBe("Something went wrong");
		});
	});

	describe("markTaskCanceled", () => {
		it("should update task status to canceled with reason", () => {
			const task = addTask("Cancel me", undefined, tasksPath);

			markTaskCanceled(task.id, "No longer needed", tasksPath);

			const updated = getTaskById(task.id, tasksPath);
			expect(updated?.status).toBe("canceled");
			expect(updated?.resolution).toBe("No longer needed");
		});
	});

	describe("markTaskObsolete", () => {
		it("should update task status to obsolete with reason", () => {
			const task = addTask("Obsolete me", undefined, tasksPath);

			markTaskObsolete(task.id, "Requirements changed", tasksPath);

			const updated = getTaskById(task.id, tasksPath);
			expect(updated?.status).toBe("obsolete");
			expect(updated?.resolution).toBe("Requirements changed");
		});
	});

	describe("blockTask / unblockTask", () => {
		it("should block a pending task", () => {
			const task = addTask("Block me", undefined, tasksPath);

			blockTask(task.id, tasksPath);

			const updated = getTaskById(task.id, tasksPath);
			expect(updated?.status).toBe("blocked");
		});

		it("should unblock a blocked task", () => {
			const task = addTask("Block and unblock me", undefined, tasksPath);
			blockTask(task.id, tasksPath);

			unblockTask(task.id, tasksPath);

			const updated = getTaskById(task.id, tasksPath);
			expect(updated?.status).toBe("pending");
		});
	});

	describe("decomposeTaskIntoSubtasks", () => {
		it("should create subtasks linked to parent", () => {
			const parent = addTask("Parent task", undefined, tasksPath);

			// decomposeTaskIntoSubtasks expects objects with objective and order
			const subtaskIds = decomposeTaskIntoSubtasks(
				parent.id,
				[
					{ objective: "Subtask 1", order: 1 },
					{ objective: "Subtask 2", order: 2 },
				],
				tasksPath,
			);

			expect(subtaskIds).toHaveLength(2);

			// Verify subtasks have parentId set
			const sub1 = getTaskById(subtaskIds[0], tasksPath);
			const sub2 = getTaskById(subtaskIds[1], tasksPath);
			expect(sub1?.parentId).toBe(parent.id);
			expect(sub2?.parentId).toBe(parent.id);

			const updatedParent = getTaskById(parent.id, tasksPath);
			expect(updatedParent?.isDecomposed).toBe(true);
			expect(updatedParent?.subtaskIds).toContain(subtaskIds[0]);
			expect(updatedParent?.subtaskIds).toContain(subtaskIds[1]);
		});
	});

	describe("areAllSubtasksComplete", () => {
		it("should return false if subtasks are pending", () => {
			const parent = addTask("Parent", undefined, tasksPath);
			decomposeTaskIntoSubtasks(
				parent.id,
				[
					{ objective: "Sub 1", order: 1 },
					{ objective: "Sub 2", order: 2 },
				],
				tasksPath,
			);

			expect(areAllSubtasksComplete(parent.id, tasksPath)).toBe(false);
		});

		it("should return true if all subtasks are complete", () => {
			const parent = addTask("Parent", undefined, tasksPath);
			const subtaskIds = decomposeTaskIntoSubtasks(
				parent.id,
				[
					{ objective: "Sub 1", order: 1 },
					{ objective: "Sub 2", order: 2 },
				],
				tasksPath,
			);

			markTaskComplete(subtaskIds[0], tasksPath);
			markTaskComplete(subtaskIds[1], tasksPath);

			expect(areAllSubtasksComplete(parent.id, tasksPath)).toBe(true);
		});
	});

	describe("completeParentIfAllSubtasksDone", () => {
		it("should complete parent when all subtasks done", () => {
			const parent = addTask("Parent", undefined, tasksPath);
			const subtaskIds = decomposeTaskIntoSubtasks(parent.id, [{ objective: "Sub 1", order: 1 }], tasksPath);

			markTaskComplete(subtaskIds[0], tasksPath);
			const completed = completeParentIfAllSubtasksDone(parent.id, tasksPath);

			expect(completed).toBe(true);
			const updatedParent = getTaskById(parent.id, tasksPath);
			expect(updatedParent?.status).toBe("complete");
		});

		it("should not complete parent if subtasks pending", () => {
			const parent = addTask("Parent", undefined, tasksPath);
			decomposeTaskIntoSubtasks(parent.id, [{ objective: "Sub 1", order: 1 }], tasksPath);

			const completed = completeParentIfAllSubtasksDone(parent.id, tasksPath);

			expect(completed).toBe(false);
			const updatedParent = getTaskById(parent.id, tasksPath);
			expect(updatedParent?.status).toBe("decomposed");
		});
	});

	describe("getAllTasks", () => {
		it("should return all tasks from default path", () => {
			// Note: This test uses the real default path, so we skip it
			// to avoid polluting the actual task board
		});
	});

	// =========================================================================
	// Decomposition Lifecycle Tests
	// =========================================================================

	describe("decomposition lifecycle", () => {
		it("marks parent as isDecomposed=true after decompose", () => {
			const parent = addTask("Parent task", undefined, tasksPath);

			decomposeTaskIntoSubtasks(parent.id, [{ objective: "Subtask 1", order: 1 }], tasksPath);

			const updatedParent = getTaskById(parent.id, tasksPath);
			expect(updatedParent?.isDecomposed).toBe(true);
		});

		it("sets parent status to decomposed", () => {
			const parent = addTask("Parent task", undefined, tasksPath);

			decomposeTaskIntoSubtasks(parent.id, [{ objective: "Subtask 1", order: 1 }], tasksPath);

			const updatedParent = getTaskById(parent.id, tasksPath);
			expect(updatedParent?.status).toBe("decomposed");
		});

		it("inherits parent priority to subtasks with order offset", () => {
			const parent = addTask("Parent task", 25, tasksPath);

			const subtaskIds = decomposeTaskIntoSubtasks(
				parent.id,
				[
					{ objective: "Subtask 1", order: 1 },
					{ objective: "Subtask 2", order: 2 },
				],
				tasksPath,
			);

			const sub1 = getTaskById(subtaskIds[0], tasksPath);
			const sub2 = getTaskById(subtaskIds[1], tasksPath);

			// Priority = basePriority + order * 0.1
			expect(sub1?.priority).toBe(25.1);
			expect(sub2?.priority).toBe(25.2);
		});

		it("sets subtask priorities based on order", () => {
			// Default priority is allTasks.length (0 for first task)
			const parent = addTask("Parent task", undefined, tasksPath);

			const subtaskIds = decomposeTaskIntoSubtasks(
				parent.id,
				[
					{ objective: "Subtask 1", order: 1 },
					{ objective: "Subtask 2", order: 2 },
					{ objective: "Subtask 3", order: 3 },
				],
				tasksPath,
			);

			const sub1 = getTaskById(subtaskIds[0], tasksPath);
			const sub2 = getTaskById(subtaskIds[1], tasksPath);
			const sub3 = getTaskById(subtaskIds[2], tasksPath);

			// Priority = basePriority + order * 0.1, order determines execution sequence
			// Parent priority is 0 (first task in empty board)
			// Use toBeCloseTo for floating point comparison
			expect(sub1?.priority).toBeCloseTo(0.1);
			expect(sub2?.priority).toBeCloseTo(0.2);
			expect(sub3?.priority).toBeCloseTo(0.3);
		});

		it("tracks subtaskIds in parent", () => {
			const parent = addTask("Parent task", undefined, tasksPath);

			const subtaskIds = decomposeTaskIntoSubtasks(
				parent.id,
				[
					{ objective: "Subtask 1", order: 1 },
					{ objective: "Subtask 2", order: 2 },
				],
				tasksPath,
			);

			const updatedParent = getTaskById(parent.id, tasksPath);

			expect(updatedParent?.subtaskIds).toHaveLength(2);
			expect(updatedParent?.subtaskIds).toContain(subtaskIds[0]);
			expect(updatedParent?.subtaskIds).toContain(subtaskIds[1]);
		});
	});

	// =========================================================================
	// areAllSubtasksComplete Edge Cases
	// =========================================================================

	describe("areAllSubtasksComplete edge cases", () => {
		it("returns false for task with no subtasks", () => {
			const task = addTask("No subtasks", undefined, tasksPath);

			// Task without subtasks returns false (only returns true when
			// subtaskIds is non-empty and all are complete)
			expect(areAllSubtasksComplete(task.id, tasksPath)).toBe(false);
		});

		it("returns false if any subtask is in_progress", () => {
			const parent = addTask("Parent", undefined, tasksPath);
			const subtaskIds = decomposeTaskIntoSubtasks(
				parent.id,
				[
					{ objective: "Sub 1", order: 1 },
					{ objective: "Sub 2", order: 2 },
				],
				tasksPath,
			);

			markTaskComplete(subtaskIds[0], tasksPath);
			markTaskInProgress(subtaskIds[1], "session-1", tasksPath);

			expect(areAllSubtasksComplete(parent.id, tasksPath)).toBe(false);
		});

		it("returns false if any subtask is failed", () => {
			const parent = addTask("Parent", undefined, tasksPath);
			const subtaskIds = decomposeTaskIntoSubtasks(
				parent.id,
				[
					{ objective: "Sub 1", order: 1 },
					{ objective: "Sub 2", order: 2 },
				],
				tasksPath,
			);

			markTaskComplete(subtaskIds[0], tasksPath);
			markTaskFailed(subtaskIds[1], "Error occurred", tasksPath);

			// Failed tasks are not complete
			expect(areAllSubtasksComplete(parent.id, tasksPath)).toBe(false);
		});

		it("handles nested subtasks", () => {
			// Parent → Subtask → Sub-subtask
			const parent = addTask("Parent", undefined, tasksPath);
			const subtaskIds = decomposeTaskIntoSubtasks(parent.id, [{ objective: "Subtask", order: 1 }], tasksPath);

			// Decompose the subtask further
			const subSubtaskIds = decomposeTaskIntoSubtasks(
				subtaskIds[0],
				[{ objective: "Sub-subtask", order: 1 }],
				tasksPath,
			);

			// Neither complete
			expect(areAllSubtasksComplete(parent.id, tasksPath)).toBe(false);

			// Complete the leaf
			markTaskComplete(subSubtaskIds[0], tasksPath);

			// Subtask should now auto-complete via completeParentIfAllSubtasksDone
			completeParentIfAllSubtasksDone(subtaskIds[0], tasksPath);

			// Now check parent
			expect(areAllSubtasksComplete(parent.id, tasksPath)).toBe(true);
		});
	});

	// =========================================================================
	// completeParentIfAllSubtasksDone Edge Cases
	// =========================================================================

	describe("completeParentIfAllSubtasksDone edge cases", () => {
		it("returns false if parent does not exist", () => {
			const result = completeParentIfAllSubtasksDone("nonexistent-id", tasksPath);
			expect(result).toBe(false);
		});

		it("returns false if parent is not decomposed", () => {
			const task = addTask("Not decomposed", undefined, tasksPath);
			const result = completeParentIfAllSubtasksDone(task.id, tasksPath);
			expect(result).toBe(false);
		});

		it("returns false if some subtasks still pending", () => {
			const parent = addTask("Parent", undefined, tasksPath);
			const subtaskIds = decomposeTaskIntoSubtasks(
				parent.id,
				[
					{ objective: "Sub 1", order: 1 },
					{ objective: "Sub 2", order: 2 },
				],
				tasksPath,
			);

			// Only complete one
			markTaskComplete(subtaskIds[0], tasksPath);

			const result = completeParentIfAllSubtasksDone(parent.id, tasksPath);
			expect(result).toBe(false);

			const parentTask = getTaskById(parent.id, tasksPath);
			expect(parentTask?.status).toBe("decomposed");
		});

		it("sets completedAt timestamp when completing parent", () => {
			const parent = addTask("Parent", undefined, tasksPath);
			const subtaskIds = decomposeTaskIntoSubtasks(parent.id, [{ objective: "Sub 1", order: 1 }], tasksPath);

			markTaskComplete(subtaskIds[0], tasksPath);
			completeParentIfAllSubtasksDone(parent.id, tasksPath);

			const parentTask = getTaskById(parent.id, tasksPath);
			expect(parentTask?.completedAt).toBeDefined();
		});
	});

	// =========================================================================
	// Dependency-Aware Task Selection
	// =========================================================================

	describe("dependency-aware task selection", () => {
		it("getNextTask skips tasks with unsatisfied dependencies", () => {
			const prereq = addTask("Prerequisite task", 50, tasksPath);
			addTask("Dependent task", { priority: 1, dependsOn: [prereq.id], path: tasksPath });

			const next = getNextTask(tasksPath);

			// Should return prereq since dependent has unsatisfied dependency
			expect(next?.id).toBe(prereq.id);
		});

		it("getNextTask returns dependent after prerequisite is complete", () => {
			const prereq = addTask("Prerequisite task", 50, tasksPath);
			const dependent = addTask("Dependent task", { priority: 1, dependsOn: [prereq.id], path: tasksPath });

			// Complete the prerequisite
			markTaskComplete(prereq.id, tasksPath);

			const next = getNextTask(tasksPath);

			// Dependent should now be available (it has lower priority)
			expect(next?.id).toBe(dependent.id);
		});

		it("handles multiple dependencies (all must be satisfied)", () => {
			const prereq1 = addTask("Prereq 1", 50, tasksPath);
			const prereq2 = addTask("Prereq 2", 50, tasksPath);
			addTask("Dependent task", { priority: 1, dependsOn: [prereq1.id, prereq2.id], path: tasksPath });

			// Complete only one prerequisite
			markTaskComplete(prereq1.id, tasksPath);

			let next = getNextTask(tasksPath);
			// Should return prereq2 (not the dependent)
			expect(next?.id).toBe(prereq2.id);

			// Complete the second prerequisite
			markTaskComplete(prereq2.id, tasksPath);

			next = getNextTask(tasksPath);
			// Now dependent should be available
			expect(next?.objective).toBe("Dependent task");
		});

		it("chain of dependencies resolves correctly", () => {
			const task1 = addTask("Task 1", 10, tasksPath);
			const task2 = addTask("Task 2", { priority: 20, dependsOn: [task1.id], path: tasksPath });
			const task3 = addTask("Task 3", { priority: 30, dependsOn: [task2.id], path: tasksPath });

			// Only task1 should be available
			expect(getNextTask(tasksPath)?.id).toBe(task1.id);

			markTaskComplete(task1.id, tasksPath);

			// Now task2 should be available
			expect(getNextTask(tasksPath)?.id).toBe(task2.id);

			markTaskComplete(task2.id, tasksPath);

			// Now task3 should be available
			expect(getNextTask(tasksPath)?.id).toBe(task3.id);
		});
	});

	describe("state transitions", () => {
		it("should preserve other fields when updating status", () => {
			const task = addTask("Task with priority", 50, tasksPath);

			markTaskInProgress(task.id, "session-1", tasksPath);

			const updated = getTaskById(task.id, tasksPath);
			expect(updated?.priority).toBe(50);
			expect(updated?.objective).toBe("Task with priority");
		});

		it("should handle full lifecycle", () => {
			// Create task
			const task = addTask("Lifecycle task", undefined, tasksPath);
			expect(task.status).toBe("pending");

			// Start work
			markTaskInProgress(task.id, "session-1", tasksPath);
			let updated = getTaskById(task.id, tasksPath);
			expect(updated?.status).toBe("in_progress");

			// Complete
			markTaskComplete(task.id, tasksPath);
			updated = getTaskById(task.id, tasksPath);
			expect(updated?.status).toBe("complete");
			expect(updated?.completedAt).toBeDefined();
		});
	});
});
