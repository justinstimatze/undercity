/**
 * Persistence Module Tests
 *
 * Tests for SafePocket persistence operations.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock state - must be defined before vi.mock
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();

// Mock the fs module
vi.mock("node:fs", () => ({
	existsSync: vi.fn((path: string): boolean => {
		return mockFiles.has(path) || mockDirs.has(path);
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
	mkdirSync: vi.fn((path: string, _options?: { recursive?: boolean }): void => {
		mockDirs.add(path);
	}),
	renameSync: vi.fn((oldPath: string, newPath: string): void => {
		const content = mockFiles.get(oldPath);
		if (content !== undefined) {
			mockFiles.set(newPath, content);
			mockFiles.delete(oldPath);
		}
	}),
	unlinkSync: vi.fn((path: string): void => {
		mockFiles.delete(path);
	}),
}));

// Import after mocking
import { Persistence } from "../persistence.js";
import { createMockPocket } from "./helpers.js";

describe("Persistence", () => {
	let persistence: Persistence;

	beforeEach(() => {
		// Clear mock state before each test
		mockFiles.clear();
		mockDirs.clear();
		vi.clearAllMocks();

		// Create a fresh persistence instance
		persistence = new Persistence(".undercity");
	});

	describe("getPocket", () => {
		it("returns default pocket when file does not exist", () => {
			const pocket = persistence.getPocket();

			expect(pocket.lastUpdated).toBeInstanceOf(Date);
			expect(pocket.sessionId).toBeUndefined();
			expect(pocket.goal).toBeUndefined();
			expect(pocket.status).toBeUndefined();
		});

		it("parses existing pocket file correctly", () => {
			const existingPocket = createMockPocket({
				sessionId: "session-123",
				goal: "Build feature X",
				status: "executing",
			});
			mockFiles.set(".undercity/pocket.json", JSON.stringify(existingPocket));

			const pocket = persistence.getPocket();

			expect(pocket.sessionId).toBe("session-123");
			expect(pocket.goal).toBe("Build feature X");
			expect(pocket.status).toBe("executing");
		});

		it("returns default pocket when file contains invalid JSON", () => {
			mockFiles.set(".undercity/pocket.json", "{ invalid json }");

			const pocket = persistence.getPocket();

			expect(pocket.lastUpdated).toBeInstanceOf(Date);
			expect(pocket.sessionId).toBeUndefined();
		});
	});

	describe("savePocket", () => {
		it("updates lastUpdated timestamp on save", () => {
			const pocket = createMockPocket({
				sessionId: "session-456",
				lastUpdated: new Date("2020-01-01"),
			});

			const beforeSave = new Date();
			persistence.savePocket(pocket);
			const afterSave = new Date();

			const saved = JSON.parse(mockFiles.get(".undercity/pocket.json") ?? "{}");
			const savedDate = new Date(saved.lastUpdated);

			expect(savedDate.getTime()).toBeGreaterThanOrEqual(beforeSave.getTime());
			expect(savedDate.getTime()).toBeLessThanOrEqual(afterSave.getTime());
		});

		it("writes to correct path", () => {
			const pocket = createMockPocket({ sessionId: "session-789" });

			persistence.savePocket(pocket);

			expect(mockFiles.has(".undercity/pocket.json")).toBe(true);
			const saved = JSON.parse(mockFiles.get(".undercity/pocket.json") ?? "{}");
			expect(saved.sessionId).toBe("session-789");
		});

		it("creates directory if it does not exist", () => {
			// Clear directories to simulate missing parent
			mockDirs.clear();

			const customPersistence = new Persistence(".custom-state");
			const pocket = createMockPocket({ sessionId: "new-session" });

			customPersistence.savePocket(pocket);

			expect(mockDirs.has(".custom-state")).toBe(true);
		});
	});

	describe("clearPocket", () => {
		it("resets pocket to default state", () => {
			// Set up existing pocket with data
			const existingPocket = createMockPocket({
				sessionId: "old-session",
				goal: "Old goal",
				status: "complete",
			});
			mockFiles.set(".undercity/pocket.json", JSON.stringify(existingPocket));

			persistence.clearPocket();

			const cleared = persistence.getPocket();
			expect(cleared.sessionId).toBeUndefined();
			expect(cleared.goal).toBeUndefined();
			expect(cleared.status).toBeUndefined();
		});

		it("sets fresh lastUpdated timestamp", () => {
			const beforeClear = new Date();
			persistence.clearPocket();
			const afterClear = new Date();

			const pocket = persistence.getPocket();
			const pocketDate = new Date(pocket.lastUpdated);

			expect(pocketDate.getTime()).toBeGreaterThanOrEqual(beforeClear.getTime());
			expect(pocketDate.getTime()).toBeLessThanOrEqual(afterClear.getTime());
		});
	});

	describe("Inventory", () => {
		it("returns default inventory when file does not exist", () => {
			const inventory = persistence.getInventory();

			expect(inventory.steps).toEqual([]);
			expect(inventory.agents).toEqual([]);
			expect(inventory.lastUpdated).toBeInstanceOf(Date);
		});

		it("parses existing inventory file correctly", () => {
			const existingInventory = {
				steps: [{ id: "step-1", goal: "Test step" }],
				agents: [{ id: "agent-1", type: "builder" }],
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/inventory.json", JSON.stringify(existingInventory));

			const inventory = persistence.getInventory();

			expect(inventory.steps).toHaveLength(1);
			expect(inventory.steps[0].id).toBe("step-1");
			expect(inventory.agents).toHaveLength(1);
		});

		it("saveInventory updates lastUpdated", () => {
			const inventory = {
				steps: [],
				agents: [],
				lastUpdated: new Date("2020-01-01"),
			};

			persistence.saveInventory(inventory);

			const saved = JSON.parse(mockFiles.get(".undercity/inventory.json") ?? "{}");
			const savedDate = new Date(saved.lastUpdated);
			expect(savedDate.getFullYear()).toBeGreaterThan(2020);
		});
	});

	describe("Tasks", () => {
		it("getTasks returns steps from inventory", () => {
			const existingInventory = {
				steps: [{ id: "step-1", goal: "Test" }],
				agents: [],
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/inventory.json", JSON.stringify(existingInventory));

			const tasks = persistence.getTasks();

			expect(tasks).toHaveLength(1);
			expect(tasks[0].id).toBe("step-1");
		});

		it("saveTasks updates inventory steps", () => {
			const steps = [{ id: "new-step", goal: "New goal" }];

			persistence.saveTasks(steps as never);

			const saved = JSON.parse(mockFiles.get(".undercity/inventory.json") ?? "{}");
			expect(saved.steps).toHaveLength(1);
			expect(saved.steps[0].id).toBe("new-step");
		});

		it("addTasks appends to existing steps", () => {
			const existingInventory = {
				steps: [{ id: "step-1", goal: "Existing" }],
				agents: [],
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/inventory.json", JSON.stringify(existingInventory));

			persistence.addTasks({ id: "step-2", goal: "New" } as never);

			const tasks = persistence.getTasks();
			expect(tasks).toHaveLength(2);
		});

		it("updateTask modifies existing step", () => {
			const existingInventory = {
				steps: [{ id: "step-1", goal: "Original", status: "pending" }],
				agents: [],
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/inventory.json", JSON.stringify(existingInventory));

			persistence.updateTask("step-1", { status: "complete" } as never);

			const tasks = persistence.getTasks();
			expect(tasks[0].status).toBe("complete");
		});

		it("updateTask does nothing for non-existent step", () => {
			const existingInventory = {
				steps: [{ id: "step-1", goal: "Original" }],
				agents: [],
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/inventory.json", JSON.stringify(existingInventory));

			persistence.updateTask("non-existent", { goal: "Changed" } as never);

			const tasks = persistence.getTasks();
			expect(tasks[0].goal).toBe("Original");
		});
	});

	describe("Agents", () => {
		it("getAgents returns agents from inventory", () => {
			const existingInventory = {
				steps: [],
				agents: [{ id: "agent-1", type: "scout" }],
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/inventory.json", JSON.stringify(existingInventory));

			const agents = persistence.getAgents();

			expect(agents).toHaveLength(1);
			expect(agents[0].id).toBe("agent-1");
		});

		it("saveAgents updates inventory agents", () => {
			const agents = [{ id: "new-agent", type: "builder" }];

			persistence.saveAgents(agents as never);

			const saved = JSON.parse(mockFiles.get(".undercity/inventory.json") ?? "{}");
			expect(saved.agents).toHaveLength(1);
		});

		it("addAgent appends to existing agents", () => {
			const existingInventory = {
				steps: [],
				agents: [{ id: "agent-1", type: "scout" }],
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/inventory.json", JSON.stringify(existingInventory));

			persistence.addAgent({ id: "agent-2", type: "builder" } as never);

			const agents = persistence.getAgents();
			expect(agents).toHaveLength(2);
		});

		it("updateAgent modifies existing agent", () => {
			const existingInventory = {
				steps: [],
				agents: [{ id: "agent-1", type: "scout", status: "active" }],
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/inventory.json", JSON.stringify(existingInventory));

			persistence.updateAgent("agent-1", { status: "idle" } as never);

			const agents = persistence.getAgents();
			expect(agents[0].status).toBe("idle");
		});

		it("removeAgent filters out agent by id", () => {
			const existingInventory = {
				steps: [],
				agents: [
					{ id: "agent-1", type: "scout" },
					{ id: "agent-2", type: "builder" },
				],
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/inventory.json", JSON.stringify(existingInventory));

			persistence.removeAgent("agent-1");

			const agents = persistence.getAgents();
			expect(agents).toHaveLength(1);
			expect(agents[0].id).toBe("agent-2");
		});
	});

	describe("Loadout", () => {
		it("returns default loadout when file does not exist", () => {
			const loadout = persistence.getLoadout();

			expect(loadout.maxAgents).toBe(5);
			expect(loadout.autoApprove).toBe(false);
			expect(loadout.enabledAgentTypes).toContain("scout");
		});

		it("parses existing loadout file", () => {
			const existingLoadout = {
				maxAgents: 10,
				autoApprove: true,
				enabledAgentTypes: ["builder"],
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/loadout.json", JSON.stringify(existingLoadout));

			const loadout = persistence.getLoadout();

			expect(loadout.maxAgents).toBe(10);
			expect(loadout.autoApprove).toBe(true);
		});

		it("saveLoadout updates lastUpdated", () => {
			const loadout = {
				maxAgents: 3,
				enabledAgentTypes: ["scout"] as const,
				autoApprove: false,
				lastUpdated: new Date("2020-01-01"),
			};

			persistence.saveLoadout(loadout as never);

			const saved = JSON.parse(mockFiles.get(".undercity/loadout.json") ?? "{}");
			const savedDate = new Date(saved.lastUpdated);
			expect(savedDate.getFullYear()).toBeGreaterThan(2020);
		});
	});

	describe("File Tracking", () => {
		it("returns default file tracking when file does not exist", () => {
			const tracking = persistence.getFileTracking();

			expect(tracking.entries).toEqual({});
			expect(tracking.lastUpdated).toBeInstanceOf(Date);
		});

		it("saveFileTracking updates lastUpdated", () => {
			const state = {
				entries: { "file.ts": { agentId: "agent-1", modifiedAt: new Date() } },
				lastUpdated: new Date("2020-01-01"),
			};

			persistence.saveFileTracking(state as never);

			const saved = JSON.parse(mockFiles.get(".undercity/file-tracking.json") ?? "{}");
			expect(new Date(saved.lastUpdated).getFullYear()).toBeGreaterThan(2020);
		});

		it("clearFileTracking resets to empty state", () => {
			const existing = {
				entries: { "file.ts": { agentId: "agent-1" } },
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/file-tracking.json", JSON.stringify(existing));

			persistence.clearFileTracking();

			const tracking = persistence.getFileTracking();
			expect(tracking.entries).toEqual({});
		});
	});

	describe("Worktree State", () => {
		it("returns default worktree state when file does not exist", () => {
			const state = persistence.getWorktreeState();

			expect(state.worktrees).toEqual({});
			expect(state.lastUpdated).toBeInstanceOf(Date);
		});

		it("addWorktree adds worktree to state", () => {
			const worktreeInfo = {
				sessionId: "session-1",
				path: "/path/to/worktree",
				branch: "feature-branch",
				isActive: true,
				createdAt: new Date(),
			};

			persistence.addWorktree(worktreeInfo as never);

			const state = persistence.getWorktreeState();
			expect(state.worktrees["session-1"]).toBeDefined();
			expect(state.worktrees["session-1"].path).toBe("/path/to/worktree");
		});

		it("removeWorktree removes worktree from state", () => {
			const existing = {
				worktrees: {
					"session-1": { sessionId: "session-1", path: "/path", isActive: true },
					"session-2": { sessionId: "session-2", path: "/other", isActive: true },
				},
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/worktree-state.json", JSON.stringify(existing));

			persistence.removeWorktree("session-1");

			const state = persistence.getWorktreeState();
			expect(state.worktrees["session-1"]).toBeUndefined();
			expect(state.worktrees["session-2"]).toBeDefined();
		});

		it("getWorktreeForSession returns worktree or null", () => {
			const existing = {
				worktrees: {
					"session-1": { sessionId: "session-1", path: "/path", isActive: true },
				},
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/worktree-state.json", JSON.stringify(existing));

			expect(persistence.getWorktreeForSession("session-1")).not.toBeNull();
			expect(persistence.getWorktreeForSession("non-existent")).toBeNull();
		});

		it("getAllActiveWorktrees returns only active worktrees", () => {
			const existing = {
				worktrees: {
					"session-1": { sessionId: "session-1", path: "/path", isActive: true },
					"session-2": { sessionId: "session-2", path: "/other", isActive: false },
				},
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/worktree-state.json", JSON.stringify(existing));

			const active = persistence.getAllActiveWorktrees();

			expect(active).toHaveLength(1);
			expect(active[0].sessionId).toBe("session-1");
		});

		it("clearWorktreeState resets to empty state", () => {
			const existing = {
				worktrees: { "session-1": { path: "/path" } },
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/worktree-state.json", JSON.stringify(existing));

			persistence.clearWorktreeState();

			const state = persistence.getWorktreeState();
			expect(state.worktrees).toEqual({});
		});
	});

	describe("Parallel Recovery", () => {
		it("returns null when no recovery state exists", () => {
			const state = persistence.getParallelRecoveryState();
			expect(state).toBeNull();
		});

		it("saves and retrieves recovery state", () => {
			const recoveryState = {
				batchId: "batch-1",
				tasks: ["task-1", "task-2"],
				isComplete: false,
				lastUpdated: new Date(),
			};

			persistence.saveParallelRecoveryState(recoveryState as never);

			const retrieved = persistence.getParallelRecoveryState();
			expect(retrieved?.batchId).toBe("batch-1");
			expect(retrieved?.isComplete).toBe(false);
		});

		it("hasActiveParallelBatch returns true when incomplete batch exists", () => {
			const recoveryState = {
				batchId: "batch-1",
				isComplete: false,
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/parallel-recovery.json", JSON.stringify(recoveryState));

			expect(persistence.hasActiveParallelBatch()).toBe(true);
		});

		it("hasActiveParallelBatch returns false when batch is complete", () => {
			const recoveryState = {
				batchId: "batch-1",
				isComplete: true,
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/parallel-recovery.json", JSON.stringify(recoveryState));

			expect(persistence.hasActiveParallelBatch()).toBe(false);
		});

		it("clearParallelRecoveryState removes the file", () => {
			mockFiles.set(".undercity/parallel-recovery.json", JSON.stringify({ batchId: "batch-1" }));

			persistence.clearParallelRecoveryState();

			expect(mockFiles.has(".undercity/parallel-recovery.json")).toBe(false);
		});
	});

	describe("Rate Limit State", () => {
		it("returns default state when file does not exist", () => {
			const state = persistence.getRateLimitState();

			expect(state).not.toBeNull();
			expect(state?.tasks).toEqual([]);
			expect(state?.rateLimitHits).toEqual([]);
			expect(state?.config.maxTokensPer5Hours).toBe(1_000_000);
		});

		it("saves rate limit state", () => {
			const state = {
				tasks: [],
				rateLimitHits: [],
				config: {
					maxTokensPer5Hours: 500_000,
					maxTokensPerWeek: 2_000_000,
					warningThreshold: 0.9,
					tokenMultipliers: { haiku: 0.25, sonnet: 1.0, opus: 12.0 },
				},
				pause: { isPaused: false },
				lastUpdated: new Date(),
			};

			persistence.saveRateLimitState(state as never);

			const saved = JSON.parse(mockFiles.get(".undercity/rate-limit-state.json") ?? "{}");
			expect(saved.config.maxTokensPer5Hours).toBe(500_000);
		});
	});

	describe("Scout Cache", () => {
		it("returns default cache when file does not exist", () => {
			const cache = persistence.getScoutCache();

			expect(cache.entries).toEqual({});
			expect(cache.version).toBe("1.0");
		});

		it("getScoutCacheEntry returns null for non-existent entry", () => {
			const entry = persistence.getScoutCacheEntry("fingerprint", "goal");
			expect(entry).toBeNull();
		});

		it("saveScoutCacheEntry stores entry correctly", () => {
			persistence.saveScoutCacheEntry("fp-hash", "goal-hash", "result data", "test goal");

			const cache = persistence.getScoutCache();
			const entry = cache.entries["fp-hash:goal-hash"];
			expect(entry).toBeDefined();
			expect(entry.fluteResult).toBe("result data");
		});

		it("getScoutCacheStats returns correct stats", () => {
			const cache = {
				entries: {
					key1: { createdAt: new Date("2024-01-01").toISOString() },
					key2: { createdAt: new Date("2024-06-01").toISOString() },
				},
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/flute-cache.json", JSON.stringify(cache));

			const stats = persistence.getScoutCacheStats();

			expect(stats.entryCount).toBe(2);
			expect(stats.oldestEntry).toEqual(new Date("2024-01-01"));
			expect(stats.newestEntry).toEqual(new Date("2024-06-01"));
		});

		it("getScoutCacheStats returns null dates for empty cache", () => {
			const stats = persistence.getScoutCacheStats();

			expect(stats.entryCount).toBe(0);
			expect(stats.oldestEntry).toBeNull();
			expect(stats.newestEntry).toBeNull();
		});

		it("clearScoutCache resets to empty state", () => {
			const cache = {
				entries: { key1: { fluteResult: "data" } },
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};
			mockFiles.set(".undercity/flute-cache.json", JSON.stringify(cache));

			persistence.clearScoutCache();

			const cleared = persistence.getScoutCache();
			expect(cleared.entries).toEqual({});
		});
	});

	describe("clearAll", () => {
		it("clears pocket and inventory", () => {
			// Set up data
			mockFiles.set(".undercity/pocket.json", JSON.stringify({ sessionId: "test" }));
			mockFiles.set(".undercity/inventory.json", JSON.stringify({ steps: [{ id: "1" }], agents: [{ id: "a" }] }));

			persistence.clearAll();

			const pocket = persistence.getPocket();
			const inventory = persistence.getInventory();

			expect(pocket.sessionId).toBeUndefined();
			expect(inventory.steps).toEqual([]);
			expect(inventory.agents).toEqual([]);
		});
	});

	describe("Experiment Storage", () => {
		it("returns default value when file does not exist", () => {
			const data = persistence.getExperimentStorage({ key: "default" });
			expect(data).toEqual({ key: "default" });
		});

		it("saves and retrieves experiment storage", () => {
			persistence.saveExperimentStorage({ experimentId: "exp-1", data: [1, 2, 3] });

			const retrieved = persistence.getExperimentStorage({ experimentId: "" });
			expect(retrieved.experimentId).toBe("exp-1");
		});
	});

	describe("Agent Sessions", () => {
		it("returns undefined for non-existent session", () => {
			const session = persistence.getAgentSession("agent-1");
			expect(session).toBeUndefined();
		});

		it("saves and retrieves agent session", () => {
			persistence.saveAgentSession("agent-1", "session-123");

			const session = persistence.getAgentSession("agent-1");
			expect(session).toBe("session-123");
		});
	});
});
