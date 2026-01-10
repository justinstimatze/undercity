/**
 * Raid Module Tests
 *
 * Tests for RaidOrchestrator - the core raid lifecycle management.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted to ensure mock state is available when vi.mock runs
const { mockFiles, mockDirs } = vi.hoisted(() => ({
	mockFiles: new Map<string, string>(),
	mockDirs: new Set<string>(),
}));

// Mock the fs module
vi.mock("node:fs", () => {
	// Create a mock WriteStream
	const createMockWriteStream = () => ({
		write: vi.fn((_data: string, _encoding?: string, callback?: () => void) => {
			if (callback) callback();
			return true;
		}),
		end: vi.fn((callback?: () => void) => {
			if (callback) callback();
		}),
		on: vi.fn(),
	});

	return {
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
		createWriteStream: vi.fn(() => createMockWriteStream()),
		renameSync: vi.fn(),
	};
});

// Mock the git module to avoid actual git operations
vi.mock("../git.js", () => {
	// Use a class for the mock to ensure it's constructable
	class MockElevator {
		add = vi.fn();
		processAll = vi.fn().mockResolvedValue([]);
		getQueue = vi.fn().mockReturnValue([]);
	}
	return {
		createAndCheckout: vi.fn(),
		Elevator: MockElevator,
	};
});

// Mock the SDK to avoid actual API calls
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn().mockImplementation(async function* () {
		yield { type: "system", subtype: "init", session_id: "mock-session-123" };
		yield { type: "result", subtype: "success", result: "Mock flute report: Found 3 files to modify." };
	}),
}));

// Import after mocking
import { RaidOrchestrator } from "../raid.js";
import { createMockInventory, createMockPocket, createMockRaid } from "./helpers.js";

describe("RaidOrchestrator", () => {
	let orchestrator: RaidOrchestrator;

	beforeEach(() => {
		// Clear mock state before each test
		mockFiles.clear();
		mockDirs.clear();
		vi.clearAllMocks();

		// Create a fresh orchestrator instance
		orchestrator = new RaidOrchestrator({
			stateDir: ".undercity",
			maxSquadSize: 5,
			autoApprove: false,
			verbose: false,
		});
	});

	describe("constructor", () => {
		it("creates orchestrator with default options", () => {
			const defaultOrchestrator = new RaidOrchestrator();

			expect(defaultOrchestrator).toBeDefined();
			expect(defaultOrchestrator.hasActiveRaid()).toBe(false);
		});

		it("creates orchestrator with custom options", () => {
			const customOrchestrator = new RaidOrchestrator({
				stateDir: ".custom-state",
				maxSquadSize: 10,
				autoApprove: true,
				verbose: true,
			});

			expect(customOrchestrator).toBeDefined();
		});
	});

	describe("hasActiveRaid", () => {
		it("returns false when no raid exists", () => {
			expect(orchestrator.hasActiveRaid()).toBe(false);
		});

		it("returns true when active raid exists in pocket", () => {
			const pocket = createMockPocket({
				raidId: "raid-123",
				raidStatus: "executing",
			});
			mockFiles.set(".undercity/pocket.json", JSON.stringify(pocket));

			// Create new orchestrator to reload state
			orchestrator = new RaidOrchestrator({ stateDir: ".undercity" });

			expect(orchestrator.hasActiveRaid()).toBe(true);
		});

		it("returns false when raid status is complete", () => {
			const pocket = createMockPocket({
				raidId: "raid-123",
				raidStatus: "complete",
			});
			mockFiles.set(".undercity/pocket.json", JSON.stringify(pocket));

			orchestrator = new RaidOrchestrator({ stateDir: ".undercity" });

			expect(orchestrator.hasActiveRaid()).toBe(false);
		});

		it("returns false when raid status is failed", () => {
			const pocket = createMockPocket({
				raidId: "raid-123",
				raidStatus: "failed",
			});
			mockFiles.set(".undercity/pocket.json", JSON.stringify(pocket));

			orchestrator = new RaidOrchestrator({ stateDir: ".undercity" });

			expect(orchestrator.hasActiveRaid()).toBe(false);
		});
	});

	describe("getCurrentRaid", () => {
		it("returns undefined when no raid exists", () => {
			expect(orchestrator.getCurrentRaid()).toBeUndefined();
		});

		it("returns raid from inventory when present", () => {
			const raid = createMockRaid({
				id: "raid-abc",
				goal: "Test goal",
				status: "planning",
			});
			const inventory = createMockInventory({ raid });
			mockFiles.set(".undercity/inventory.json", JSON.stringify(inventory));

			orchestrator = new RaidOrchestrator({ stateDir: ".undercity" });

			const result = orchestrator.getCurrentRaid();
			expect(result).toBeDefined();
			expect(result?.id).toBe("raid-abc");
			expect(result?.goal).toBe("Test goal");
		});
	});

	describe("getStatus", () => {
		it("returns empty status when no raid exists", () => {
			const status = orchestrator.getStatus();

			expect(status.raid).toBeUndefined();
			expect(status.waypoints).toEqual([]);
			expect(status.squad).toEqual([]);
			expect(status.elevator).toEqual([]);
		});

		it("returns full status when raid exists", () => {
			const raid = createMockRaid({
				id: "raid-status-test",
				goal: "Status test",
				status: "executing",
			});
			const inventory = createMockInventory({
				raid,
				waypoints: [
					{
						id: "waypoint-1",
						raidId: "raid-status-test",
						type: "flute",
						description: "Flute waypoint",
						status: "complete",
						createdAt: new Date(),
					},
				],
				squad: [
					{
						id: "flute-1",
						type: "flute",
						status: "done",
						spawnedAt: new Date(),
						lastActivityAt: new Date(),
					},
				],
			});
			mockFiles.set(".undercity/inventory.json", JSON.stringify(inventory));

			orchestrator = new RaidOrchestrator({ stateDir: ".undercity" });
			const status = orchestrator.getStatus();

			expect(status.raid).toBeDefined();
			expect(status.raid?.id).toBe("raid-status-test");
			expect(status.waypoints).toHaveLength(1);
			expect(status.squad).toHaveLength(1);
		});
	});

	describe("surrender", () => {
		it("does nothing when no raid exists", () => {
			// Should not throw
			orchestrator.surrender();

			expect(orchestrator.hasActiveRaid()).toBe(false);
		});

		it("marks raid as failed and clears pocket", () => {
			const raid = createMockRaid({
				id: "raid-surrender",
				goal: "Surrender test",
				status: "executing",
			});
			const inventory = createMockInventory({ raid });
			const pocket = createMockPocket({
				raidId: "raid-surrender",
				raidStatus: "executing",
			});
			mockFiles.set(".undercity/inventory.json", JSON.stringify(inventory));
			mockFiles.set(".undercity/pocket.json", JSON.stringify(pocket));

			orchestrator = new RaidOrchestrator({ stateDir: ".undercity" });
			orchestrator.surrender();

			// Check raid was added to stash as failed (surrender clears inventory via clearAll)
			const stash = JSON.parse(mockFiles.get(".undercity/stash.json") || "{}");
			expect(stash.completedRaids).toBeDefined();
			expect(stash.completedRaids).toHaveLength(1);
			expect(stash.completedRaids[0].id).toBe("raid-surrender");
			expect(stash.completedRaids[0].success).toBe(false);

			// Check pocket was cleared
			const updatedPocket = JSON.parse(mockFiles.get(".undercity/pocket.json") || "{}");
			expect(updatedPocket.raidId).toBeUndefined();

			// Check inventory was cleared (surrender calls clearAll)
			const updatedInventory = JSON.parse(mockFiles.get(".undercity/inventory.json") || "{}");
			expect(updatedInventory.raid).toBeUndefined();
		});
	});

	describe("extract", () => {
		it("throws when no active raid exists", async () => {
			await expect(orchestrator.extract()).rejects.toThrow("No active raid to extract");
		});

		it("marks raid as complete and clears pocket", async () => {
			const raid = createMockRaid({
				id: "raid-extract",
				goal: "Extract test",
				status: "merging",
			});
			const inventory = createMockInventory({ raid });
			const pocket = createMockPocket({
				raidId: "raid-extract",
				raidStatus: "merging",
			});
			mockFiles.set(".undercity/inventory.json", JSON.stringify(inventory));
			mockFiles.set(".undercity/pocket.json", JSON.stringify(pocket));

			orchestrator = new RaidOrchestrator({ stateDir: ".undercity" });
			await orchestrator.extract();

			// Check raid was marked as complete
			const updatedInventory = JSON.parse(mockFiles.get(".undercity/inventory.json") || "{}");
			expect(updatedInventory.raid.status).toBe("complete");
			expect(updatedInventory.raid.completedAt).toBeDefined();

			// Check pocket was cleared
			const updatedPocket = JSON.parse(mockFiles.get(".undercity/pocket.json") || "{}");
			expect(updatedPocket.raidId).toBeUndefined();
		});

		it("adds raid to stash history", async () => {
			const raid = createMockRaid({
				id: "raid-history",
				goal: "History test",
				status: "merging",
			});
			const inventory = createMockInventory({ raid });
			mockFiles.set(".undercity/inventory.json", JSON.stringify(inventory));

			orchestrator = new RaidOrchestrator({ stateDir: ".undercity" });
			await orchestrator.extract();

			// Check stash has the completed raid
			const stash = JSON.parse(mockFiles.get(".undercity/stash.json") || "{}");
			expect(stash.completedRaids).toBeDefined();
			expect(stash.completedRaids).toHaveLength(1);
			expect(stash.completedRaids[0].id).toBe("raid-history");
			expect(stash.completedRaids[0].success).toBe(true);
		});
	});

	describe("approvePlan", () => {
		it("throws when no raid exists", async () => {
			await expect(orchestrator.approvePlan()).rejects.toThrow("No raid awaiting approval");
		});

		it("throws when raid is not awaiting approval", async () => {
			const raid = createMockRaid({
				id: "raid-wrong-status",
				goal: "Wrong status test",
				status: "planning", // Not "awaiting_approval"
			});
			const inventory = createMockInventory({ raid });
			mockFiles.set(".undercity/inventory.json", JSON.stringify(inventory));

			orchestrator = new RaidOrchestrator({ stateDir: ".undercity" });

			await expect(orchestrator.approvePlan()).rejects.toThrow("No raid awaiting approval");
		});

		it("transitions raid to executing status when approved", async () => {
			const raid = createMockRaid({
				id: "raid-approve",
				goal: "Approval test",
				status: "awaiting_approval",
				planSummary: "Test plan summary",
			});
			const inventory = createMockInventory({ raid });
			mockFiles.set(".undercity/inventory.json", JSON.stringify(inventory));

			orchestrator = new RaidOrchestrator({ stateDir: ".undercity" });
			await orchestrator.approvePlan();

			// Check raid status changed
			const updatedInventory = JSON.parse(mockFiles.get(".undercity/inventory.json") || "{}");
			expect(updatedInventory.raid.status).toBe("executing");
			expect(updatedInventory.raid.planApproved).toBe(true);
		});
	});
});

describe("RaidOrchestrator - start", () => {
	let orchestrator: RaidOrchestrator;

	beforeEach(() => {
		mockFiles.clear();
		mockDirs.clear();
		vi.clearAllMocks();
	});

	it("resumes existing active raid instead of creating new", async () => {
		const existingRaid = createMockRaid({
			id: "existing-raid",
			goal: "Existing goal",
			status: "executing",
		});
		const inventory = createMockInventory({ raid: existingRaid });
		const pocket = createMockPocket({
			raidId: "existing-raid",
			raidStatus: "executing",
		});
		mockFiles.set(".undercity/inventory.json", JSON.stringify(inventory));
		mockFiles.set(".undercity/pocket.json", JSON.stringify(pocket));

		orchestrator = new RaidOrchestrator({
			stateDir: ".undercity",
			autoApprove: false,
		});

		const raid = await orchestrator.start("New goal that should be ignored");

		// Should return existing raid, not create new
		expect(raid.id).toBe("existing-raid");
		expect(raid.goal).toBe("Existing goal");
	});

	it("creates new raid with planning status", async () => {
		orchestrator = new RaidOrchestrator({
			stateDir: ".undercity",
			autoApprove: false,
		});

		const raid = await orchestrator.start("Build a new feature");

		expect(raid.id).toMatch(/^raid-/);
		expect(raid.goal).toBe("Build a new feature");
		expect(raid.status).toBe("planning");
		expect(raid.planApproved).toBe(false);
	});

	it("generates unique raid IDs", async () => {
		orchestrator = new RaidOrchestrator({
			stateDir: ".undercity",
			autoApprove: false,
		});

		const raid1 = await orchestrator.start("Goal 1");
		const id1 = raid1.id;

		// Clear state for second raid
		mockFiles.clear();
		orchestrator = new RaidOrchestrator({
			stateDir: ".undercity",
			autoApprove: false,
		});

		const raid2 = await orchestrator.start("Goal 2");
		const id2 = raid2.id;

		expect(id1).not.toBe(id2);
	});
});
