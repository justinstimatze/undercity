/**
 * Test Helpers
 *
 * Type-safe mock factories for testing Undercity persistence.
 */

import type { AgentType, Inventory, Raid, RaidStatus, SafePocket, Waypoint, WaypointStatus } from "../types.js";

/**
 * All agent types for parametrized testing
 */
export const ALL_AGENT_TYPES: AgentType[] = ["scout", "planner", "fabricator", "auditor"];

/**
 * Create a mock Waypoint with sensible defaults
 */
export const createMockTask = (overrides: Partial<Waypoint> = {}): Waypoint => ({
	id: "waypoint-1",
	raidId: "raid-1",
	type: "fabricator",
	description: "Test waypoint",
	status: "pending" as WaypointStatus,
	createdAt: new Date("2024-01-01T00:00:00.000Z"),
	...overrides,
});

/**
 * Create a mock SafePocket with sensible defaults
 */
export const createMockPocket = (overrides: Partial<SafePocket> = {}): SafePocket => ({
	lastUpdated: new Date("2024-01-01T00:00:00.000Z"),
	...overrides,
});

/**
 * Create a mock Raid with sensible defaults
 */
export const createMockRaid = (overrides: Partial<Raid> = {}): Raid => ({
	id: "test-raid-1",
	goal: "Test goal",
	status: "planning",
	startedAt: new Date("2024-01-01T00:00:00.000Z"),
	planApproved: false,
	...overrides,
});

/**
 * Create a mock Inventory with sensible defaults
 */
export const createMockInventory = (overrides: Partial<Inventory> = {}): Inventory => ({
	waypoints: [],
	squad: [],
	lastUpdated: new Date("2024-01-01T00:00:00.000Z"),
	...overrides,
});

/**
 * Mock fs module state for testing
 */
export interface MockFsState {
	files: Map<string, string>;
	directories: Set<string>;
}

/**
 * Create a fresh mock fs state
 */
export const createMockFsState = (): MockFsState => ({
	files: new Map<string, string>(),
	directories: new Set<string>(),
});

/**
 * Create mock fs functions that operate on the given state
 */
export const createMockFs = (state: MockFsState) => ({
	existsSync: (path: string): boolean => {
		return state.files.has(path) || state.directories.has(path);
	},

	readFileSync: (path: string, _encoding: string): string => {
		const content = state.files.get(path);
		if (content === undefined) {
			throw new Error(`ENOENT: no such file or directory, open '${path}'`);
		}
		return content;
	},

	writeFileSync: (path: string, data: string): void => {
		state.files.set(path, data);
	},

	mkdirSync: (path: string, _options?: { recursive?: boolean }): void => {
		state.directories.add(path);
	},
});

/**
 * Helper to check if a raid status is considered "active"
 */
export const isActiveRaidStatus = (status: RaidStatus): boolean => {
	return status !== "complete" && status !== "failed";
};

/**
 * All raid statuses for parametrized testing
 */
export const ALL_RAID_STATUSES: RaidStatus[] = [
	"planning",
	"awaiting_approval",
	"executing",
	"reviewing",
	"merging",
	"extracting",
	"complete",
	"failed",
];

/**
 * Active raid statuses (should return true for hasActiveRaid)
 */
export const ACTIVE_RAID_STATUSES: RaidStatus[] = [
	"planning",
	"awaiting_approval",
	"executing",
	"reviewing",
	"merging",
	"extracting",
];

/**
 * Inactive raid statuses (should return false for hasActiveRaid)
 */
export const INACTIVE_RAID_STATUSES: RaidStatus[] = ["complete", "failed"];
