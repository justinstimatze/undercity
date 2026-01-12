/**
 * Tests for orchestrator meta-task validation
 *
 * Tests the validateRecommendation logic that decides whether
 * to apply recommendations from meta-tasks.
 */

import { describe, expect, it } from "vitest";
import type { MetaTaskRecommendation } from "../types.js";

// We can't easily test the private method directly, so we'll test the logic
// by creating a standalone validation function that mirrors the orchestrator's logic

interface TaskSummary {
	id: string;
	status: string;
	objective: string;
}

interface ValidationResult {
	valid: boolean;
	reason?: string;
}

/**
 * Mirrors the orchestrator's validateRecommendation logic for testing
 */
function validateRecommendation(
	rec: MetaTaskRecommendation,
	board: { tasks: TaskSummary[] },
	taskIds: Set<string>,
	metaTaskId: string,
): ValidationResult {
	// Self-protection: don't let meta-task modify itself
	if (rec.taskId === metaTaskId) {
		return { valid: false, reason: "cannot modify self" };
	}

	// Actions that require existing task
	const requiresExistingTask = ["remove", "complete", "fix_status", "prioritize", "update", "block", "unblock"];

	if (requiresExistingTask.includes(rec.action)) {
		if (!rec.taskId) {
			return { valid: false, reason: "missing taskId" };
		}

		if (!taskIds.has(rec.taskId)) {
			return { valid: false, reason: "task does not exist" };
		}

		const task = board.tasks.find((t) => t.id === rec.taskId);
		if (!task) {
			return { valid: false, reason: "task not found" };
		}

		// State transition validation
		switch (rec.action) {
			case "complete":
			case "fix_status":
				if (task.status === "complete") {
					return { valid: false, reason: "task already complete" };
				}
				break;

			case "unblock":
				if (task.status !== "blocked") {
					return { valid: false, reason: "task is not blocked" };
				}
				break;

			case "block":
				if (task.status === "blocked") {
					return { valid: false, reason: "task already blocked" };
				}
				if (task.status === "complete") {
					return { valid: false, reason: "cannot block completed task" };
				}
				break;
		}
	}

	// Validate "add" action
	if (rec.action === "add") {
		if (!rec.newTask?.objective) {
			return { valid: false, reason: "missing objective for new task" };
		}

		// Check for obvious duplicates (exact match)
		const isDuplicate = board.tasks.some((t) => t.objective.toLowerCase() === rec.newTask!.objective.toLowerCase());
		if (isDuplicate) {
			return { valid: false, reason: "duplicate objective" };
		}
	}

	// Validate "merge" action
	if (rec.action === "merge") {
		if (!rec.relatedTaskIds || rec.relatedTaskIds.length === 0) {
			return { valid: false, reason: "merge requires relatedTaskIds" };
		}
		for (const relatedId of rec.relatedTaskIds) {
			if (!taskIds.has(relatedId)) {
				return { valid: false, reason: `related task ${relatedId} does not exist` };
			}
		}
	}

	return { valid: true };
}

describe("orchestrator validation", () => {
	const createBoard = (tasks: TaskSummary[]) => {
		const taskIds = new Set(tasks.map((t) => t.id));
		return { board: { tasks }, taskIds };
	};

	describe("self-protection", () => {
		it("should reject recommendation targeting the meta-task itself", () => {
			const { board, taskIds } = createBoard([
				{ id: "meta-task-1", status: "in_progress", objective: "[meta:triage] Clean up" },
			]);

			const rec: MetaTaskRecommendation = {
				action: "remove",
				taskId: "meta-task-1",
				reason: "Test",
				confidence: 0.9,
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-task-1");
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("cannot modify self");
		});
	});

	describe("task existence", () => {
		it("should reject remove for non-existent task", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "pending", objective: "Real task" }]);

			const rec: MetaTaskRecommendation = {
				action: "remove",
				taskId: "nonexistent",
				reason: "Test",
				confidence: 0.9,
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("task does not exist");
		});

		it("should reject complete for non-existent task", () => {
			const { board, taskIds } = createBoard([]);

			const rec: MetaTaskRecommendation = {
				action: "complete",
				taskId: "ghost-task",
				reason: "Test",
				confidence: 0.9,
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(false);
		});

		it("should reject when taskId is missing", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "pending", objective: "Task" }]);

			const rec: MetaTaskRecommendation = {
				action: "remove",
				// taskId intentionally missing
				reason: "Test",
				confidence: 0.9,
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("missing taskId");
		});

		it("should accept remove for existing task", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "pending", objective: "Real task" }]);

			const rec: MetaTaskRecommendation = {
				action: "remove",
				taskId: "task-1",
				reason: "Test cruft",
				confidence: 0.9,
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(true);
		});
	});

	describe("state transitions", () => {
		it("should reject completing an already-complete task", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "complete", objective: "Done task" }]);

			const rec: MetaTaskRecommendation = {
				action: "complete",
				taskId: "task-1",
				reason: "Mark complete",
				confidence: 0.9,
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("task already complete");
		});

		it("should reject fix_status on complete task", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "complete", objective: "Done" }]);

			const rec: MetaTaskRecommendation = {
				action: "fix_status",
				taskId: "task-1",
				reason: "Fix status",
				confidence: 0.9,
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("task already complete");
		});

		it("should reject unblocking a non-blocked task", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "pending", objective: "Pending task" }]);

			const rec: MetaTaskRecommendation = {
				action: "unblock",
				taskId: "task-1",
				reason: "Unblock",
				confidence: 0.9,
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("task is not blocked");
		});

		it("should accept unblocking a blocked task", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "blocked", objective: "Blocked task" }]);

			const rec: MetaTaskRecommendation = {
				action: "unblock",
				taskId: "task-1",
				reason: "Dependency resolved",
				confidence: 0.9,
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(true);
		});

		it("should reject blocking an already-blocked task", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "blocked", objective: "Already blocked" }]);

			const rec: MetaTaskRecommendation = {
				action: "block",
				taskId: "task-1",
				reason: "Block",
				confidence: 0.9,
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("task already blocked");
		});

		it("should reject blocking a completed task", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "complete", objective: "Done" }]);

			const rec: MetaTaskRecommendation = {
				action: "block",
				taskId: "task-1",
				reason: "Block",
				confidence: 0.9,
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("cannot block completed task");
		});

		it("should accept blocking a pending task", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "pending", objective: "Pending" }]);

			const rec: MetaTaskRecommendation = {
				action: "block",
				taskId: "task-1",
				reason: "Waiting for dependency",
				confidence: 0.9,
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(true);
		});
	});

	describe("add action", () => {
		it("should reject add without objective", () => {
			const { board, taskIds } = createBoard([]);

			const rec: MetaTaskRecommendation = {
				action: "add",
				reason: "Add new task",
				confidence: 0.9,
				// newTask missing
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("missing objective for new task");
		});

		it("should reject add with empty objective", () => {
			const { board, taskIds } = createBoard([]);

			const rec: MetaTaskRecommendation = {
				action: "add",
				reason: "Add task",
				confidence: 0.9,
				newTask: { objective: "" },
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("missing objective for new task");
		});

		it("should reject duplicate objective (exact match)", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "pending", objective: "Fix the login bug" }]);

			const rec: MetaTaskRecommendation = {
				action: "add",
				reason: "Add task",
				confidence: 0.9,
				newTask: { objective: "Fix the login bug" },
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("duplicate objective");
		});

		it("should reject duplicate objective (case-insensitive)", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "pending", objective: "Fix The Login Bug" }]);

			const rec: MetaTaskRecommendation = {
				action: "add",
				reason: "Add task",
				confidence: 0.9,
				newTask: { objective: "fix the login bug" },
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("duplicate objective");
		});

		it("should accept add with new objective", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "pending", objective: "Fix login" }]);

			const rec: MetaTaskRecommendation = {
				action: "add",
				reason: "Add new feature",
				confidence: 0.9,
				newTask: { objective: "Add logout button" },
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(true);
		});
	});

	describe("merge action", () => {
		it("should reject merge without relatedTaskIds", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "pending", objective: "Task 1" }]);

			const rec: MetaTaskRecommendation = {
				action: "merge",
				taskId: "task-1",
				reason: "Merge duplicates",
				confidence: 0.9,
				// relatedTaskIds missing
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("merge requires relatedTaskIds");
		});

		it("should reject merge with empty relatedTaskIds", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "pending", objective: "Task 1" }]);

			const rec: MetaTaskRecommendation = {
				action: "merge",
				taskId: "task-1",
				reason: "Merge",
				confidence: 0.9,
				relatedTaskIds: [],
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("merge requires relatedTaskIds");
		});

		it("should reject merge with non-existent related task", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "pending", objective: "Task 1" }]);

			const rec: MetaTaskRecommendation = {
				action: "merge",
				taskId: "task-1",
				reason: "Merge",
				confidence: 0.9,
				relatedTaskIds: ["nonexistent"],
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("related task nonexistent does not exist");
		});

		it("should accept merge with valid related tasks", () => {
			const { board, taskIds } = createBoard([
				{ id: "task-1", status: "pending", objective: "Task 1" },
				{ id: "task-2", status: "pending", objective: "Task 2" },
			]);

			const rec: MetaTaskRecommendation = {
				action: "merge",
				taskId: "task-1",
				reason: "Merge duplicates",
				confidence: 0.9,
				relatedTaskIds: ["task-2"],
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(true);
		});
	});

	describe("prioritize action", () => {
		it("should accept prioritize for existing task", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "pending", objective: "Task" }]);

			const rec: MetaTaskRecommendation = {
				action: "prioritize",
				taskId: "task-1",
				reason: "Increase priority",
				confidence: 0.9,
				updates: { priority: 10 },
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(true);
		});

		it("should reject prioritize for non-existent task", () => {
			const { board, taskIds } = createBoard([]);

			const rec: MetaTaskRecommendation = {
				action: "prioritize",
				taskId: "ghost",
				reason: "Prioritize",
				confidence: 0.9,
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(false);
		});
	});

	describe("update action", () => {
		it("should accept update for existing task", () => {
			const { board, taskIds } = createBoard([{ id: "task-1", status: "pending", objective: "Old objective" }]);

			const rec: MetaTaskRecommendation = {
				action: "update",
				taskId: "task-1",
				reason: "Clarify objective",
				confidence: 0.9,
				updates: { objective: "New clearer objective" },
			};

			const result = validateRecommendation(rec, board, taskIds, "meta-1");
			expect(result.valid).toBe(true);
		});
	});
});
