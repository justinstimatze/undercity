/**
 * Persistence Module Tests
 *
 * Tests for SafePocket, Inventory, and Raid persistence operations.
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
}));

// Import after mocking
import { Persistence } from "../persistence.js";
import type { RaidStatus } from "../types.js";
import {
	ACTIVE_RAID_STATUSES,
	createMockInventory,
	createMockPocket,
	createMockRaid,
	INACTIVE_RAID_STATUSES,
} from "./helpers.js";

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
			expect(pocket.raidId).toBeUndefined();
			expect(pocket.raidGoal).toBeUndefined();
			expect(pocket.raidStatus).toBeUndefined();
		});

		it("parses existing pocket file correctly", () => {
			const existingPocket = createMockPocket({
				raidId: "raid-123",
				raidGoal: "Build feature X",
				raidStatus: "executing",
			});
			mockFiles.set(".undercity/pocket.json", JSON.stringify(existingPocket));

			const pocket = persistence.getPocket();

			expect(pocket.raidId).toBe("raid-123");
			expect(pocket.raidGoal).toBe("Build feature X");
			expect(pocket.raidStatus).toBe("executing");
		});

		it("returns default pocket when file contains invalid JSON", () => {
			mockFiles.set(".undercity/pocket.json", "{ invalid json }");

			const pocket = persistence.getPocket();

			expect(pocket.lastUpdated).toBeInstanceOf(Date);
			expect(pocket.raidId).toBeUndefined();
		});
	});

	describe("savePocket", () => {
		it("updates lastUpdated timestamp on save", () => {
			const pocket = createMockPocket({
				raidId: "raid-456",
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
			const pocket = createMockPocket({ raidId: "raid-789" });

			persistence.savePocket(pocket);

			expect(mockFiles.has(".undercity/pocket.json")).toBe(true);
			const saved = JSON.parse(mockFiles.get(".undercity/pocket.json") ?? "{}");
			expect(saved.raidId).toBe("raid-789");
		});

		it("creates directory if it does not exist", () => {
			// Clear directories to simulate missing parent
			mockDirs.clear();

			const customPersistence = new Persistence(".custom-state");
			const pocket = createMockPocket({ raidId: "new-raid" });

			customPersistence.savePocket(pocket);

			expect(mockDirs.has(".custom-state")).toBe(true);
		});
	});

	describe("clearPocket", () => {
		it("resets pocket to default state", () => {
			// Set up existing pocket with data
			const existingPocket = createMockPocket({
				raidId: "old-raid",
				raidGoal: "Old goal",
				raidStatus: "complete",
			});
			mockFiles.set(".undercity/pocket.json", JSON.stringify(existingPocket));

			persistence.clearPocket();

			const cleared = persistence.getPocket();
			expect(cleared.raidId).toBeUndefined();
			expect(cleared.raidGoal).toBeUndefined();
			expect(cleared.raidStatus).toBeUndefined();
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

	describe("getRaid", () => {
		it("returns raid from inventory when present", () => {
			const raid = createMockRaid({
				id: "raid-abc",
				goal: "Implement tests",
				status: "planning",
			});
			const inventory = createMockInventory({ raid });
			mockFiles.set(".undercity/inventory.json", JSON.stringify(inventory));

			const result = persistence.getRaid();

			expect(result).toBeDefined();
			expect(result?.id).toBe("raid-abc");
			expect(result?.goal).toBe("Implement tests");
			expect(result?.status).toBe("planning");
		});

		it("returns undefined when no raid in inventory", () => {
			const inventory = createMockInventory(); // No raid
			mockFiles.set(".undercity/inventory.json", JSON.stringify(inventory));

			const result = persistence.getRaid();

			expect(result).toBeUndefined();
		});
	});

	describe("saveRaid", () => {
		it("saves raid to inventory", () => {
			const raid = createMockRaid({
				id: "new-raid",
				goal: "New feature",
				status: "executing",
			});

			persistence.saveRaid(raid);

			const inventory = JSON.parse(mockFiles.get(".undercity/inventory.json") ?? "{}");
			expect(inventory.raid.id).toBe("new-raid");
			expect(inventory.raid.goal).toBe("New feature");
			expect(inventory.raid.status).toBe("executing");
		});

		it("updates pocket with raid critical info", () => {
			const raid = createMockRaid({
				id: "critical-raid",
				goal: "Critical goal",
				status: "reviewing",
			});

			persistence.saveRaid(raid);

			const pocket = persistence.getPocket();
			expect(pocket.raidId).toBe("critical-raid");
			expect(pocket.raidGoal).toBe("Critical goal");
			expect(pocket.raidStatus).toBe("reviewing");
		});

		it("preserves existing inventory data", () => {
			// Set up inventory with existing tasks and squad
			const existingInventory = createMockInventory({
				tasks: [
					{
						id: "task-1",
						raidId: "old-raid",
						type: "scout",
						description: "Explore codebase",
						status: "complete",
						createdAt: new Date(),
					},
				],
				squad: [
					{
						id: "agent-1",
						type: "scout",
						status: "idle",
						spawnedAt: new Date(),
						lastActivityAt: new Date(),
					},
				],
			});
			mockFiles.set(".undercity/inventory.json", JSON.stringify(existingInventory));

			const raid = createMockRaid({ id: "new-raid" });
			persistence.saveRaid(raid);

			const inventory = JSON.parse(mockFiles.get(".undercity/inventory.json") ?? "{}");
			expect(inventory.tasks).toHaveLength(1);
			expect(inventory.tasks[0].id).toBe("task-1");
			expect(inventory.squad).toHaveLength(1);
			expect(inventory.squad[0].id).toBe("agent-1");
		});
	});

	describe("hasActiveRaid", () => {
		it.each(ACTIVE_RAID_STATUSES)("returns true when raid status is %s", (status: RaidStatus) => {
			const pocket = createMockPocket({
				raidId: "active-raid",
				raidStatus: status,
			});
			mockFiles.set(".undercity/pocket.json", JSON.stringify(pocket));

			const result = persistence.hasActiveRaid();

			expect(result).toBe(true);
		});

		it.each(INACTIVE_RAID_STATUSES)("returns false when raid status is %s", (status: RaidStatus) => {
			const pocket = createMockPocket({
				raidId: "inactive-raid",
				raidStatus: status,
			});
			mockFiles.set(".undercity/pocket.json", JSON.stringify(pocket));

			const result = persistence.hasActiveRaid();

			expect(result).toBe(false);
		});

		it("returns false when no raid exists", () => {
			// Empty pocket (no raidId)
			const pocket = createMockPocket();
			mockFiles.set(".undercity/pocket.json", JSON.stringify(pocket));

			const result = persistence.hasActiveRaid();

			expect(result).toBe(false);
		});
	});
});
