/**
 * Tests for orchestrator/recommendation-handlers.ts
 *
 * Tests recommendation validation and application.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyRecommendation,
	type RecommendationContext,
	validateRecommendation,
} from "../orchestrator/recommendation-handlers.js";
import type { Task } from "../task.js";
import type { MetaTaskRecommendation } from "../types.js";

// Mock task.ts
vi.mock("../task.js", () => ({
	addTask: vi.fn(() => ({ id: "new-task-123", objective: "New task" })),
	getTaskById: vi.fn(),
	markTaskBlocked: vi.fn(),
	markTaskComplete: vi.fn(),
	removeTasks: vi.fn(() => 1),
	unblockTask: vi.fn(),
	updateTaskFields: vi.fn(),
}));

// Mock output
vi.mock("../output.js", () => ({
	debug: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
}));

describe("orchestrator/recommendation-handlers", () => {
	const createTask = (overrides: Partial<Task> = {}): Task => ({
		id: "task-123",
		objective: "Test task",
		status: "pending",
		priority: 5,
		createdAt: new Date().toISOString(),
		...overrides,
	});

	const createContext = (overrides: Partial<RecommendationContext> = {}): RecommendationContext => ({
		verbose: false,
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("validateRecommendation", () => {
		const tasks = [
			createTask({ id: "task-1", status: "pending" }),
			createTask({ id: "task-2", status: "complete" }),
			createTask({ id: "task-3", status: "blocked" }),
		];
		const taskIds = new Set(tasks.map((t) => t.id));
		const metaTaskId = "meta-task-999";

		describe("self-protection", () => {
			it("rejects recommendations that target the meta-task itself", () => {
				const rec: MetaTaskRecommendation = {
					action: "remove",
					taskId: metaTaskId,
					reason: "Should not work",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(false);
				expect(result.reason).toBe("cannot modify self");
			});
		});

		describe("remove action", () => {
			it("validates remove with existing task", () => {
				const rec: MetaTaskRecommendation = {
					action: "remove",
					taskId: "task-1",
					reason: "Duplicate",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(true);
			});

			it("rejects remove without taskId", () => {
				const rec: MetaTaskRecommendation = {
					action: "remove",
					reason: "Missing ID",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(false);
				expect(result.reason).toBe("missing taskId");
			});

			it("rejects remove for non-existent task", () => {
				const rec: MetaTaskRecommendation = {
					action: "remove",
					taskId: "nonexistent",
					reason: "Not found",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(false);
				expect(result.reason).toBe("task does not exist");
			});
		});

		describe("complete action", () => {
			it("validates complete for pending task", () => {
				const rec: MetaTaskRecommendation = {
					action: "complete",
					taskId: "task-1",
					reason: "Already done",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(true);
			});

			it("rejects complete for already complete task", () => {
				const rec: MetaTaskRecommendation = {
					action: "complete",
					taskId: "task-2", // Already complete
					reason: "Mark complete",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(false);
				expect(result.reason).toBe("task already complete");
			});
		});

		describe("block action", () => {
			it("validates block for pending task", () => {
				const rec: MetaTaskRecommendation = {
					action: "block",
					taskId: "task-1",
					reason: "Needs dependency",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(true);
			});

			it("rejects block for already blocked task", () => {
				const rec: MetaTaskRecommendation = {
					action: "block",
					taskId: "task-3", // Already blocked
					reason: "Block again",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(false);
				expect(result.reason).toBe("task already blocked");
			});

			it("rejects block for complete task", () => {
				const rec: MetaTaskRecommendation = {
					action: "block",
					taskId: "task-2", // Complete
					reason: "Try to block",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(false);
				expect(result.reason).toBe("cannot block completed task");
			});
		});

		describe("unblock action", () => {
			it("validates unblock for blocked task", () => {
				const rec: MetaTaskRecommendation = {
					action: "unblock",
					taskId: "task-3", // Blocked
					reason: "Dependency resolved",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(true);
			});

			it("rejects unblock for non-blocked task", () => {
				const rec: MetaTaskRecommendation = {
					action: "unblock",
					taskId: "task-1", // Pending, not blocked
					reason: "Unblock",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(false);
				expect(result.reason).toBe("task is not blocked");
			});
		});

		describe("add action", () => {
			it("validates add with new objective", () => {
				const rec: MetaTaskRecommendation = {
					action: "add",
					newTask: { objective: "New unique task", priority: 5 },
					reason: "Needed",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(true);
			});

			it("rejects add without objective", () => {
				const rec: MetaTaskRecommendation = {
					action: "add",
					newTask: { objective: "", priority: 5 },
					reason: "Empty",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(false);
				expect(result.reason).toBe("missing objective for new task");
			});

			it("rejects add with duplicate objective", () => {
				const rec: MetaTaskRecommendation = {
					action: "add",
					newTask: { objective: "Test task", priority: 5 }, // Same as existing
					reason: "Duplicate",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(false);
				expect(result.reason).toBe("duplicate objective");
			});

			it("duplicate check is case-insensitive", () => {
				const rec: MetaTaskRecommendation = {
					action: "add",
					newTask: { objective: "TEST TASK", priority: 5 }, // Same but uppercase
					reason: "Duplicate",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(false);
				expect(result.reason).toBe("duplicate objective");
			});
		});

		describe("merge action", () => {
			it("validates merge with existing related tasks", () => {
				const rec: MetaTaskRecommendation = {
					action: "merge",
					relatedTaskIds: ["task-1", "task-3"],
					reason: "Combine similar",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(true);
			});

			it("rejects merge without relatedTaskIds", () => {
				const rec: MetaTaskRecommendation = {
					action: "merge",
					reason: "No related",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(false);
				expect(result.reason).toBe("merge requires relatedTaskIds");
			});

			it("rejects merge with non-existent related task", () => {
				const rec: MetaTaskRecommendation = {
					action: "merge",
					relatedTaskIds: ["task-1", "nonexistent"],
					reason: "Invalid related",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(false);
				expect(result.reason).toContain("does not exist");
			});
		});

		describe("prioritize action", () => {
			it("validates prioritize with updates", () => {
				const rec: MetaTaskRecommendation = {
					action: "prioritize",
					taskId: "task-1",
					updates: { priority: 10 },
					reason: "Urgent",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(true);
			});
		});

		describe("update action", () => {
			it("validates update with existing task", () => {
				const rec: MetaTaskRecommendation = {
					action: "update",
					taskId: "task-1",
					updates: { objective: "Updated objective" },
					reason: "Clarify",
				};

				const result = validateRecommendation(rec, tasks, taskIds, metaTaskId);

				expect(result.valid).toBe(true);
			});
		});
	});

	describe("applyRecommendation", () => {
		const ctx = createContext({ verbose: true });

		describe("remove handler", () => {
			it("calls removeTasks with taskId", async () => {
				const { removeTasks } = await import("../task.js");
				const rec: MetaTaskRecommendation = {
					action: "remove",
					taskId: "task-123",
					reason: "Duplicate",
				};

				applyRecommendation(rec, ctx);

				expect(removeTasks).toHaveBeenCalledWith(["task-123"]);
			});
		});

		describe("add handler", () => {
			it("calls addTask with objective and priority", async () => {
				const { addTask } = await import("../task.js");
				const rec: MetaTaskRecommendation = {
					action: "add",
					newTask: { objective: "New task objective", priority: 7 },
					reason: "Needed",
				};

				applyRecommendation(rec, ctx);

				expect(addTask).toHaveBeenCalledWith("New task objective", 7);
			});
		});

		describe("complete handler", () => {
			it("calls markTaskComplete", async () => {
				const { getTaskById, markTaskComplete } = await import("../task.js");
				vi.mocked(getTaskById).mockReturnValue(createTask());
				const rec: MetaTaskRecommendation = {
					action: "complete",
					taskId: "task-123",
					reason: "Done",
				};

				applyRecommendation(rec, ctx);

				expect(markTaskComplete).toHaveBeenCalledWith("task-123");
			});
		});

		describe("prioritize handler", () => {
			it("calls updateTaskFields with new priority", async () => {
				const { getTaskById, updateTaskFields } = await import("../task.js");
				vi.mocked(getTaskById).mockReturnValue(createTask());
				const rec: MetaTaskRecommendation = {
					action: "prioritize",
					taskId: "task-123",
					updates: { priority: 10 },
					reason: "Urgent",
				};

				applyRecommendation(rec, ctx);

				expect(updateTaskFields).toHaveBeenCalledWith("task-123", { priority: 10 });
			});
		});

		describe("update handler", () => {
			it("calls updateTaskFields with updates", async () => {
				const { getTaskById, updateTaskFields } = await import("../task.js");
				vi.mocked(getTaskById).mockReturnValue(createTask());
				const rec: MetaTaskRecommendation = {
					action: "update",
					taskId: "task-123",
					updates: { objective: "New objective", tags: ["tag1"] },
					reason: "Clarify",
				};

				applyRecommendation(rec, ctx);

				expect(updateTaskFields).toHaveBeenCalledWith("task-123", {
					objective: "New objective",
					priority: undefined,
					tags: ["tag1"],
				});
			});
		});

		describe("block handler", () => {
			it("calls markTaskBlocked", async () => {
				const { getTaskById, markTaskBlocked } = await import("../task.js");
				vi.mocked(getTaskById).mockReturnValue(createTask());
				const rec: MetaTaskRecommendation = {
					action: "block",
					taskId: "task-123",
					reason: "Needs dependency",
				};

				applyRecommendation(rec, ctx);

				expect(markTaskBlocked).toHaveBeenCalledWith({
					id: "task-123",
					reason: "Needs dependency",
				});
			});
		});

		describe("unblock handler", () => {
			it("calls unblockTask for blocked task", async () => {
				const { getTaskById, unblockTask } = await import("../task.js");
				vi.mocked(getTaskById).mockReturnValue(createTask({ status: "blocked" }));
				const rec: MetaTaskRecommendation = {
					action: "unblock",
					taskId: "task-123",
					reason: "Resolved",
				};

				applyRecommendation(rec, ctx);

				expect(unblockTask).toHaveBeenCalledWith("task-123");
			});
		});

		describe("manual review handlers", () => {
			it("logs info for merge action", async () => {
				const outputMock = await import("../output.js");
				const rec: MetaTaskRecommendation = {
					action: "merge",
					relatedTaskIds: ["task-1", "task-2"],
					reason: "Similar tasks",
				};

				applyRecommendation(rec, ctx);

				expect(outputMock.info).toHaveBeenCalledWith(expect.stringContaining("manual review"), expect.any(Object));
			});

			it("logs info for decompose action", async () => {
				const outputMock = await import("../output.js");
				const rec: MetaTaskRecommendation = {
					action: "decompose",
					taskId: "task-123",
					reason: "Too large",
				};

				applyRecommendation(rec, ctx);

				expect(outputMock.info).toHaveBeenCalledWith(expect.stringContaining("manual review"), expect.any(Object));
			});
		});

		describe("unknown action", () => {
			it("logs warning for unknown action", async () => {
				const outputMock = await import("../output.js");
				const rec = {
					action: "unknown_action",
					reason: "Test",
				} as MetaTaskRecommendation;

				applyRecommendation(rec, ctx);

				expect(outputMock.warning).toHaveBeenCalledWith(expect.stringContaining("Unknown recommendation action"));
			});
		});
	});
});
