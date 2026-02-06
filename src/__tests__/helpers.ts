/**
 * Test Helpers
 *
 * Type-safe mock factories for testing Undercity persistence.
 */

import type { AgentType, SessionRecovery, Step, StepStatus } from "../types.js";

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
 * Create a mock SessionRecovery with sensible defaults
 */
export const createMockSessionRecovery = (overrides: Partial<SessionRecovery> = {}): SessionRecovery => ({
	lastUpdated: new Date("2024-01-01T00:00:00.000Z"),
	...overrides,
});

/** @deprecated Use createMockSessionRecovery instead */
export const createMockPocket = createMockSessionRecovery;

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

// =============================================================================
// Test Database Helpers
// =============================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { closeRAGDatabase, resetRAGDatabase } from "../rag/database.js";
import { closeDatabase, resetDatabase } from "../storage.js";

/**
 * Create a temporary directory for test database files
 *
 * Uses mkdtempSync to create an isolated temp directory for file-based
 * SQLite databases. This is required because storage.ts and rag/database.ts
 * use singleton patterns that require file paths.
 *
 * @param prefix - Prefix for the temp directory name
 * @returns Absolute path to the created temp directory
 */
export function createTestDatabaseDir(prefix: string = "test-db-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Test context for storage.ts database
 */
export interface StorageTestContext {
	/** Temporary directory containing the database */
	tempDir: string;
	/** Cleanup function to close database and remove temp directory */
	cleanup: () => void;
}

/**
 * Set up test context for storage.ts database
 *
 * Creates a temporary directory and provides cleanup function that:
 * 1. Resets the database singleton via resetDatabase()
 * 2. Closes the database connection via closeDatabase()
 * 3. Removes the temporary directory and all contents
 *
 * The resetDatabase() call ensures that any previous database instance
 * is closed before creating a new one in the temp directory.
 *
 * @returns Test context with tempDir and cleanup function
 *
 * @example
 * ```ts
 * const { tempDir, cleanup } = setupStorageTestContext();
 * try {
 *   const db = getDatabase(tempDir);
 *   // ... use database
 * } finally {
 *   cleanup();
 * }
 * ```
 */
export function setupStorageTestContext(): StorageTestContext {
	resetDatabase(); // Reset singleton before creating temp directory
	const tempDir = createTestDatabaseDir("storage-test-");

	const cleanup = () => {
		closeDatabase();
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch (_error) {
			// Ignore cleanup errors - temp directory may already be removed
		}
	};

	return { tempDir, cleanup };
}

/**
 * Test context for rag/database.ts database
 */
export interface RAGTestContext {
	/** Temporary directory containing the database */
	tempDir: string;
	/** Cleanup function to close database and remove temp directory */
	cleanup: () => void;
}

/**
 * Set up test context for rag/database.ts database
 *
 * Creates a temporary directory and provides cleanup function that:
 * 1. Resets the database singleton via resetRAGDatabase()
 * 2. Closes the database connection via closeRAGDatabase()
 * 3. Removes the temporary directory and all contents
 *
 * The resetRAGDatabase() call ensures that any previous database instance
 * is closed before creating a new one in the temp directory.
 *
 * @returns Test context with tempDir and cleanup function
 *
 * @example
 * ```ts
 * const { tempDir, cleanup } = setupRAGTestContext();
 * try {
 *   const db = getRAGDatabase(tempDir);
 *   // ... use database
 * } finally {
 *   cleanup();
 * }
 * ```
 */
export function setupRAGTestContext(): RAGTestContext {
	resetRAGDatabase(); // Reset singleton before creating temp directory
	const tempDir = createTestDatabaseDir("rag-test-");

	const cleanup = () => {
		closeRAGDatabase();
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch (_error) {
			// Ignore cleanup errors - temp directory may already be removed
		}
	};

	return { tempDir, cleanup };
}

/**
 * Use test database with automatic cleanup
 *
 * Sets up a test database context and registers cleanup with Vitest's
 * onTestFinished hook. This ensures the database is properly closed
 * and temp directory is removed even if the test throws an error.
 *
 * @param setupFn - Function that sets up the test context (setupStorageTestContext or setupRAGTestContext)
 * @returns Temporary directory path for the database
 *
 * @example
 * ```ts
 * it("should work with database", () => {
 *   const tempDir = useTestDatabase(setupStorageTestContext);
 *   const db = getDatabase(tempDir);
 *   // ... test code
 *   // cleanup happens automatically via onTestFinished
 * });
 * ```
 */
export function useTestDatabase(setupFn: typeof setupStorageTestContext | typeof setupRAGTestContext): string {
	const context = setupFn();
	onTestFinished(() => context.cleanup());
	return context.tempDir;
}
