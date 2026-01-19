/**
 * Tests for error-fix-patterns.ts
 *
 * Tests error signature generation, pattern recording and matching,
 * fix suggestions, statistics, pruning, and edge cases with mock fs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock state
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
let mockNow = 1704067200000; // Fixed timestamp: 2024-01-01T00:00:00.000Z

// Store original implementations
const _originalDate = Date;
const _originalDateNow = Date.now;

// Mock Date constructor and Date.now for consistent timestamps
class MockDate extends Date {
	constructor(...args: [] | [string | number | Date]) {
		if (args.length === 0) {
			super(mockNow);
		} else {
			super(args[0]);
		}
	}

	static now(): number {
		return mockNow;
	}
}

// Apply mocks before tests
vi.stubGlobal("Date", MockDate);

// Mock fs module
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
	writeFileSync: vi.fn((path: string, content: string): void => {
		mockFiles.set(path, content);
	}),
	renameSync: vi.fn((oldPath: string, newPath: string): void => {
		const content = mockFiles.get(oldPath);
		if (content === undefined) {
			throw new Error(`ENOENT: no such file or directory, rename '${oldPath}'`);
		}
		mockFiles.set(newPath, content);
		mockFiles.delete(oldPath);
	}),
	unlinkSync: vi.fn((path: string): void => {
		mockFiles.delete(path);
	}),
	mkdirSync: vi.fn((path: string, options?: { recursive?: boolean }): void => {
		if (options?.recursive) {
			// Create all parent directories
			const parts = path.split("/").filter(Boolean);
			let current = "";
			for (const part of parts) {
				current = current ? `${current}/${part}` : part;
				mockDirs.add(current);
			}
		} else {
			mockDirs.add(path);
		}
	}),
}));

// Mock child_process for git operations
let mockExecResult: string | Error = "";
vi.mock("node:child_process", () => ({
	execFileSync: vi.fn((_cmd: string, _args: string[], _options?: Record<string, unknown>): string => {
		if (mockExecResult instanceof Error) {
			throw mockExecResult;
		}
		return mockExecResult;
	}),
}));

// Import after mocking
import {
	clearPendingError,
	type ErrorFixStore,
	findFixSuggestions,
	formatFixSuggestionsForPrompt,
	generateErrorSignature,
	getErrorFixStats,
	loadErrorFixStore,
	markFixSuccessful,
	pruneOldPatterns,
	recordPendingError,
	recordPermanentFailure,
	recordSuccessfulFix,
	tryAutoRemediate,
} from "../error-fix-patterns.js";

describe("error-fix-patterns.ts", () => {
	beforeEach(() => {
		mockFiles.clear();
		mockDirs.clear();
		mockNow = 1704067200000;
		mockExecResult = "";
		vi.clearAllMocks();
	});

	afterEach(() => {
		mockFiles.clear();
		mockDirs.clear();
		vi.clearAllMocks();
	});

	describe("generateErrorSignature", () => {
		it("should normalize file paths to FILE", () => {
			const msg1 = "Error in /path/to/file.ts at line 10";
			const msg2 = "Error in /different/path/to/file.ts at line 10";

			const sig1 = generateErrorSignature("typecheck", msg1);
			const sig2 = generateErrorSignature("typecheck", msg2);

			expect(sig1).toBe(sig2);
		});

		it("should normalize line and column numbers", () => {
			const msg1 = "Error file.ts:10:5 found";
			const msg2 = "Error file.ts:99:123 found";

			const sig1 = generateErrorSignature("lint", msg1);
			const sig2 = generateErrorSignature("lint", msg2);

			expect(sig1).toBe(sig2);
		});

		it("should normalize line N patterns", () => {
			const msg1 = "Error on line 42";
			const msg2 = "Error on line 100";

			const sig1 = generateErrorSignature("test", msg1);
			const sig2 = generateErrorSignature("test", msg2);

			expect(sig1).toBe(sig2);
		});

		it("should normalize quoted strings", () => {
			const msg1 = "Type 'string' is not assignable to type 'number'";
			const msg2 = "Type 'boolean' is not assignable to type 'object'";

			const sig1 = generateErrorSignature("typecheck", msg1);
			const sig2 = generateErrorSignature("typecheck", msg2);

			expect(sig1).toBe(sig2);
		});

		it("should normalize double-quoted strings", () => {
			const msg1 = 'Property "foo" does not exist';
			const msg2 = 'Property "bar" does not exist';

			const sig1 = generateErrorSignature("typecheck", msg1);
			const sig2 = generateErrorSignature("typecheck", msg2);

			expect(sig1).toBe(sig2);
		});

		it("should normalize hex addresses", () => {
			const msg1 = "Error at address 0x1A2B3C";
			const msg2 = "Error at address 0xDEADBEEF";

			const sig1 = generateErrorSignature("build", msg1);
			const sig2 = generateErrorSignature("build", msg2);

			expect(sig1).toBe(sig2);
		});

		it("should collapse whitespace", () => {
			const msg1 = "Error   with   multiple    spaces";
			const msg2 = "Error with multiple spaces";

			const sig1 = generateErrorSignature("lint", msg1);
			const sig2 = generateErrorSignature("lint", msg2);

			expect(sig1).toBe(sig2);
		});

		it("should be case-insensitive", () => {
			const msg1 = "Type Error Found";
			const msg2 = "TYPE ERROR FOUND";

			const sig1 = generateErrorSignature("typecheck", msg1);
			const sig2 = generateErrorSignature("typecheck", msg2);

			expect(sig1).toBe(sig2);
		});

		it("should include category in signature", () => {
			const msg = "Same error message";

			const sig1 = generateErrorSignature("typecheck", msg);
			const sig2 = generateErrorSignature("lint", msg);

			expect(sig1).not.toBe(sig2);
			expect(sig1).toContain("typecheck-");
			expect(sig2).toContain("lint-");
		});

		it("should generate consistent hash for same input", () => {
			const msg = "Type error at line 10";

			const sig1 = generateErrorSignature("typecheck", msg);
			const sig2 = generateErrorSignature("typecheck", msg);

			expect(sig1).toBe(sig2);
			expect(sig1).toMatch(/^typecheck-[a-f0-9]{12}$/);
		});

		it("should handle empty messages", () => {
			const sig = generateErrorSignature("test", "");

			expect(sig).toMatch(/^test-[a-f0-9]{12}$/);
		});

		it("should handle very long messages", () => {
			const longMsg = `Error: ${"x".repeat(10000)}`;

			const sig = generateErrorSignature("lint", longMsg);

			expect(sig).toMatch(/^lint-[a-f0-9]{12}$/);
		});
	});

	describe("loadErrorFixStore", () => {
		it("should return empty store when file does not exist", () => {
			const store = loadErrorFixStore();

			expect(store.patterns).toEqual({});
			expect(store.pending).toEqual([]);
			expect(store.version).toBe("1.0");
			expect(store.lastUpdated).toBe(new Date(mockNow).toISOString());
		});

		it("should load existing store from disk", () => {
			const existingStore: ErrorFixStore = {
				patterns: {
					"typecheck-abc123": {
						signature: "typecheck-abc123",
						category: "typecheck",
						sampleMessage: "Type error",
						fixes: [],
						occurrences: 5,
						fixSuccesses: 2,
						firstSeen: "2024-01-01T00:00:00.000Z",
						lastSeen: "2024-01-01T00:00:00.000Z",
					},
				},
				pending: [],
				version: "1.0",
				lastUpdated: "2024-01-01T00:00:00.000Z",
			};
			mockFiles.set(".undercity/error-fix-patterns.json", JSON.stringify(existingStore));

			const store = loadErrorFixStore();

			expect(Object.keys(store.patterns)).toHaveLength(1);
			expect(store.patterns["typecheck-abc123"].occurrences).toBe(5);
		});

		it("should handle corrupted JSON gracefully", () => {
			mockFiles.set(".undercity/error-fix-patterns.json", "{ invalid json }");

			const store = loadErrorFixStore();

			expect(store.patterns).toEqual({});
			expect(store.pending).toEqual([]);
			expect(store.version).toBe("1.0");
		});

		it("should handle missing patterns field", () => {
			mockFiles.set(".undercity/error-fix-patterns.json", JSON.stringify({ version: "1.0" }));

			const store = loadErrorFixStore();

			expect(store.patterns).toEqual({});
			expect(store.pending).toEqual([]);
		});

		it("should handle invalid patterns type", () => {
			mockFiles.set(
				".undercity/error-fix-patterns.json",
				JSON.stringify({ patterns: "not an object", version: "1.0" }),
			);

			const store = loadErrorFixStore();

			expect(store.patterns).toEqual({});
		});

		it("should use custom state directory", () => {
			const customStore: ErrorFixStore = {
				patterns: {},
				pending: [],
				version: "1.0",
				lastUpdated: "2024-01-01T00:00:00.000Z",
			};
			mockFiles.set("/custom/.undercity/error-fix-patterns.json", JSON.stringify(customStore));

			const store = loadErrorFixStore("/custom/.undercity");

			expect(store).toBeDefined();
			expect(store.version).toBe("1.0");
		});
	});

	describe("recordPendingError", () => {
		it("should create new pattern on first error", () => {
			mockDirs.add(".undercity");

			const signature = recordPendingError("task-1", "typecheck", "Type error at line 10", ["file1.ts"]);

			expect(signature).toMatch(/^typecheck-[a-f0-9]{12}$/);

			const store = loadErrorFixStore();
			const pattern = store.patterns[signature];

			expect(pattern).toBeDefined();
			expect(pattern.signature).toBe(signature);
			expect(pattern.category).toBe("typecheck");
			expect(pattern.sampleMessage).toBe("Type error at line 10");
			expect(pattern.fixes).toEqual([]);
			expect(pattern.occurrences).toBe(1);
			expect(pattern.fixSuccesses).toBe(0);
			expect(pattern.firstSeen).toBe(new Date(mockNow).toISOString());
			expect(pattern.lastSeen).toBe(new Date(mockNow).toISOString());
		});

		it("should increment occurrences for repeated errors", () => {
			mockDirs.add(".undercity");

			const sig1 = recordPendingError("task-1", "lint", "Lint error at line 5", []);
			const sig2 = recordPendingError("task-2", "lint", "Lint error at line 10", []);

			expect(sig1).toBe(sig2);

			const store = loadErrorFixStore();
			const pattern = store.patterns[sig1];

			expect(pattern.occurrences).toBe(2);
		});

		it("should update lastSeen timestamp", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "test", "Test failed", []);

			mockNow = 1704067200000 + 60000; // 1 minute later

			recordPendingError("task-2", "test", "Test failed", []);

			const store = loadErrorFixStore();
			const pattern = Object.values(store.patterns)[0];

			expect(pattern.firstSeen).toBe(new Date(1704067200000).toISOString());
			expect(pattern.lastSeen).toBe(new Date(1704067200000 + 60000).toISOString());
		});

		it("should add to pending array", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "typecheck", "Error 1", ["file1.ts"]);
			recordPendingError("task-2", "lint", "Error 2", ["file2.ts"]);

			const store = loadErrorFixStore();

			expect(store.pending).toHaveLength(2);
			expect(store.pending[0].taskId).toBe("task-1");
			expect(store.pending[0].category).toBe("typecheck");
			expect(store.pending[0].message).toBe("Error 1");
			expect(store.pending[0].filesBeforeFix).toEqual(["file1.ts"]);
			expect(store.pending[1].taskId).toBe("task-2");
		});

		it("should limit pending to 10 entries", () => {
			mockDirs.add(".undercity");

			// Add 15 pending errors
			for (let i = 0; i < 15; i++) {
				recordPendingError(`task-${i}`, "test", `Error ${i}`, []);
			}

			const store = loadErrorFixStore();

			expect(store.pending).toHaveLength(10);
			// Should keep last 10 (5-14)
			expect(store.pending[0].taskId).toBe("task-5");
			expect(store.pending[9].taskId).toBe("task-14");
		});

		it("should truncate message to 500 chars", () => {
			mockDirs.add(".undercity");

			const longMessage = `Error: ${"x".repeat(600)}`;

			recordPendingError("task-1", "typecheck", longMessage, []);

			const store = loadErrorFixStore();
			const pattern = Object.values(store.patterns)[0];

			expect(pattern.sampleMessage.length).toBe(500);
			expect(store.pending[0].message.length).toBe(500);
		});

		it("should persist to disk atomically", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "lint", "Error", []);

			expect(mockFiles.has(".undercity/error-fix-patterns.json")).toBe(true);
			expect(mockFiles.has(".undercity/error-fix-patterns.json.tmp")).toBe(false);
		});

		it("should create directory if it does not exist", () => {
			recordPendingError("task-1", "test", "Error", []);

			expect(mockDirs.has(".undercity")).toBe(true);
		});

		it("should use custom state directory", () => {
			mockDirs.add("/custom/.undercity");

			recordPendingError("task-1", "lint", "Error", [], "/custom/.undercity");

			expect(mockFiles.has("/custom/.undercity/error-fix-patterns.json")).toBe(true);
		});
	});

	describe("recordSuccessfulFix", () => {
		it("should find and resolve pending error", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "typecheck", "Type error", ["old.ts"]);

			recordSuccessfulFix("task-1", ["old.ts", "new.ts"], "Added type annotation");

			const store = loadErrorFixStore();

			expect(store.pending).toHaveLength(0);
			const pattern = Object.values(store.patterns)[0];
			expect(pattern.fixes).toHaveLength(1);
		});

		it("should record fix with filesChanged", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "lint", "Lint error", []);

			recordSuccessfulFix("task-1", ["file1.ts", "file2.ts"], "Fixed lint issues");

			const store = loadErrorFixStore();
			const pattern = Object.values(store.patterns)[0];
			const fix = pattern.fixes[0];

			expect(fix.filesChanged).toEqual(["file1.ts", "file2.ts"]);
			expect(fix.editSummary).toBe("Fixed lint issues");
			expect(fix.taskId).toBe("task-1");
			expect(fix.recordedAt).toBe(new Date(mockNow).toISOString());
		});

		it("should calculate new files vs existing files", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "test", "Test failed", ["existing1.ts", "existing2.ts"]);

			recordSuccessfulFix("task-1", ["existing1.ts", "new1.ts", "new2.ts"], "Added tests");

			const store = loadErrorFixStore();
			const pattern = Object.values(store.patterns)[0];
			const fix = pattern.fixes[0];

			// Should only include new files
			expect(fix.filesChanged).toEqual(["new1.ts", "new2.ts"]);
		});

		it("should use all files when no new files detected", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "typecheck", "Type error", ["file1.ts", "file2.ts", "file3.ts"]);

			recordSuccessfulFix("task-1", ["file1.ts", "file2.ts", "file3.ts"], "Fixed types");

			const store = loadErrorFixStore();
			const pattern = Object.values(store.patterns)[0];
			const fix = pattern.fixes[0];

			// Should include all files
			expect(fix.filesChanged).toEqual(["file1.ts", "file2.ts", "file3.ts"]);
		});

		it("should limit filesChanged to 5 when no new files", () => {
			mockDirs.add(".undercity");

			// Record with existing files so they don't count as "new"
			const existingFiles = Array.from({ length: 10 }, (_, i) => `file${i}.ts`);
			recordPendingError("task-1", "lint", "Lint error", existingFiles);

			recordSuccessfulFix("task-1", existingFiles, "Fixed all");

			const store = loadErrorFixStore();
			const pattern = Object.values(store.patterns)[0];
			const fix = pattern.fixes[0];

			expect(fix.filesChanged.length).toBe(5);
		});

		it("should limit fixes to 5 per pattern", () => {
			mockDirs.add(".undercity");

			// Add 7 fixes for same error pattern
			for (let i = 0; i < 7; i++) {
				recordPendingError(`task-${i}`, "typecheck", "Same error", []);
				recordSuccessfulFix(`task-${i}`, [`file${i}.ts`], `Fix ${i}`);
			}

			const store = loadErrorFixStore();
			const pattern = Object.values(store.patterns)[0];

			expect(pattern.fixes).toHaveLength(5);
			// Should keep last 5 (2-6)
			expect(pattern.fixes[0].editSummary).toBe("Fix 2");
			expect(pattern.fixes[4].editSummary).toBe("Fix 6");
		});

		it("should truncate editSummary to 200 chars", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "test", "Error", []);

			const longSummary = `Fixed: ${"x".repeat(300)}`;
			recordSuccessfulFix("task-1", ["file.ts"], longSummary);

			const store = loadErrorFixStore();
			const pattern = Object.values(store.patterns)[0];
			const fix = pattern.fixes[0];

			expect(fix.editSummary.length).toBe(200);
		});

		it("should remove from pending array", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "lint", "Error 1", []);
			recordPendingError("task-2", "test", "Error 2", []);

			recordSuccessfulFix("task-1", ["file.ts"], "Fixed");

			const store = loadErrorFixStore();

			expect(store.pending).toHaveLength(1);
			expect(store.pending[0].taskId).toBe("task-2");
		});

		it("should handle no pending error gracefully", () => {
			mockDirs.add(".undercity");

			// No error recorded, just call recordSuccessfulFix
			recordSuccessfulFix("task-1", ["file.ts"], "Fixed");

			const store = loadErrorFixStore();

			expect(store.patterns).toEqual({});
			expect(store.pending).toEqual([]);
		});

		it("should persist to disk", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "typecheck", "Error", []);
			recordSuccessfulFix("task-1", ["file.ts"], "Fixed");

			expect(mockFiles.has(".undercity/error-fix-patterns.json")).toBe(true);
		});

		it("should use custom state directory", () => {
			mockDirs.add("/custom/.undercity");

			recordPendingError("task-1", "lint", "Error", [], "/custom/.undercity");
			recordSuccessfulFix("task-1", ["file.ts"], "Fixed", "/custom/.undercity");

			expect(mockFiles.has("/custom/.undercity/error-fix-patterns.json")).toBe(true);
		});
	});

	describe("findFixSuggestions", () => {
		it("should return null when no pattern found", () => {
			const result = findFixSuggestions("typecheck", "Unknown error");

			expect(result).toBeNull();
		});

		it("should return null when pattern has no fixes", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "lint", "Lint error", []);

			const result = findFixSuggestions("lint", "Lint error");

			expect(result).toBeNull();
		});

		it("should return suggestions sorted by recency (reverse order)", () => {
			mockDirs.add(".undercity");

			// Add 3 fixes at different times
			for (let i = 0; i < 3; i++) {
				mockNow = 1704067200000 + i * 60000;
				recordPendingError(`task-${i}`, "typecheck", "Type error", []);
				recordSuccessfulFix(`task-${i}`, [`file${i}.ts`], `Fix ${i}`);
			}

			mockNow = 1704067200000;
			const result = findFixSuggestions("typecheck", "Type error");

			expect(result).not.toBeNull();
			expect(result!.suggestions).toHaveLength(3);
			// Most recent first
			expect(result!.suggestions[0].editSummary).toBe("Fix 2");
			expect(result!.suggestions[1].editSummary).toBe("Fix 1");
			expect(result!.suggestions[2].editSummary).toBe("Fix 0");
		});

		it("should include pattern metadata", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "test", "Test failed", []);
			recordSuccessfulFix("task-1", ["test.ts"], "Added test case");

			const result = findFixSuggestions("test", "Test failed");

			expect(result).not.toBeNull();
			expect(result!.pattern.signature).toMatch(/^test-[a-f0-9]{12}$/);
			expect(result!.pattern.category).toBe("test");
			expect(result!.pattern.occurrences).toBe(1);
			expect(result!.pattern.fixes).toHaveLength(1);
		});

		it("should use custom state directory", () => {
			mockDirs.add("/custom/.undercity");

			recordPendingError("task-1", "lint", "Error", [], "/custom/.undercity");
			recordSuccessfulFix("task-1", ["file.ts"], "Fixed", "/custom/.undercity");

			const result = findFixSuggestions("lint", "Error", "/custom/.undercity");

			expect(result).not.toBeNull();
		});
	});

	describe("markFixSuccessful", () => {
		it("should increment fixSuccesses counter", () => {
			mockDirs.add(".undercity");

			const signature = recordPendingError("task-1", "typecheck", "Type error", []);

			markFixSuccessful(signature);

			const store = loadErrorFixStore();
			const pattern = store.patterns[signature];

			expect(pattern.fixSuccesses).toBe(1);
		});

		it("should handle multiple successful applications", () => {
			mockDirs.add(".undercity");

			const signature = recordPendingError("task-1", "lint", "Lint error", []);

			markFixSuccessful(signature);
			markFixSuccessful(signature);
			markFixSuccessful(signature);

			const store = loadErrorFixStore();
			const pattern = store.patterns[signature];

			expect(pattern.fixSuccesses).toBe(3);
		});

		it("should handle non-existent pattern gracefully", () => {
			mockDirs.add(".undercity");

			markFixSuccessful("non-existent-signature");

			const store = loadErrorFixStore();
			expect(store.patterns["non-existent-signature"]).toBeUndefined();
		});

		it("should persist to disk", () => {
			mockDirs.add(".undercity");

			const signature = recordPendingError("task-1", "test", "Error", []);
			markFixSuccessful(signature);

			expect(mockFiles.has(".undercity/error-fix-patterns.json")).toBe(true);
		});

		it("should use custom state directory", () => {
			mockDirs.add("/custom/.undercity");

			const signature = recordPendingError("task-1", "lint", "Error", [], "/custom/.undercity");
			markFixSuccessful(signature, "/custom/.undercity");

			const store = loadErrorFixStore("/custom/.undercity");
			expect(store.patterns[signature].fixSuccesses).toBe(1);
		});
	});

	describe("clearPendingError", () => {
		it("should remove pending entry by taskId", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "typecheck", "Error 1", []);
			recordPendingError("task-2", "lint", "Error 2", []);

			clearPendingError("task-1");

			const store = loadErrorFixStore();

			expect(store.pending).toHaveLength(1);
			expect(store.pending[0].taskId).toBe("task-2");
		});

		it("should leave other entries untouched", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "test", "Error 1", []);
			recordPendingError("task-2", "test", "Error 2", []);
			recordPendingError("task-3", "test", "Error 3", []);

			clearPendingError("task-2");

			const store = loadErrorFixStore();

			expect(store.pending).toHaveLength(2);
			expect(store.pending[0].taskId).toBe("task-1");
			expect(store.pending[1].taskId).toBe("task-3");
		});

		it("should handle non-existent taskId gracefully", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "lint", "Error", []);

			clearPendingError("task-99");

			const store = loadErrorFixStore();

			expect(store.pending).toHaveLength(1);
		});

		it("should persist to disk", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "typecheck", "Error", []);
			clearPendingError("task-1");

			expect(mockFiles.has(".undercity/error-fix-patterns.json")).toBe(true);
		});

		it("should use custom state directory", () => {
			mockDirs.add("/custom/.undercity");

			recordPendingError("task-1", "lint", "Error", [], "/custom/.undercity");
			clearPendingError("task-1", "/custom/.undercity");

			const store = loadErrorFixStore("/custom/.undercity");
			expect(store.pending).toHaveLength(0);
		});
	});

	describe("formatFixSuggestionsForPrompt", () => {
		it("should return empty string when no suggestions", () => {
			const formatted = formatFixSuggestionsForPrompt("typecheck", "Unknown error");

			expect(formatted).toBe("");
		});

		it("should format with statistics", () => {
			mockDirs.add(".undercity");

			const signature = recordPendingError("task-1", "lint", "Lint error", []);
			recordSuccessfulFix("task-1", ["file.ts"], "Fixed lint");

			// Mark 2 successes out of 1 occurrence
			markFixSuccessful(signature);
			markFixSuccessful(signature);

			const formatted = formatFixSuggestionsForPrompt("lint", "Lint error");

			expect(formatted).toContain("1 occurrences");
			expect(formatted).toContain("200% fix success rate");
		});

		it("should limit to 3 most recent fixes", () => {
			mockDirs.add(".undercity");

			// Add 5 fixes
			for (let i = 0; i < 5; i++) {
				recordPendingError(`task-${i}`, "typecheck", "Type error", []);
				recordSuccessfulFix(`task-${i}`, [`file${i}.ts`], `Fix ${i}`);
			}

			const formatted = formatFixSuggestionsForPrompt("typecheck", "Type error");

			expect(formatted).toContain("Fix 4");
			expect(formatted).toContain("Fix 3");
			expect(formatted).toContain("Fix 2");
			expect(formatted).not.toContain("Fix 1");
			expect(formatted).not.toContain("Fix 0");
		});

		it("should include files and editSummary", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "test", "Test failed", []);
			recordSuccessfulFix("task-1", ["test1.ts", "test2.ts"], "Added missing assertions");

			const formatted = formatFixSuggestionsForPrompt("test", "Test failed");

			expect(formatted).toContain("test1.ts, test2.ts");
			expect(formatted).toContain("Added missing assertions");
		});

		it("should include suggestion text at end", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "lint", "Error", []);
			recordSuccessfulFix("task-1", ["file.ts"], "Fixed");

			const formatted = formatFixSuggestionsForPrompt("lint", "Error");

			expect(formatted).toContain("Consider similar approaches for this error");
		});

		it("should use custom state directory", () => {
			mockDirs.add("/custom/.undercity");

			recordPendingError("task-1", "typecheck", "Error", [], "/custom/.undercity");
			recordSuccessfulFix("task-1", ["file.ts"], "Fixed", "/custom/.undercity");

			const formatted = formatFixSuggestionsForPrompt("typecheck", "Error", "/custom/.undercity");

			expect(formatted).not.toBe("");
		});
	});

	describe("getErrorFixStats", () => {
		it("should count total patterns, occurrences, and fixes", () => {
			mockDirs.add(".undercity");

			// Pattern 1: 2 occurrences, 1 fix
			recordPendingError("task-1", "typecheck", "Type error", []);
			recordPendingError("task-2", "typecheck", "Type error", []);
			recordSuccessfulFix("task-1", ["file1.ts"], "Fix 1");

			// Pattern 2: 1 occurrence, 1 fix
			recordPendingError("task-3", "lint", "Lint error", []);
			recordSuccessfulFix("task-3", ["file2.ts"], "Fix 2");

			const stats = getErrorFixStats();

			expect(stats.totalPatterns).toBe(2);
			expect(stats.totalOccurrences).toBe(3);
			expect(stats.totalFixes).toBe(2);
		});

		it("should group by category", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "typecheck", "Error 1", []);
			recordPendingError("task-2", "typecheck", "Error 2", []);
			recordPendingError("task-3", "lint", "Error 3", []);
			recordPendingError("task-4", "test", "Error 4", []);
			recordPendingError("task-5", "test", "Error 5", []);
			recordPendingError("task-6", "test", "Error 6", []);

			const stats = getErrorFixStats();

			expect(stats.byCategory.typecheck).toBe(2);
			expect(stats.byCategory.lint).toBe(1);
			expect(stats.byCategory.test).toBe(3);
		});

		it("should calculate top 5 errors by occurrence", () => {
			mockDirs.add(".undercity");

			// Create 7 different patterns with different occurrence counts
			for (let i = 0; i < 7; i++) {
				for (let j = 0; j <= i; j++) {
					recordPendingError(`task-${i}-${j}`, "typecheck", `Error type ${i}`, []);
				}
			}

			const stats = getErrorFixStats();

			expect(stats.topErrors).toHaveLength(5);
			// Most common should be first (6 occurrences)
			expect(stats.topErrors[0].occurrences).toBe(7);
			expect(stats.topErrors[1].occurrences).toBe(6);
			expect(stats.topErrors[2].occurrences).toBe(5);
			expect(stats.topErrors[3].occurrences).toBe(4);
			expect(stats.topErrors[4].occurrences).toBe(3);
		});

		it("should handle empty store", () => {
			const stats = getErrorFixStats();

			expect(stats.totalPatterns).toBe(0);
			expect(stats.totalOccurrences).toBe(0);
			expect(stats.totalFixes).toBe(0);
			expect(stats.byCategory).toEqual({});
			expect(stats.topErrors).toEqual([]);
		});

		it("should use custom state directory", () => {
			mockDirs.add("/custom/.undercity");

			recordPendingError("task-1", "lint", "Error", [], "/custom/.undercity");

			const stats = getErrorFixStats("/custom/.undercity");

			expect(stats.totalPatterns).toBe(1);
		});
	});

	describe("pruneOldPatterns", () => {
		it("should remove patterns older than maxAge without fixes", () => {
			mockDirs.add(".undercity");

			// Old pattern without fixes
			mockNow = 1704067200000 - 40 * 24 * 60 * 60 * 1000; // 40 days ago
			const oldSig = recordPendingError("task-1", "typecheck", "Old error", []);

			// Recent pattern
			mockNow = 1704067200000;
			recordPendingError("task-2", "lint", "Recent error", []);

			const pruned = pruneOldPatterns(30 * 24 * 60 * 60 * 1000, ".undercity");

			expect(pruned).toBe(1);

			const store = loadErrorFixStore();
			expect(store.patterns[oldSig]).toBeUndefined();
			expect(Object.keys(store.patterns)).toHaveLength(1);
		});

		it("should preserve recent patterns", () => {
			mockDirs.add(".undercity");

			// Recent pattern
			mockNow = 1704067200000 - 10 * 24 * 60 * 60 * 1000; // 10 days ago
			const recentSig = recordPendingError("task-1", "typecheck", "Recent error", []);

			mockNow = 1704067200000;
			const pruned = pruneOldPatterns(30 * 24 * 60 * 60 * 1000, ".undercity");

			expect(pruned).toBe(0);

			const store = loadErrorFixStore();
			expect(store.patterns[recentSig]).toBeDefined();
		});

		it("should preserve patterns with fixes regardless of age", () => {
			mockDirs.add(".undercity");

			// Old pattern with fix
			mockNow = 1704067200000 - 40 * 24 * 60 * 60 * 1000; // 40 days ago
			const oldSig = recordPendingError("task-1", "typecheck", "Old error", []);
			recordSuccessfulFix("task-1", ["file.ts"], "Fixed");

			mockNow = 1704067200000;
			const pruned = pruneOldPatterns(30 * 24 * 60 * 60 * 1000, ".undercity");

			expect(pruned).toBe(0);

			const store = loadErrorFixStore();
			expect(store.patterns[oldSig]).toBeDefined();
		});

		it("should preserve patterns with high occurrence regardless of age", () => {
			mockDirs.add(".undercity");

			// Old pattern with high occurrence
			mockNow = 1704067200000 - 40 * 24 * 60 * 60 * 1000; // 40 days ago
			const oldSig = recordPendingError("task-1", "typecheck", "Common error", []);
			// Add 4 more occurrences to reach 5 total
			for (let i = 0; i < 4; i++) {
				recordPendingError(`task-${i + 2}`, "typecheck", "Common error", []);
			}

			mockNow = 1704067200000;
			const pruned = pruneOldPatterns(30 * 24 * 60 * 60 * 1000, ".undercity");

			expect(pruned).toBe(0);

			const store = loadErrorFixStore();
			expect(store.patterns[oldSig]).toBeDefined();
			expect(store.patterns[oldSig].occurrences).toBe(5);
		});

		it("should only save when changes were made", () => {
			mockDirs.add(".undercity");

			// Recent pattern that won't be pruned
			recordPendingError("task-1", "typecheck", "Recent error", []);

			// Clear mock to verify save is not called
			mockFiles.clear();
			mockDirs.clear();
			mockDirs.add(".undercity");

			const pruned = pruneOldPatterns(30 * 24 * 60 * 60 * 1000, ".undercity");

			expect(pruned).toBe(0);
			// File should not be written if nothing was pruned
		});

		it("should use custom state directory", () => {
			mockDirs.add("/custom/.undercity");

			mockNow = 1704067200000 - 40 * 24 * 60 * 60 * 1000;
			recordPendingError("task-1", "typecheck", "Old error", [], "/custom/.undercity");

			mockNow = 1704067200000;
			const pruned = pruneOldPatterns(30 * 24 * 60 * 60 * 1000, "/custom/.undercity");

			expect(pruned).toBe(1);
		});
	});

	describe("recordPermanentFailure", () => {
		it("should record permanent failure with full context", () => {
			mockDirs.add(".undercity");

			const signature = recordPermanentFailure(
				"task-1",
				"typecheck",
				"Type error at line 10",
				"Add user authentication",
				"sonnet",
				7,
				["auth.ts", "types.ts"],
			);

			expect(signature).toMatch(/^typecheck-[a-f0-9]{12}$/);

			const store = loadErrorFixStore();
			expect(store.failures).toHaveLength(1);

			const failure = store.failures[0];
			expect(failure.signature).toBe(signature);
			expect(failure.category).toBe("typecheck");
			expect(failure.sampleMessage).toBe("Type error at line 10");
			expect(failure.taskObjective).toBe("Add user authentication");
			expect(failure.modelUsed).toBe("sonnet");
			expect(failure.attemptsCount).toBe(7);
			expect(failure.recordedAt).toBe(new Date(mockNow).toISOString());
		});

		it("should increment pattern occurrences when recording failure", () => {
			mockDirs.add(".undercity");

			recordPermanentFailure("task-1", "lint", "Lint error", "Fix lint", "haiku", 3, []);
			recordPermanentFailure("task-2", "lint", "Lint error", "Fix more lint", "sonnet", 5, []);

			const store = loadErrorFixStore();
			const pattern = Object.values(store.patterns)[0];

			expect(pattern.occurrences).toBe(2);
			expect(store.failures).toHaveLength(2);
		});

		it("should create pattern if it does not exist", () => {
			mockDirs.add(".undercity");

			const signature = recordPermanentFailure("task-1", "test", "Test failed", "Add tests", "opus", 7, []);

			const store = loadErrorFixStore();
			const pattern = store.patterns[signature];

			expect(pattern).toBeDefined();
			expect(pattern.signature).toBe(signature);
			expect(pattern.category).toBe("test");
			expect(pattern.fixes).toEqual([]);
			expect(pattern.occurrences).toBe(1);
		});

		it("should limit failures to 10 most recent", () => {
			mockDirs.add(".undercity");

			// Add 15 failures
			for (let i = 0; i < 15; i++) {
				recordPermanentFailure(`task-${i}`, "build", `Build error ${i}`, `Objective ${i}`, "sonnet", 5, []);
			}

			const store = loadErrorFixStore();

			expect(store.failures).toHaveLength(10);
			// Should keep last 10 (5-14)
			expect(store.failures[0].taskObjective).toBe("Objective 5");
			expect(store.failures[9].taskObjective).toBe("Objective 14");
		});

		it("should truncate message to 500 chars", () => {
			mockDirs.add(".undercity");

			const longMessage = `Error: ${"x".repeat(600)}`;

			recordPermanentFailure("task-1", "typecheck", longMessage, "Long error task", "opus", 7, []);

			const store = loadErrorFixStore();
			const failure = store.failures[0];

			expect(failure.sampleMessage.length).toBe(500);
		});

		it("should truncate taskObjective to 200 chars", () => {
			mockDirs.add(".undercity");

			const longObjective = `Objective: ${"x".repeat(300)}`;

			recordPermanentFailure("task-1", "lint", "Lint error", longObjective, "haiku", 3, []);

			const store = loadErrorFixStore();
			const failure = store.failures[0];

			expect(failure.taskObjective.length).toBe(200);
		});

		it("should clear pending error for the task", () => {
			mockDirs.add(".undercity");

			// Record pending error first
			recordPendingError("task-1", "typecheck", "Type error", ["file.ts"]);

			const storeBefore = loadErrorFixStore();
			expect(storeBefore.pending).toHaveLength(1);

			// Record permanent failure
			recordPermanentFailure("task-1", "typecheck", "Type error", "Failed task", "opus", 7, ["file.ts"]);

			const storeAfter = loadErrorFixStore();
			expect(storeAfter.pending).toHaveLength(0);
			expect(storeAfter.failures).toHaveLength(1);
		});

		it("should handle failures with different models", () => {
			mockDirs.add(".undercity");

			recordPermanentFailure("task-1", "test", "Test error", "Task 1", "haiku", 3, []);
			recordPermanentFailure("task-2", "test", "Test error", "Task 2", "sonnet", 5, []);
			recordPermanentFailure("task-3", "test", "Test error", "Task 3", "opus", 7, []);

			const store = loadErrorFixStore();

			expect(store.failures).toHaveLength(3);
			expect(store.failures[0].modelUsed).toBe("haiku");
			expect(store.failures[1].modelUsed).toBe("sonnet");
			expect(store.failures[2].modelUsed).toBe("opus");
		});

		it("should track different attempt counts", () => {
			mockDirs.add(".undercity");

			recordPermanentFailure("task-1", "lint", "Error 1", "Objective 1", "haiku", 3, []);
			recordPermanentFailure("task-2", "lint", "Error 2", "Objective 2", "sonnet", 5, []);
			recordPermanentFailure("task-3", "lint", "Error 3", "Objective 3", "opus", 7, []);

			const store = loadErrorFixStore();

			expect(store.failures[0].attemptsCount).toBe(3);
			expect(store.failures[1].attemptsCount).toBe(5);
			expect(store.failures[2].attemptsCount).toBe(7);
		});

		it("should persist to disk atomically", () => {
			mockDirs.add(".undercity");

			recordPermanentFailure("task-1", "build", "Build failed", "Build task", "sonnet", 5, []);

			expect(mockFiles.has(".undercity/error-fix-patterns.json")).toBe(true);
			expect(mockFiles.has(".undercity/error-fix-patterns.json.tmp")).toBe(false);
		});

		it("should use custom state directory", () => {
			mockDirs.add("/custom/.undercity");

			recordPermanentFailure("task-1", "test", "Test error", "Test task", "haiku", 3, [], "/custom/.undercity");

			expect(mockFiles.has("/custom/.undercity/error-fix-patterns.json")).toBe(true);

			const store = loadErrorFixStore("/custom/.undercity");
			expect(store.failures).toHaveLength(1);
		});

		it("should handle repeated failures for same error pattern", () => {
			mockDirs.add(".undercity");

			const sig1 = recordPermanentFailure("task-1", "typecheck", "Same error", "Task 1", "haiku", 3, []);
			const sig2 = recordPermanentFailure("task-2", "typecheck", "Same error", "Task 2", "sonnet", 5, []);

			expect(sig1).toBe(sig2);

			const store = loadErrorFixStore();
			const pattern = store.patterns[sig1];

			expect(pattern.occurrences).toBe(2);
			expect(store.failures).toHaveLength(2);
		});

		it("should update lastSeen timestamp on pattern", () => {
			mockDirs.add(".undercity");

			recordPermanentFailure("task-1", "lint", "Error", "Task 1", "haiku", 3, []);

			mockNow = 1704067200000 + 60000; // 1 minute later

			recordPermanentFailure("task-2", "lint", "Error", "Task 2", "sonnet", 5, []);

			const store = loadErrorFixStore();
			const pattern = Object.values(store.patterns)[0];

			expect(pattern.firstSeen).toBe(new Date(1704067200000).toISOString());
			expect(pattern.lastSeen).toBe(new Date(1704067200000 + 60000).toISOString());
		});

		it("should handle empty taskObjective gracefully", () => {
			mockDirs.add(".undercity");

			recordPermanentFailure("task-1", "typecheck", "Error", "", "sonnet", 5, []);

			const store = loadErrorFixStore();
			const failure = store.failures[0];

			expect(failure.taskObjective).toBe("");
		});

		it("should capture detailed errors when using options object", () => {
			mockDirs.add(".undercity");

			recordPermanentFailure({
				taskId: "task-details",
				category: "typecheck",
				message: "Typecheck failed (3 errors)",
				taskObjective: "Fix types",
				modelUsed: "sonnet",
				attemptCount: 5,
				currentFiles: ["src/file.ts"],
				detailedErrors: [
					"src/file.ts:10:5 - error TS2345: Argument of type 'string' is not assignable",
					"src/file.ts:15:10 - error TS2322: Type 'number' is not assignable",
					"src/file.ts:20:3 - error TS2339: Property 'foo' does not exist",
				],
			});

			const store = loadErrorFixStore();
			const failure = store.failures[0];

			expect(failure.detailedErrors).toHaveLength(3);
			expect(failure.detailedErrors?.[0]).toContain("TS2345");
			expect(failure.detailedErrors?.[1]).toContain("TS2322");
			expect(failure.detailedErrors?.[2]).toContain("TS2339");
		});

		it("should truncate long detailed errors", () => {
			mockDirs.add(".undercity");

			const longError = "x".repeat(500);

			recordPermanentFailure({
				taskId: "task-long",
				category: "lint",
				message: "Lint failed",
				taskObjective: "Fix lint",
				modelUsed: "haiku",
				attemptCount: 3,
				currentFiles: [],
				detailedErrors: [longError],
			});

			const store = loadErrorFixStore();
			const failure = store.failures[0];

			expect(failure.detailedErrors?.[0].length).toBe(300);
		});

		it("should limit detailed errors to 10 entries", () => {
			mockDirs.add(".undercity");

			const manyErrors = Array.from({ length: 20 }, (_, i) => `Error ${i}`);

			recordPermanentFailure({
				taskId: "task-many",
				category: "test",
				message: "Tests failed",
				taskObjective: "Fix tests",
				modelUsed: "opus",
				attemptCount: 7,
				currentFiles: [],
				detailedErrors: manyErrors,
			});

			const store = loadErrorFixStore();
			const failure = store.failures[0];

			expect(failure.detailedErrors).toHaveLength(10);
			expect(failure.detailedErrors?.[0]).toBe("Error 0");
			expect(failure.detailedErrors?.[9]).toBe("Error 9");
		});

		it("should preserve failures field in legacy stores", () => {
			mockDirs.add(".undercity");

			// Create legacy store without failures field
			const legacyStore = {
				patterns: {},
				pending: [],
				version: "1.0",
				lastUpdated: new Date(mockNow).toISOString(),
			};
			mockFiles.set(".undercity/error-fix-patterns.json", JSON.stringify(legacyStore));

			// Load should add failures field
			const store = loadErrorFixStore();
			expect(store.failures).toEqual([]);

			// Recording should work
			recordPermanentFailure("task-1", "test", "Error", "Task", "haiku", 3, []);

			const updated = loadErrorFixStore();
			expect(updated.failures).toHaveLength(1);
		});
	});

	describe("Integration scenarios", () => {
		it("should handle full error lifecycle", () => {
			mockDirs.add(".undercity");

			// 1. Record pending error
			const signature = recordPendingError("task-1", "typecheck", "Type error at line 10", ["old.ts"]);

			let store = loadErrorFixStore();
			expect(store.pending).toHaveLength(1);
			expect(store.patterns[signature].occurrences).toBe(1);

			// 2. Record successful fix
			recordSuccessfulFix("task-1", ["old.ts", "new.ts"], "Added type annotation");

			store = loadErrorFixStore();
			expect(store.pending).toHaveLength(0);
			expect(store.patterns[signature].fixes).toHaveLength(1);

			// 3. Find suggestions
			const result = findFixSuggestions("typecheck", "Type error at line 99");

			expect(result).not.toBeNull();
			expect(result!.suggestions).toHaveLength(1);
			expect(result!.suggestions[0].editSummary).toBe("Added type annotation");
		});

		it("should handle multiple parallel errors", () => {
			mockDirs.add(".undercity");

			// Record 3 different errors simultaneously
			const sig1 = recordPendingError("task-1", "typecheck", "Type error", []);
			const sig2 = recordPendingError("task-2", "lint", "Lint error", []);
			const sig3 = recordPendingError("task-3", "test", "Test failed", []);

			expect(sig1).not.toBe(sig2);
			expect(sig2).not.toBe(sig3);

			const store = loadErrorFixStore();
			expect(store.pending).toHaveLength(3);
			expect(Object.keys(store.patterns)).toHaveLength(3);

			// Fix them in different order
			recordSuccessfulFix("task-2", ["file2.ts"], "Fix 2");
			recordSuccessfulFix("task-1", ["file1.ts"], "Fix 1");

			const storeAfter = loadErrorFixStore();
			expect(storeAfter.pending).toHaveLength(1);
			expect(storeAfter.pending[0].taskId).toBe("task-3");
		});

		it("should test pattern matching accuracy", () => {
			mockDirs.add(".undercity");

			// Record error and fix
			recordPendingError("task-1", "typecheck", "Type 'string' is not assignable at line 10", []);
			recordSuccessfulFix("task-1", ["file.ts"], "Fixed type");

			// Similar error should match
			const result1 = findFixSuggestions("typecheck", "Type 'number' is not assignable at line 99");
			expect(result1).not.toBeNull();

			// Different category should not match
			const result2 = findFixSuggestions("lint", "Type 'string' is not assignable at line 10");
			expect(result2).toBeNull();

			// Different error should not match
			const result3 = findFixSuggestions("typecheck", "Cannot find module");
			expect(result3).toBeNull();
		});

		it("should test atomic writes with temp files", () => {
			mockDirs.add(".undercity");

			recordPendingError("task-1", "typecheck", "Error", []);

			// Verify atomic write pattern
			expect(mockFiles.has(".undercity/error-fix-patterns.json")).toBe(true);
			expect(mockFiles.has(".undercity/error-fix-patterns.json.tmp")).toBe(false);

			// Parse and verify structure
			const content = mockFiles.get(".undercity/error-fix-patterns.json");
			expect(content).toBeDefined();

			const parsed = JSON.parse(content!);
			expect(parsed.version).toBe("1.0");
			expect(parsed.lastUpdated).toBeDefined();
		});
	});

	describe("Edge cases", () => {
		it("should handle empty messages", () => {
			mockDirs.add(".undercity");

			const signature = recordPendingError("task-1", "typecheck", "", []);

			expect(signature).toMatch(/^typecheck-[a-f0-9]{12}$/);

			const store = loadErrorFixStore();
			const pattern = store.patterns[signature];

			expect(pattern.sampleMessage).toBe("");
		});

		it("should handle very long messages (500+ char truncation)", () => {
			mockDirs.add(".undercity");

			const longMessage = `Error: ${"x".repeat(1000)}`;

			recordPendingError("task-1", "typecheck", longMessage, []);

			const store = loadErrorFixStore();
			const pattern = Object.values(store.patterns)[0];

			expect(pattern.sampleMessage.length).toBe(500);
			expect(store.pending[0].message.length).toBe(500);
		});

		it("should handle special characters in paths", () => {
			mockDirs.add(".undercity");

			const message = "Error in /path/with spaces/file-name.ts";

			recordPendingError("task-1", "typecheck", message, []);

			const store = loadErrorFixStore();
			expect(Object.keys(store.patterns)).toHaveLength(1);
		});

		it("should handle concurrent rapid operations simulation", () => {
			mockDirs.add(".undercity");

			// Simulate 20 rapid operations with unique error messages
			const taskIds: string[] = [];
			for (let i = 0; i < 20; i++) {
				const taskId = `task-${i}`;
				taskIds.push(taskId);
				// Use unique error messages to create different patterns
				recordPendingError(taskId, "typecheck", `Unique error type ${i} at location X`, []);
			}

			// Verify all recorded
			const store = loadErrorFixStore();
			expect(store.pending.length).toBeLessThanOrEqual(10); // Limited to 10
			expect(Object.keys(store.patterns).length).toBeGreaterThan(0);

			// Fix the ones that are still in pending (last 10)
			const pendingTaskIds = store.pending.map((p) => p.taskId);
			for (const taskId of pendingTaskIds) {
				const taskIndex = Number.parseInt(taskId.split("-")[1], 10);
				recordSuccessfulFix(taskId, [`file${taskIndex}.ts`], `Fix ${taskIndex}`);
			}

			const storeAfter = loadErrorFixStore();
			const totalFixes = Object.values(storeAfter.patterns).reduce((sum, p) => sum + p.fixes.length, 0);
			expect(totalFixes).toBeGreaterThan(0);
		});

		it("should handle custom stateDir usage consistently", () => {
			mockDirs.add("/custom1/.undercity");
			mockDirs.add("/custom2/.undercity");

			// Two separate stores
			recordPendingError("task-1", "typecheck", "Error 1", [], "/custom1/.undercity");
			recordPendingError("task-2", "lint", "Error 2", [], "/custom2/.undercity");

			const store1 = loadErrorFixStore("/custom1/.undercity");
			const store2 = loadErrorFixStore("/custom2/.undercity");

			expect(store1.pending).toHaveLength(1);
			expect(store1.pending[0].taskId).toBe("task-1");

			expect(store2.pending).toHaveLength(1);
			expect(store2.pending[0].taskId).toBe("task-2");
		});

		it("should handle fix suggestions with zero occurrences", () => {
			mockDirs.add(".undercity");

			// Record an error and fix it to create pattern
			recordPendingError("task-1", "test", "Test error message", []);
			recordSuccessfulFix("task-1", ["file.ts"], "Fix");

			// Load store and manually set occurrences to 0
			const store = loadErrorFixStore();
			const signature = Object.keys(store.patterns)[0];
			store.patterns[signature].occurrences = 0;
			store.patterns[signature].fixSuccesses = 0;

			mockFiles.set(".undercity/error-fix-patterns.json", JSON.stringify(store));

			const formatted = formatFixSuggestionsForPrompt("test", "Test error message");

			// Should not crash, should show 0% success rate
			expect(formatted).toContain("0% fix success rate");
		});
	});

	describe("tryAutoRemediate", () => {
		// Test error message used throughout - generate signature once
		const testErrorMessage = "Type error in file";
		const testSignature = generateErrorSignature("typecheck", testErrorMessage);

		it("should return attempted=false when no matching pattern exists", () => {
			mockDirs.add(".undercity");

			const result = tryAutoRemediate("typecheck", "Unknown error", "/some/dir");

			expect(result.attempted).toBe(false);
			expect(result.applied).toBe(false);
		});

		it("should return attempted=false when pattern has no patch data", () => {
			mockDirs.add(".undercity");

			// Record error and fix without patch data (no workingDirectory)
			recordPendingError("task-1", "typecheck", "Error in file.ts", []);
			recordSuccessfulFix("task-1", ["file.ts"], "Fixed the error");

			const result = tryAutoRemediate("typecheck", "Error in file.ts", "/some/dir");

			expect(result.attempted).toBe(false);
			expect(result.applied).toBe(false);
		});

		it("should attempt remediation when pattern has patch data", () => {
			mockDirs.add(".undercity");

			// Create a store with patch data using actual generated signature
			const store: ErrorFixStore = {
				patterns: {
					[testSignature]: {
						signature: testSignature,
						category: "typecheck",
						sampleMessage: testErrorMessage,
						fixes: [
							{
								filesChanged: ["src/file.ts"],
								editSummary: "Fixed type error",
								taskId: "task-1",
								recordedAt: "2024-01-01T00:00:00.000Z",
								patchData: "--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-old\n+new",
							},
						],
						occurrences: 1,
						fixSuccesses: 0,
						firstSeen: "2024-01-01T00:00:00.000Z",
						lastSeen: "2024-01-01T00:00:00.000Z",
					},
				},
				pending: [],
				failures: [],
				version: "1.0",
				lastUpdated: "2024-01-01T00:00:00.000Z",
			};
			mockFiles.set(".undercity/error-fix-patterns.json", JSON.stringify(store));

			// Mock git apply to succeed
			mockExecResult = "";

			const result = tryAutoRemediate("typecheck", testErrorMessage, "/some/dir");

			expect(result.attempted).toBe(true);
			expect(result.applied).toBe(true);
			expect(result.patchedFiles).toEqual(["src/file.ts"]);
		});

		it("should return applied=false when patch fails to apply", () => {
			mockDirs.add(".undercity");

			// Create a store with patch data using actual generated signature
			const store: ErrorFixStore = {
				patterns: {
					[testSignature]: {
						signature: testSignature,
						category: "typecheck",
						sampleMessage: testErrorMessage,
						fixes: [
							{
								filesChanged: ["src/file.ts"],
								editSummary: "Fixed type error",
								taskId: "task-1",
								recordedAt: "2024-01-01T00:00:00.000Z",
								patchData: "--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-old\n+new",
							},
						],
						occurrences: 1,
						fixSuccesses: 0,
						firstSeen: "2024-01-01T00:00:00.000Z",
						lastSeen: "2024-01-01T00:00:00.000Z",
					},
				},
				pending: [],
				failures: [],
				version: "1.0",
				lastUpdated: "2024-01-01T00:00:00.000Z",
			};
			mockFiles.set(".undercity/error-fix-patterns.json", JSON.stringify(store));

			// Mock git apply to fail
			mockExecResult = new Error("patch does not apply");

			const result = tryAutoRemediate("typecheck", testErrorMessage, "/some/dir");

			expect(result.attempted).toBe(true);
			expect(result.applied).toBe(false);
			expect(result.error).toContain("patch does not apply");
		});

		it("should skip remediation when success rate is too low", () => {
			mockDirs.add(".undercity");

			// Create a store with low success rate patch using actual generated signature
			const store: ErrorFixStore = {
				patterns: {
					[testSignature]: {
						signature: testSignature,
						category: "typecheck",
						sampleMessage: testErrorMessage,
						fixes: [
							{
								filesChanged: ["src/file.ts"],
								editSummary: "Fixed type error",
								taskId: "task-1",
								recordedAt: "2024-01-01T00:00:00.000Z",
								patchData: "--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-old\n+new",
								autoApplyCount: 5,
								autoApplySuccessRate: 0.1, // Only 10% success rate
							},
						],
						occurrences: 1,
						fixSuccesses: 0,
						firstSeen: "2024-01-01T00:00:00.000Z",
						lastSeen: "2024-01-01T00:00:00.000Z",
					},
				},
				pending: [],
				failures: [],
				version: "1.0",
				lastUpdated: "2024-01-01T00:00:00.000Z",
			};
			mockFiles.set(".undercity/error-fix-patterns.json", JSON.stringify(store));

			const result = tryAutoRemediate("typecheck", testErrorMessage, "/some/dir");

			expect(result.attempted).toBe(false);
			expect(result.applied).toBe(false);
			expect(result.signature).toBe(testSignature);
		});

		it("should update success rate after successful application", () => {
			mockDirs.add(".undercity");

			// Create a store with patch data using actual generated signature
			const store: ErrorFixStore = {
				patterns: {
					[testSignature]: {
						signature: testSignature,
						category: "typecheck",
						sampleMessage: testErrorMessage,
						fixes: [
							{
								filesChanged: ["src/file.ts"],
								editSummary: "Fixed type error",
								taskId: "task-1",
								recordedAt: "2024-01-01T00:00:00.000Z",
								patchData: "--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-old\n+new",
								autoApplyCount: 2,
								autoApplySuccessRate: 0.5,
							},
						],
						occurrences: 1,
						fixSuccesses: 0,
						firstSeen: "2024-01-01T00:00:00.000Z",
						lastSeen: "2024-01-01T00:00:00.000Z",
					},
				},
				pending: [],
				failures: [],
				version: "1.0",
				lastUpdated: "2024-01-01T00:00:00.000Z",
			};
			mockFiles.set(".undercity/error-fix-patterns.json", JSON.stringify(store));

			// Mock git apply to succeed
			mockExecResult = "";

			tryAutoRemediate("typecheck", testErrorMessage, "/some/dir");

			// Verify stats were updated
			const updatedStore = loadErrorFixStore();
			const pattern = updatedStore.patterns[testSignature];
			expect(pattern.fixes[0].autoApplyCount).toBe(3);
			// Success rate should increase: 0.5 * 0.7 + 0.3 = 0.65
			expect(pattern.fixes[0].autoApplySuccessRate).toBeCloseTo(0.65, 2);
		});

		it("should update success rate after failed application", () => {
			mockDirs.add(".undercity");

			// Create a store with patch data using actual generated signature
			const store: ErrorFixStore = {
				patterns: {
					[testSignature]: {
						signature: testSignature,
						category: "typecheck",
						sampleMessage: testErrorMessage,
						fixes: [
							{
								filesChanged: ["src/file.ts"],
								editSummary: "Fixed type error",
								taskId: "task-1",
								recordedAt: "2024-01-01T00:00:00.000Z",
								patchData: "--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-old\n+new",
								autoApplyCount: 2,
								autoApplySuccessRate: 0.5,
							},
						],
						occurrences: 1,
						fixSuccesses: 0,
						firstSeen: "2024-01-01T00:00:00.000Z",
						lastSeen: "2024-01-01T00:00:00.000Z",
					},
				},
				pending: [],
				failures: [],
				version: "1.0",
				lastUpdated: "2024-01-01T00:00:00.000Z",
			};
			mockFiles.set(".undercity/error-fix-patterns.json", JSON.stringify(store));

			// Mock git apply to fail
			mockExecResult = new Error("patch does not apply");

			tryAutoRemediate("typecheck", testErrorMessage, "/some/dir");

			// Verify stats were updated
			const updatedStore = loadErrorFixStore();
			const pattern = updatedStore.patterns[testSignature];
			expect(pattern.fixes[0].autoApplyCount).toBe(3);
			// Success rate should decrease: 0.5 * 0.7 = 0.35
			expect(pattern.fixes[0].autoApplySuccessRate).toBeCloseTo(0.35, 2);
		});

		it("should prefer higher success rate fixes", () => {
			mockDirs.add(".undercity");

			// Create a store with multiple fixes using actual generated signature
			const store: ErrorFixStore = {
				patterns: {
					[testSignature]: {
						signature: testSignature,
						category: "typecheck",
						sampleMessage: testErrorMessage,
						fixes: [
							{
								filesChanged: ["src/old-fix.ts"],
								editSummary: "Old fix",
								taskId: "task-1",
								recordedAt: "2024-01-01T00:00:00.000Z",
								patchData: "--- a/old\n+++ b/old\n@@ -1 +1 @@\n-x\n+y",
								autoApplyCount: 5,
								autoApplySuccessRate: 0.4,
							},
							{
								filesChanged: ["src/better-fix.ts"],
								editSummary: "Better fix",
								taskId: "task-2",
								recordedAt: "2024-01-02T00:00:00.000Z",
								patchData: "--- a/better\n+++ b/better\n@@ -1 +1 @@\n-a\n+b",
								autoApplyCount: 3,
								autoApplySuccessRate: 0.8,
							},
						],
						occurrences: 2,
						fixSuccesses: 0,
						firstSeen: "2024-01-01T00:00:00.000Z",
						lastSeen: "2024-01-02T00:00:00.000Z",
					},
				},
				pending: [],
				failures: [],
				version: "1.0",
				lastUpdated: "2024-01-02T00:00:00.000Z",
			};
			mockFiles.set(".undercity/error-fix-patterns.json", JSON.stringify(store));

			// Mock git apply to succeed
			mockExecResult = "";

			const result = tryAutoRemediate("typecheck", testErrorMessage, "/some/dir");

			// Should use the better fix (higher success rate)
			expect(result.applied).toBe(true);
			expect(result.patchedFiles).toEqual(["src/better-fix.ts"]);
		});
	});
});
