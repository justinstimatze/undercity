/**
 * Tests for orchestrator/result-handlers.ts
 *
 * Tests task result handling and decomposition.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleTaskDecomposition, reportTaskOutcome } from "../orchestrator/result-handlers.js";
import type { TaskResult } from "../worker.js";

// Mock task.ts
vi.mock("../task.js", () => ({
	decomposeTaskIntoSubtasks: vi.fn(() => ["subtask-1", "subtask-2"]),
	getAllTasks: vi.fn(() => []),
}));

// Mock output
vi.mock("../output.js", () => ({
	debug: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	taskComplete: vi.fn(),
	taskFailed: vi.fn(),
}));

describe("orchestrator/result-handlers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("handleTaskDecomposition", () => {
		const createResult = (overrides: Partial<TaskResult> = {}): TaskResult => ({
			status: "complete",
			task: "Test task",
			model: "sonnet",
			attempts: 1,
			durationMs: 1000,
			...overrides,
		});

		it("returns decomposed: false when result does not need decomposition", () => {
			const result = createResult({ needsDecomposition: undefined });
			const originalTaskIds = new Map<string, string>();

			const outcome = handleTaskDecomposition(
				"Test task",
				"task-123",
				"/worktree",
				"branch-123",
				result,
				[],
				originalTaskIds,
			);

			expect(outcome.decomposed).toBe(false);
			expect(outcome.earlyReturn).toBeUndefined();
		});

		it("returns decomposed: false when no subtasks suggested", async () => {
			const outputMock = await import("../output.js");
			const result = createResult({
				needsDecomposition: {
					reason: "Too complex",
					suggestedSubtasks: [],
				},
			});
			const originalTaskIds = new Map<string, string>();

			const outcome = handleTaskDecomposition(
				"Test task",
				"task-123",
				"/worktree",
				"branch-123",
				result,
				[],
				originalTaskIds,
			);

			expect(outcome.decomposed).toBe(false);
			expect(outputMock.warning).toHaveBeenCalledWith(
				expect.stringContaining("no subtasks suggested"),
				expect.any(Object),
			);
		});

		it("creates subtasks when decomposition is needed", async () => {
			const { decomposeTaskIntoSubtasks } = await import("../task.js");
			const outputMock = await import("../output.js");
			const result = createResult({
				needsDecomposition: {
					reason: "Too complex",
					suggestedSubtasks: ["Step 1", "Step 2", "Step 3"],
				},
			});
			const originalTaskIds = new Map([["Test task", "original-task-id"]]);

			const outcome = handleTaskDecomposition(
				"Test task",
				"task-123",
				"/worktree",
				"branch-123",
				result,
				["file1.ts"],
				originalTaskIds,
			);

			expect(outcome.decomposed).toBe(true);
			expect(decomposeTaskIntoSubtasks).toHaveBeenCalledWith({
				parentTaskId: "original-task-id",
				subtasks: [
					{ objective: "Step 1", order: 0 },
					{ objective: "Step 2", order: 1 },
					{ objective: "Step 3", order: 2 },
				],
			});
			expect(outputMock.info).toHaveBeenCalledWith(
				expect.stringContaining("Decomposing task into 3 subtasks"),
				expect.any(Object),
			);
		});

		it("returns early return result on successful decomposition", () => {
			const result = createResult({
				needsDecomposition: {
					reason: "Too complex",
					suggestedSubtasks: ["Step 1", "Step 2"],
				},
			});
			const originalTaskIds = new Map([["Test task", "original-task-id"]]);

			const outcome = handleTaskDecomposition(
				"Test task",
				"task-123",
				"/worktree",
				"branch-123",
				result,
				["modified.ts"],
				originalTaskIds,
			);

			expect(outcome.earlyReturn).toBeDefined();
			expect(outcome.earlyReturn?.task).toBe("Test task");
			expect(outcome.earlyReturn?.taskId).toBe("task-123");
			expect(outcome.earlyReturn?.result.status).toBe("failed");
			expect(outcome.earlyReturn?.result.error).toBe("DECOMPOSED");
			expect(outcome.earlyReturn?.merged).toBe(false);
			expect(outcome.earlyReturn?.decomposed).toBe(true);
			expect(outcome.earlyReturn?.modifiedFiles).toEqual(["modified.ts"]);
		});

		it("looks up task ID from board when not in originalTaskIds", async () => {
			const { getAllTasks, decomposeTaskIntoSubtasks } = await import("../task.js");
			vi.mocked(getAllTasks).mockReturnValue([
				{
					id: "board-task-id",
					objective: "Test task",
					status: "pending",
					priority: 5,
					createdAt: new Date().toISOString(),
				},
			]);

			const result = createResult({
				needsDecomposition: {
					reason: "Complex",
					suggestedSubtasks: ["Step 1"],
				},
			});
			const originalTaskIds = new Map<string, string>(); // Empty - will trigger lookup

			const outcome = handleTaskDecomposition(
				"Test task",
				"task-123",
				"/worktree",
				"branch-123",
				result,
				[],
				originalTaskIds,
			);

			expect(outcome.decomposed).toBe(true);
			expect(decomposeTaskIntoSubtasks).toHaveBeenCalledWith(
				expect.objectContaining({ parentTaskId: "board-task-id" }),
			);
			// Should cache the lookup
			expect(originalTaskIds.get("Test task")).toBe("board-task-id");
		});

		it("returns decomposed: false when task ID cannot be found", async () => {
			const { getAllTasks } = await import("../task.js");
			const outputMock = await import("../output.js");
			vi.mocked(getAllTasks).mockReturnValue([]); // No matching task

			const result = createResult({
				needsDecomposition: {
					reason: "Complex",
					suggestedSubtasks: ["Step 1"],
				},
			});
			const originalTaskIds = new Map<string, string>();

			const outcome = handleTaskDecomposition(
				"Unknown task",
				"task-123",
				"/worktree",
				"branch-123",
				result,
				[],
				originalTaskIds,
			);

			expect(outcome.decomposed).toBe(false);
			expect(outputMock.warning).toHaveBeenCalledWith(
				expect.stringContaining("no board task ID found"),
				expect.any(Object),
			);
		});

		it("handles decomposition errors gracefully", async () => {
			const { decomposeTaskIntoSubtasks } = await import("../task.js");
			const outputMock = await import("../output.js");
			vi.mocked(decomposeTaskIntoSubtasks).mockImplementation(() => {
				throw new Error("Database error");
			});

			const result = createResult({
				needsDecomposition: {
					reason: "Complex",
					suggestedSubtasks: ["Step 1"],
				},
			});
			const originalTaskIds = new Map([["Test task", "original-id"]]);

			const outcome = handleTaskDecomposition(
				"Test task",
				"task-123",
				"/worktree",
				"branch-123",
				result,
				[],
				originalTaskIds,
			);

			expect(outcome.decomposed).toBe(false);
			expect(outputMock.warning).toHaveBeenCalledWith(
				expect.stringContaining("Failed to decompose task"),
				expect.any(Object),
			);
		});
	});

	describe("reportTaskOutcome", () => {
		const createResult = (overrides: Partial<TaskResult> = {}): TaskResult => ({
			status: "complete",
			task: "Test task",
			model: "sonnet",
			attempts: 1,
			durationMs: 1000,
			...overrides,
		});

		it("reports task completion for successful result", async () => {
			const outputMock = await import("../output.js");
			const result = createResult({ status: "complete" });
			const processMetaTaskResult = vi.fn();

			reportTaskOutcome("task-123", result, ["file1.ts", "file2.ts"], "worker-abc", processMetaTaskResult);

			expect(outputMock.taskComplete).toHaveBeenCalledWith("task-123", "Task completed", {
				workerName: "worker-abc",
				modifiedFiles: 2,
			});
		});

		it("reports task failure for failed result", async () => {
			const outputMock = await import("../output.js");
			const result = createResult({ status: "failed", error: "Build failed" });
			const processMetaTaskResult = vi.fn();

			reportTaskOutcome("task-123", result, [], "worker-abc", processMetaTaskResult);

			expect(outputMock.taskFailed).toHaveBeenCalledWith("task-123", "Task failed", "Build failed", {
				workerName: "worker-abc",
			});
		});

		it("processes meta task result on completion", async () => {
			const result = createResult({
				status: "complete",
				metaTaskResult: {
					recommendations: [],
					summary: "Triage complete",
				},
			});
			const processMetaTaskResult = vi.fn();

			reportTaskOutcome("task-123", result, [], "worker-abc", processMetaTaskResult);

			expect(processMetaTaskResult).toHaveBeenCalledWith(result.metaTaskResult, "task-123");
		});

		it("does not process meta task result on failure", async () => {
			const result = createResult({
				status: "failed",
				metaTaskResult: {
					recommendations: [],
					summary: "Incomplete",
				},
			});
			const processMetaTaskResult = vi.fn();

			reportTaskOutcome("task-123", result, [], "worker-abc", processMetaTaskResult);

			expect(processMetaTaskResult).not.toHaveBeenCalled();
		});

		it("does not call processMetaTaskResult when no meta result", async () => {
			const result = createResult({ status: "complete", metaTaskResult: undefined });
			const processMetaTaskResult = vi.fn();

			reportTaskOutcome("task-123", result, [], "worker-abc", processMetaTaskResult);

			expect(processMetaTaskResult).not.toHaveBeenCalled();
		});
	});
});
