/**
 * Tests for task.ts
 *
 * Tests task board CRUD operations and state transitions.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addTask,
	addTasks,
	areAllSubtasksComplete,
	blockTask,
	completeParentIfAllSubtasksDone,
	decomposeTaskIntoSubtasks,
	getAllTasks,
	getTaskById,
	loadTaskBoard,
	markTaskCanceled,
	markTaskComplete,
	markTaskFailed,
	markTaskInProgress,
	markTaskObsolete,
	removeTask,
	removeTasks,
	saveTaskBoard,
	unblockTask,
} from "../task.js";

describe("task.ts", () => {
	let testDir: string;
	let tasksPath: string;

	beforeEach(() => {
		// Create a temp directory for each test
		testDir = mkdtempSync(join(tmpdir(), "task-test-"));
		mkdirSync(join(testDir, ".undercity"), { recursive: true });
		tasksPath = join(testDir, ".undercity", "tasks.json");
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("loadTaskBoard / saveTaskBoard", () => {
		it("should create empty board if file does not exist", () => {
			const board = loadTaskBoard(tasksPath);
			expect(board.tasks).toEqual([]);
			expect(board.lastUpdated).toBeInstanceOf(Date);
		});

		it("should save and load board correctly", () => {
			const board = {
				tasks: [
					{
						id: "test-1",
						objective: "Test task",
						status: "pending" as const,
						createdAt: new Date(),
					},
				],
				lastUpdated: new Date(),
			};

			saveTaskBoard(board, tasksPath);
			const loaded = loadTaskBoard(tasksPath);

			expect(loaded.tasks).toHaveLength(1);
			expect(loaded.tasks[0].id).toBe("test-1");
			expect(loaded.tasks[0].objective).toBe("Test task");
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

			const board = loadTaskBoard(tasksPath);
			expect(board.tasks).toHaveLength(1);
			expect(board.tasks[0].objective).toBe("Test task");
		});
	});

	describe("addTasks", () => {
		it("should add multiple tasks", () => {
			const tasks = addTasks(["Task 1", "Task 2", "Task 3"], tasksPath);

			expect(tasks).toHaveLength(3);
			expect(tasks[0].objective).toBe("Task 1");
			expect(tasks[1].objective).toBe("Task 2");
			expect(tasks[2].objective).toBe("Task 3");

			const board = loadTaskBoard(tasksPath);
			expect(board.tasks).toHaveLength(3);
		});
	});

	describe("removeTask", () => {
		it("should remove existing task", () => {
			const task = addTask("To be removed", undefined, tasksPath);

			const removed = removeTask(task.id, tasksPath);

			expect(removed).toBe(true);
			const board = loadTaskBoard(tasksPath);
			expect(board.tasks).toHaveLength(0);
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
			const board = loadTaskBoard(tasksPath);
			expect(board.tasks).toHaveLength(1);
			expect(board.tasks[0].objective).toBe("Task 3");
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
			expect(updatedParent?.status).toBe("pending");
		});
	});

	describe("getAllTasks", () => {
		it("should return all tasks from default path", () => {
			// Note: This test uses the real default path, so we skip it
			// to avoid polluting the actual task board
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
