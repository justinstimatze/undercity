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
});
