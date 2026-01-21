/**
 * Tests for orchestrator/recovery-helpers.ts
 *
 * Helper functions for batch recovery.
 */

import { describe, expect, it, vi } from "vitest";
import {
	extractCheckpointsAndCleanup,
	formatResumeMessage,
	type RecoveryTask,
} from "../orchestrator/recovery-helpers.js";
import type { TaskCheckpoint } from "../types.js";

// Mock dependencies
vi.mock("../output.js", () => ({
	debug: vi.fn(),
}));

vi.mock("../persistence.js", () => ({
	readTaskAssignment: vi.fn(),
}));

// Import mocked modules
import { readTaskAssignment } from "../persistence.js";

describe("orchestrator/recovery-helpers", () => {
	describe("formatResumeMessage", () => {
		it("formats message without checkpoints", () => {
			const result = formatResumeMessage(5, 0);
			expect(result).toBe("5 tasks to resume");
		});

		it("formats message with one checkpoint", () => {
			const result = formatResumeMessage(5, 1);
			expect(result).toBe("5 tasks to resume (1 with checkpoints)");
		});

		it("formats message with multiple checkpoints", () => {
			const result = formatResumeMessage(10, 3);
			expect(result).toBe("10 tasks to resume (3 with checkpoints)");
		});

		it("handles single task", () => {
			const result = formatResumeMessage(1, 0);
			expect(result).toBe("1 tasks to resume");
		});

		it("handles zero tasks", () => {
			const result = formatResumeMessage(0, 0);
			expect(result).toBe("0 tasks to resume");
		});
	});

	describe("extractCheckpointsAndCleanup", () => {
		it("returns 0 when no running tasks", () => {
			const tasks: RecoveryTask[] = [
				{ task: "task 1", taskId: "id-1", status: "pending" },
				{ task: "task 2", taskId: "id-2", status: "complete" },
			];
			const checkpointStore = new Map<string, TaskCheckpoint>();
			const removeWorktree = vi.fn();

			const result = extractCheckpointsAndCleanup(tasks, checkpointStore, removeWorktree);

			expect(result).toBe(0);
			expect(checkpointStore.size).toBe(0);
			expect(removeWorktree).not.toHaveBeenCalled();
		});

		it("skips running tasks without worktree path", () => {
			const tasks: RecoveryTask[] = [{ task: "task 1", taskId: "id-1", status: "running" }];
			const checkpointStore = new Map<string, TaskCheckpoint>();
			const removeWorktree = vi.fn();

			const result = extractCheckpointsAndCleanup(tasks, checkpointStore, removeWorktree);

			expect(result).toBe(0);
			expect(removeWorktree).not.toHaveBeenCalled();
		});

		it("recovers checkpoint from running task with worktree", () => {
			const checkpoint: TaskCheckpoint = {
				phase: "executing",
				model: "sonnet",
				attempts: 2,
				savedAt: new Date(),
			};

			vi.mocked(readTaskAssignment).mockReturnValue({
				taskId: "id-1",
				taskObjective: "task 1",
				assignedAt: new Date().toISOString(),
				checkpoint,
			});

			const tasks: RecoveryTask[] = [
				{
					task: "task 1",
					taskId: "id-1",
					status: "running",
					worktreePath: "/path/to/worktree",
				},
			];
			const checkpointStore = new Map<string, TaskCheckpoint>();
			const removeWorktree = vi.fn();

			const result = extractCheckpointsAndCleanup(tasks, checkpointStore, removeWorktree);

			expect(result).toBe(1);
			expect(checkpointStore.get("task 1")).toBe(checkpoint);
			expect(removeWorktree).toHaveBeenCalledWith("id-1", true);
		});

		it("cleans up worktree even when checkpoint recovery fails", () => {
			vi.mocked(readTaskAssignment).mockImplementation(() => {
				throw new Error("file not found");
			});

			const tasks: RecoveryTask[] = [
				{
					task: "task 1",
					taskId: "id-1",
					status: "running",
					worktreePath: "/path/to/worktree",
				},
			];
			const checkpointStore = new Map<string, TaskCheckpoint>();
			const removeWorktree = vi.fn();

			const result = extractCheckpointsAndCleanup(tasks, checkpointStore, removeWorktree);

			expect(result).toBe(0);
			expect(checkpointStore.size).toBe(0);
			expect(removeWorktree).toHaveBeenCalledWith("id-1", true);
		});

		it("handles worktree cleanup failure gracefully", () => {
			vi.mocked(readTaskAssignment).mockReturnValue(null);

			const tasks: RecoveryTask[] = [
				{
					task: "task 1",
					taskId: "id-1",
					status: "running",
					worktreePath: "/path/to/worktree",
				},
			];
			const checkpointStore = new Map<string, TaskCheckpoint>();
			const removeWorktree = vi.fn().mockImplementation(() => {
				throw new Error("permission denied");
			});

			// Should not throw
			const result = extractCheckpointsAndCleanup(tasks, checkpointStore, removeWorktree);

			expect(result).toBe(0);
		});

		it("processes multiple running tasks", () => {
			const checkpoint1: TaskCheckpoint = {
				phase: "verifying",
				model: "haiku",
				attempts: 1,
				savedAt: new Date(),
			};
			const checkpoint2: TaskCheckpoint = {
				phase: "reviewing",
				model: "opus",
				attempts: 3,
				savedAt: new Date(),
			};

			vi.mocked(readTaskAssignment)
				.mockReturnValueOnce({
					taskId: "id-1",
					taskObjective: "task 1",
					assignedAt: new Date().toISOString(),
					checkpoint: checkpoint1,
				})
				.mockReturnValueOnce({
					taskId: "id-2",
					taskObjective: "task 2",
					assignedAt: new Date().toISOString(),
					checkpoint: checkpoint2,
				});

			const tasks: RecoveryTask[] = [
				{
					task: "task 1",
					taskId: "id-1",
					status: "running",
					worktreePath: "/path/to/worktree1",
				},
				{
					task: "task 2",
					taskId: "id-2",
					status: "running",
					worktreePath: "/path/to/worktree2",
				},
			];
			const checkpointStore = new Map<string, TaskCheckpoint>();
			const removeWorktree = vi.fn();

			const result = extractCheckpointsAndCleanup(tasks, checkpointStore, removeWorktree);

			expect(result).toBe(2);
			expect(checkpointStore.size).toBe(2);
			expect(checkpointStore.get("task 1")).toBe(checkpoint1);
			expect(checkpointStore.get("task 2")).toBe(checkpoint2);
			expect(removeWorktree).toHaveBeenCalledTimes(2);
		});

		it("handles assignment without checkpoint", () => {
			vi.mocked(readTaskAssignment).mockReturnValue({
				taskId: "id-1",
				taskObjective: "task 1",
				assignedAt: new Date().toISOString(),
				// No checkpoint field
			});

			const tasks: RecoveryTask[] = [
				{
					task: "task 1",
					taskId: "id-1",
					status: "running",
					worktreePath: "/path/to/worktree",
				},
			];
			const checkpointStore = new Map<string, TaskCheckpoint>();
			const removeWorktree = vi.fn();

			const result = extractCheckpointsAndCleanup(tasks, checkpointStore, removeWorktree);

			expect(result).toBe(0);
			expect(checkpointStore.size).toBe(0);
			// Still cleans up worktree
			expect(removeWorktree).toHaveBeenCalledWith("id-1", true);
		});
	});
});
