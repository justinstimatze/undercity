/**
 * Test Helpers
 *
 * Type-safe mock factories for testing Undercity persistence.
 */

import type { AgentType, SafePocket, Step, StepStatus } from "../types.js";

/**
 * All agent types for parametrized testing
 */
export const ALL_AGENT_TYPES: AgentType[] = ["scout", "planner", "builder", "reviewer"];

/**
 * Create a mock Step with sensible defaults
 */
export const createMockTask = (overrides: Partial<Step> = {}): Step => ({
	id: "step-1",
	sessionId: "session-1",
	type: "builder",
	description: "Test step",
	status: "pending" as StepStatus,
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
