/**
 * Backlog Module Tests
 *
 * Tests for the goal backlog management functions.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock state - must be defined before vi.mock
const mockFiles = new Map<string, string>();

// Mock the fs module
vi.mock("node:fs", () => ({
	existsSync: vi.fn((path: string): boolean => {
		return mockFiles.has(path);
	}),
	readFileSync: vi.fn((path: string, _encoding: string): string => {
		const content = mockFiles.get(path);
		if (content === undefined) {
			throw new Error(`ENOENT: no such file or directory, open '${path}'`);
		}
		return content;
	}),
	writeFileSync: vi.fn((path: string, data: string): void => {
		mockFiles.set(path, data);
	}),
}));

// Import after mocking
import {
	addGoal,
	addGoals,
	clearCompleted,
	getAllItems,
	getBacklogSummary,
	getNextGoal,
	loadBacklog,
	markComplete,
	markFailed,
	markInProgress,
	saveBacklog,
	type BacklogItem,
	type Backlog,
} from "../backlog.js";

describe("Backlog", () => {
	beforeEach(() => {
		// Clear mock state before each test
		mockFiles.clear();
		vi.clearAllMocks();
	});

	describe("loadBacklog", () => {
		it("returns empty backlog when file does not exist", () => {
			const backlog = loadBacklog();

			expect(backlog.items).toEqual([]);
			expect(backlog.lastUpdated).toBeInstanceOf(Date);
		});

		it("parses existing backlog file correctly", () => {
			const existingBacklog: Backlog = {
				items: [
					{
						id: "goal-1",
						goal: "Test goal",
						status: "pending",
						createdAt: new Date("2024-01-01"),
					},
				],
				lastUpdated: new Date("2024-01-01"),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(existingBacklog));

			const backlog = loadBacklog();

			expect(backlog.items).toHaveLength(1);
			expect(backlog.items[0].goal).toBe("Test goal");
		});

		it("returns empty backlog when file contains invalid JSON", () => {
			mockFiles.set(".undercity/backlog.json", "{ invalid json }");

			const backlog = loadBacklog();

			expect(backlog.items).toEqual([]);
		});
	});

	describe("saveBacklog", () => {
		it("updates lastUpdated timestamp on save", () => {
			const backlog: Backlog = {
				items: [],
				lastUpdated: new Date("2020-01-01"),
			};

			const beforeSave = new Date();
			saveBacklog(backlog);
			const afterSave = new Date();

			const saved = JSON.parse(mockFiles.get(".undercity/backlog.json") ?? "{}");
			const savedDate = new Date(saved.lastUpdated);

			expect(savedDate.getTime()).toBeGreaterThanOrEqual(beforeSave.getTime());
			expect(savedDate.getTime()).toBeLessThanOrEqual(afterSave.getTime());
		});

		it("writes to correct path", () => {
			const backlog: Backlog = {
				items: [{ id: "goal-test", goal: "Save test", status: "pending", createdAt: new Date() }],
				lastUpdated: new Date(),
			};

			saveBacklog(backlog);

			expect(mockFiles.has(".undercity/backlog.json")).toBe(true);
			const saved = JSON.parse(mockFiles.get(".undercity/backlog.json") ?? "{}");
			expect(saved.items).toHaveLength(1);
		});
	});

	describe("addGoal", () => {
		it("creates a new backlog item with pending status", () => {
			const item = addGoal("Build new feature");

			expect(item.goal).toBe("Build new feature");
			expect(item.status).toBe("pending");
			expect(item.id).toMatch(/^goal-/);
		});

		it("assigns priority based on existing items count when not specified", () => {
			// Add some existing items
			const existingBacklog: Backlog = {
				items: [
					{ id: "goal-1", goal: "First", status: "pending", priority: 0, createdAt: new Date() },
					{ id: "goal-2", goal: "Second", status: "pending", priority: 1, createdAt: new Date() },
				],
				lastUpdated: new Date(),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(existingBacklog));

			const item = addGoal("Third goal");

			expect(item.priority).toBe(2);
		});

		it("uses specified priority when provided", () => {
			const item = addGoal("High priority goal", 0);

			expect(item.priority).toBe(0);
		});

		it("saves the backlog after adding", () => {
			addGoal("Test goal");

			const saved = JSON.parse(mockFiles.get(".undercity/backlog.json") ?? "{}");
			expect(saved.items).toHaveLength(1);
			expect(saved.items[0].goal).toBe("Test goal");
		});

		it("generates unique IDs for consecutive goals", () => {
			const item1 = addGoal("Goal 1");
			const item2 = addGoal("Goal 2");

			expect(item1.id).not.toBe(item2.id);
		});
	});

	describe("addGoals", () => {
		it("adds multiple goals at once", () => {
			const goals = ["Goal A", "Goal B", "Goal C"];

			const items = addGoals(goals);

			expect(items).toHaveLength(3);
			expect(items[0].goal).toBe("Goal A");
			expect(items[1].goal).toBe("Goal B");
			expect(items[2].goal).toBe("Goal C");
		});

		it("assigns sequential priorities based on existing items", () => {
			const existingBacklog: Backlog = {
				items: [{ id: "goal-1", goal: "Existing", status: "pending", priority: 0, createdAt: new Date() }],
				lastUpdated: new Date(),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(existingBacklog));

			const items = addGoals(["New A", "New B"]);

			expect(items[0].priority).toBe(1);
			expect(items[1].priority).toBe(2);
		});

		it("returns empty array for empty goals list", () => {
			const items = addGoals([]);

			expect(items).toEqual([]);
		});
	});

	describe("getNextGoal", () => {
		it("returns undefined when no pending goals exist", () => {
			const backlog: Backlog = {
				items: [{ id: "goal-1", goal: "Complete", status: "complete", createdAt: new Date() }],
				lastUpdated: new Date(),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(backlog));

			const next = getNextGoal();

			expect(next).toBeUndefined();
		});

		it("returns the pending goal with lowest priority", () => {
			const backlog: Backlog = {
				items: [
					{ id: "goal-low", goal: "Low priority", status: "pending", priority: 10, createdAt: new Date() },
					{ id: "goal-high", goal: "High priority", status: "pending", priority: 1, createdAt: new Date() },
					{ id: "goal-mid", goal: "Mid priority", status: "pending", priority: 5, createdAt: new Date() },
				],
				lastUpdated: new Date(),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(backlog));

			const next = getNextGoal();

			expect(next?.id).toBe("goal-high");
			expect(next?.priority).toBe(1);
		});

		it("skips in_progress and complete goals", () => {
			const backlog: Backlog = {
				items: [
					{ id: "goal-1", goal: "In progress", status: "in_progress", priority: 0, createdAt: new Date() },
					{ id: "goal-2", goal: "Complete", status: "complete", priority: 1, createdAt: new Date() },
					{ id: "goal-3", goal: "Pending", status: "pending", priority: 2, createdAt: new Date() },
				],
				lastUpdated: new Date(),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(backlog));

			const next = getNextGoal();

			expect(next?.id).toBe("goal-3");
		});
	});

	describe("markInProgress", () => {
		it("updates goal status to in_progress", () => {
			const backlog: Backlog = {
				items: [{ id: "goal-1", goal: "Test", status: "pending", createdAt: new Date() }],
				lastUpdated: new Date(),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(backlog));

			markInProgress("goal-1", "raid-123");

			const saved = JSON.parse(mockFiles.get(".undercity/backlog.json") ?? "{}");
			expect(saved.items[0].status).toBe("in_progress");
			expect(saved.items[0].raidId).toBe("raid-123");
		});

		it("sets startedAt timestamp", () => {
			const backlog: Backlog = {
				items: [{ id: "goal-1", goal: "Test", status: "pending", createdAt: new Date() }],
				lastUpdated: new Date(),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(backlog));

			const before = new Date();
			markInProgress("goal-1", "raid-123");
			const after = new Date();

			const saved = JSON.parse(mockFiles.get(".undercity/backlog.json") ?? "{}");
			const startedAt = new Date(saved.items[0].startedAt);
			expect(startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
			expect(startedAt.getTime()).toBeLessThanOrEqual(after.getTime());
		});

		it("does nothing for non-existent goal", () => {
			const backlog: Backlog = {
				items: [{ id: "goal-1", goal: "Test", status: "pending", createdAt: new Date() }],
				lastUpdated: new Date(),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(backlog));

			markInProgress("non-existent", "raid-123");

			const saved = JSON.parse(mockFiles.get(".undercity/backlog.json") ?? "{}");
			expect(saved.items[0].status).toBe("pending");
		});
	});

	describe("markComplete", () => {
		it("updates goal status to complete", () => {
			const backlog: Backlog = {
				items: [{ id: "goal-1", goal: "Test", status: "in_progress", createdAt: new Date() }],
				lastUpdated: new Date(),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(backlog));

			markComplete("goal-1");

			const saved = JSON.parse(mockFiles.get(".undercity/backlog.json") ?? "{}");
			expect(saved.items[0].status).toBe("complete");
		});

		it("sets completedAt timestamp", () => {
			const backlog: Backlog = {
				items: [{ id: "goal-1", goal: "Test", status: "in_progress", createdAt: new Date() }],
				lastUpdated: new Date(),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(backlog));

			const before = new Date();
			markComplete("goal-1");
			const after = new Date();

			const saved = JSON.parse(mockFiles.get(".undercity/backlog.json") ?? "{}");
			const completedAt = new Date(saved.items[0].completedAt);
			expect(completedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
			expect(completedAt.getTime()).toBeLessThanOrEqual(after.getTime());
		});
	});

	describe("markFailed", () => {
		it("updates goal status to failed", () => {
			const backlog: Backlog = {
				items: [{ id: "goal-1", goal: "Test", status: "in_progress", createdAt: new Date() }],
				lastUpdated: new Date(),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(backlog));

			markFailed("goal-1", "Something went wrong");

			const saved = JSON.parse(mockFiles.get(".undercity/backlog.json") ?? "{}");
			expect(saved.items[0].status).toBe("failed");
			expect(saved.items[0].error).toBe("Something went wrong");
		});

		it("sets completedAt timestamp", () => {
			const backlog: Backlog = {
				items: [{ id: "goal-1", goal: "Test", status: "in_progress", createdAt: new Date() }],
				lastUpdated: new Date(),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(backlog));

			markFailed("goal-1", "Error");

			const saved = JSON.parse(mockFiles.get(".undercity/backlog.json") ?? "{}");
			expect(saved.items[0].completedAt).toBeDefined();
		});
	});

	describe("getBacklogSummary", () => {
		it("returns correct counts for each status", () => {
			const backlog: Backlog = {
				items: [
					{ id: "1", goal: "Pending 1", status: "pending", createdAt: new Date() },
					{ id: "2", goal: "Pending 2", status: "pending", createdAt: new Date() },
					{ id: "3", goal: "In Progress", status: "in_progress", createdAt: new Date() },
					{ id: "4", goal: "Complete", status: "complete", createdAt: new Date() },
					{ id: "5", goal: "Failed", status: "failed", createdAt: new Date() },
				],
				lastUpdated: new Date(),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(backlog));

			const summary = getBacklogSummary();

			expect(summary.pending).toBe(2);
			expect(summary.inProgress).toBe(1);
			expect(summary.complete).toBe(1);
			expect(summary.failed).toBe(1);
		});

		it("returns zeros when backlog is empty", () => {
			const summary = getBacklogSummary();

			expect(summary.pending).toBe(0);
			expect(summary.inProgress).toBe(0);
			expect(summary.complete).toBe(0);
			expect(summary.failed).toBe(0);
		});
	});

	describe("clearCompleted", () => {
		it("removes completed items from backlog", () => {
			const backlog: Backlog = {
				items: [
					{ id: "1", goal: "Complete", status: "complete", createdAt: new Date() },
					{ id: "2", goal: "Pending", status: "pending", createdAt: new Date() },
					{ id: "3", goal: "Complete 2", status: "complete", createdAt: new Date() },
				],
				lastUpdated: new Date(),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(backlog));

			const removed = clearCompleted();

			expect(removed).toBe(2);
			const saved = JSON.parse(mockFiles.get(".undercity/backlog.json") ?? "{}");
			expect(saved.items).toHaveLength(1);
			expect(saved.items[0].id).toBe("2");
		});

		it("returns 0 when no completed items exist", () => {
			const backlog: Backlog = {
				items: [
					{ id: "1", goal: "Pending", status: "pending", createdAt: new Date() },
					{ id: "2", goal: "In Progress", status: "in_progress", createdAt: new Date() },
				],
				lastUpdated: new Date(),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(backlog));

			const removed = clearCompleted();

			expect(removed).toBe(0);
		});
	});

	describe("getAllItems", () => {
		it("returns all items in backlog", () => {
			const backlog: Backlog = {
				items: [
					{ id: "1", goal: "One", status: "pending", createdAt: new Date() },
					{ id: "2", goal: "Two", status: "complete", createdAt: new Date() },
				],
				lastUpdated: new Date(),
			};
			mockFiles.set(".undercity/backlog.json", JSON.stringify(backlog));

			const items = getAllItems();

			expect(items).toHaveLength(2);
		});

		it("returns empty array when backlog is empty", () => {
			const items = getAllItems();

			expect(items).toEqual([]);
		});
	});
});
