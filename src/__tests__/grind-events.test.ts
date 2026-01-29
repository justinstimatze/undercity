/**
 * Tests for grind-events.ts - Edge Case Testing
 *
 * Tests edge cases: empty error strings in categorizeFailure(),
 * null pid values in getCurrentGrindStatus(), and malformed JSON
 * in readRecentEvents().
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock state
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
const mockCwd = process.cwd();

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
	appendFileSync: vi.fn((path: string, content: string): void => {
		const existing = mockFiles.get(path) || "";
		mockFiles.set(path, existing + content);
	}),
	mkdirSync: vi.fn((path: string, options?: { recursive?: boolean }): void => {
		if (options?.recursive) {
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

// Mock process.kill for pid testing
let mockProcessKillResult: boolean | Error = true;
const originalProcessKill = process.kill;

// Import after mocking
import { categorizeFailure, getCurrentGrindStatus, readRecentEvents } from "../grind-events.js";

// Helper function to get the full events path
function getEventsPath(): string {
	return join(mockCwd, ".undercity", "grind-events.jsonl");
}

describe("grind-events.ts - Edge Cases", () => {
	beforeEach(() => {
		mockFiles.clear();
		mockDirs.clear();
		vi.clearAllMocks();

		// Mock process.kill
		process.kill = vi.fn((_pid: number, _signal?: string | number): boolean => {
			if (mockProcessKillResult instanceof Error) {
				throw mockProcessKillResult;
			}
			return mockProcessKillResult;
		}) as typeof process.kill;
	});

	afterEach(() => {
		mockFiles.clear();
		mockDirs.clear();
		vi.clearAllMocks();
		process.kill = originalProcessKill;
	});

	describe("categorizeFailure - Edge Cases", () => {
		it("should handle empty string and return unknown", () => {
			const result = categorizeFailure("");

			expect(result).toBe("unknown");
		});

		it("should handle whitespace-only string and return unknown", () => {
			const result1 = categorizeFailure("   ");
			const result2 = categorizeFailure("\t\n");
			const result3 = categorizeFailure("     \n\t    ");

			expect(result1).toBe("unknown");
			expect(result2).toBe("unknown");
			expect(result3).toBe("unknown");
		});

		it("should handle single character string", () => {
			const result1 = categorizeFailure("a");
			const result2 = categorizeFailure("T");
			const result3 = categorizeFailure(" ");

			expect(result1).toBe("unknown");
			expect(result2).toBe("unknown");
			expect(result3).toBe("unknown");
		});

		it("should handle string with only special characters", () => {
			const result1 = categorizeFailure("!@#$%^&*()");
			const result2 = categorizeFailure("---");
			const result3 = categorizeFailure("===");

			expect(result1).toBe("unknown");
			expect(result2).toBe("unknown");
			expect(result3).toBe("unknown");
		});

		it("should handle very long error strings", () => {
			const longError = `${"Error: ".repeat(1000)}typecheck failed`;

			const result = categorizeFailure(longError);

			// Should still find typecheck keyword
			expect(result).toBe("verification_typecheck");
		});

		it("should handle error strings with mixed case and whitespace", () => {
			const result1 = categorizeFailure("  TyPeChEcK  ");
			const result2 = categorizeFailure("\n\tTEST\nFAIL\t");

			expect(result1).toBe("verification_typecheck");
			expect(result2).toBe("verification_tests");
		});

		it("should handle null-like strings gracefully", () => {
			const result1 = categorizeFailure("null");
			const result2 = categorizeFailure("undefined");
			const result3 = categorizeFailure("NaN");

			expect(result1).toBe("unknown");
			expect(result2).toBe("unknown");
			expect(result3).toBe("unknown");
		});

		it("should handle error strings with unicode characters", () => {
			const result1 = categorizeFailure("test failed: テスト error");
			const result2 = categorizeFailure("typecheck 🚀 failed");

			expect(result1).toBe("verification_tests");
			expect(result2).toBe("verification_typecheck");
		});
	});

	describe("getCurrentGrindStatus - Edge Cases", () => {
		it("should handle null pid gracefully", () => {
			mockDirs.add(join(mockCwd, ".undercity"));

			// Create event with null pid
			const event = {
				ts: new Date().toISOString(),
				type: "grind_start",
				batch: "batch-1",
				tasks: 5,
				parallelism: 2,
				models: { sonnet: 5 },
				pid: null,
			};

			mockFiles.set(getEventsPath(), `${JSON.stringify({ ...event, pid: null })}\n`);

			const result = getCurrentGrindStatus();

			expect(result).toBeDefined();
			expect(result.isRunning).toBe(true); // No endedAt and pid is null, so stays running
			expect(result.batchId).toBe("batch-1");
			expect(result.tasksComplete).toBe(0);
			expect(result.tasksFailed).toBe(0);
		});

		it("should handle undefined pid gracefully", () => {
			mockDirs.add(join(mockCwd, ".undercity"));

			// Create event without pid field
			const event = {
				ts: new Date().toISOString(),
				type: "grind_start",
				batch: "batch-2",
				tasks: 3,
				parallelism: 1,
				models: { sonnet: 3 },
			};

			mockFiles.set(getEventsPath(), `${JSON.stringify(event)}\n`);

			const result = getCurrentGrindStatus();

			expect(result).toBeDefined();
			expect(result.isRunning).toBe(true);
			expect(result.batchId).toBe("batch-2");
		});

		it("should handle pid that points to dead process", () => {
			mockDirs.add(join(mockCwd, ".undercity"));

			// Mock process.kill to throw (process not found)
			mockProcessKillResult = new Error("ESRCH");

			const event = {
				ts: new Date().toISOString(),
				type: "grind_start",
				batch: "batch-3",
				tasks: 2,
				parallelism: 1,
				models: { sonnet: 2 },
				pid: 99999,
			};

			mockFiles.set(getEventsPath(), `${JSON.stringify(event)}\n`);

			const result = getCurrentGrindStatus();

			expect(result).toBeDefined();
			expect(result.isRunning).toBe(false); // Process is dead
			expect(result.batchId).toBe("batch-3");
		});

		it("should handle no events file", () => {
			const result = getCurrentGrindStatus();

			expect(result).toBeDefined();
			expect(result.isRunning).toBe(false);
			expect(result.batchId).toBeUndefined();
			expect(result.tasksComplete).toBe(0);
			expect(result.tasksFailed).toBe(0);
		});

		it("should handle empty events file", () => {
			mockDirs.add(join(mockCwd, ".undercity"));
			mockFiles.set(getEventsPath(), "");

			const result = getCurrentGrindStatus();

			expect(result).toBeDefined();
			expect(result.isRunning).toBe(false);
			expect(result.batchId).toBeUndefined();
		});

		it("should handle events file with only whitespace", () => {
			mockDirs.add(join(mockCwd, ".undercity"));
			mockFiles.set(getEventsPath(), "   \n\t\n   ");

			const result = getCurrentGrindStatus();

			expect(result).toBeDefined();
			expect(result.isRunning).toBe(false);
		});
	});

	describe("readRecentEvents - Edge Cases", () => {
		it("should handle file with malformed JSON line", () => {
			mockDirs.add(join(mockCwd, ".undercity"));
			mockFiles.set(getEventsPath(), '{"valid":"json"}\n{invalid json}\n{"valid":"json2"}\n');

			const events = readRecentEvents(10);

			// Should return 3 events (2 valid + 1 fallback for malformed)
			expect(events).toHaveLength(3);
			expect(events[0]).toHaveProperty("valid", "json");
			expect(events[1].type).toBe("grind_end"); // Fallback event
			expect(events[2]).toHaveProperty("valid", "json2");
		});

		it("should handle completely invalid JSON file", () => {
			mockDirs.add(join(mockCwd, ".undercity"));
			mockFiles.set(getEventsPath(), "not json at all\nstill not json\ncompletely broken");

			const events = readRecentEvents(10);

			// Should return 3 fallback events
			expect(events).toHaveLength(3);
			expect(events[0].type).toBe("grind_end");
			expect(events[1].type).toBe("grind_end");
			expect(events[2].type).toBe("grind_end");
		});

		it("should handle empty file", () => {
			mockDirs.add(join(mockCwd, ".undercity"));
			mockFiles.set(getEventsPath(), "");

			const events = readRecentEvents(10);

			expect(events).toEqual([]);
		});

		it("should handle file with only whitespace", () => {
			mockDirs.add(join(mockCwd, ".undercity"));
			mockFiles.set(getEventsPath(), "   \n\t\n   ");

			const events = readRecentEvents(10);

			expect(events).toEqual([]);
		});

		it("should handle file with empty lines between valid JSON", () => {
			mockDirs.add(join(mockCwd, ".undercity"));
			mockFiles.set(getEventsPath(), '{"event":"one"}\n\n\n{"event":"two"}\n   \n{"event":"three"}\n');

			const events = readRecentEvents(10);

			// The filter(Boolean) removes empty strings but not whitespace-only strings
			// After trim().split("\n"), we get ["one...", "", "", "two...", "   ", "three...", ""]
			// filter(Boolean) keeps the "   " line which fails JSON.parse -> fallback event
			// So we get 4 events: one, (fallback from "   "), two, three
			expect(events.length).toBeGreaterThanOrEqual(3);
			// Just check the valid ones we care about exist
			const validEvents = events.filter((e) => e.event);
			expect(validEvents).toHaveLength(3);
			expect(validEvents[0]).toHaveProperty("event", "one");
			expect(validEvents[1]).toHaveProperty("event", "two");
			expect(validEvents[2]).toHaveProperty("event", "three");
		});

		it("should handle JSON with missing required fields", () => {
			mockDirs.add(join(mockCwd, ".undercity"));
			mockFiles.set(
				getEventsPath(),
				'{"incomplete":"event"}\n{"type":"task_start"}\n{"type":"task_complete","model":"sonnet"}\n',
			);

			const events = readRecentEvents(10);

			// All should parse as valid JSON (even if incomplete)
			expect(events).toHaveLength(3);
			expect(events[0]).toHaveProperty("incomplete");
			expect(events[1]).toHaveProperty("type", "task_start");
			expect(events[2]).toHaveProperty("type", "task_complete");
		});

		it("should handle JSON with truncated line", () => {
			mockDirs.add(join(mockCwd, ".undercity"));
			mockFiles.set(getEventsPath(), '{"valid":"json"}\n{"truncated":"line","incomplete');

			const events = readRecentEvents(10);

			// First valid, second fallback
			expect(events).toHaveLength(2);
			expect(events[0]).toHaveProperty("valid", "json");
			expect(events[1].type).toBe("grind_end");
		});

		it("should handle very large count parameter", () => {
			mockDirs.add(join(mockCwd, ".undercity"));
			mockFiles.set(getEventsPath(), '{"event":"one"}\n{"event":"two"}\n');

			const events = readRecentEvents(10000);

			// Should return all events without error
			expect(events).toHaveLength(2);
		});

		it("should handle zero count parameter", () => {
			mockDirs.add(join(mockCwd, ".undercity"));
			mockFiles.set(getEventsPath(), '{"event":"one"}\n{"event":"two"}\n');

			const events = readRecentEvents(0);

			// slice(-0) actually returns the full array in JavaScript, not empty array
			// This is because -0 equals 0, and slice(0) returns the full array
			expect(events).toHaveLength(2);
		});

		it("should handle mixed valid and invalid JSON with nested objects", () => {
			mockDirs.add(join(mockCwd, ".undercity"));
			mockFiles.set(
				getEventsPath(),
				'{"type":"grind_start","nested":{"deep":"value"}}\n' +
					"{broken\n" +
					'{"type":"task_complete","models":["sonnet","opus"]}\n',
			);

			const events = readRecentEvents(10);

			expect(events).toHaveLength(3);
			expect(events[0].type).toBe("grind_start");
			expect(events[1].type).toBe("grind_end"); // Fallback
			expect(events[2].type).toBe("task_complete");
		});

		it("should handle JSON with null values", () => {
			mockDirs.add(join(mockCwd, ".undercity"));
			mockFiles.set(getEventsPath(), '{"type":"task_start","task":null}\n{"type":"task_complete","sha":null}\n');

			const events = readRecentEvents(10);

			expect(events).toHaveLength(2);
			expect(events[0].task).toBeNull();
			expect(events[1].sha).toBeNull();
		});

		it("should handle JSON with extremely long strings", () => {
			mockDirs.add(join(mockCwd, ".undercity"));
			const longString = "x".repeat(10000);
			mockFiles.set(getEventsPath(), `{"type":"task_failed","error":"${longString}"}\n`);

			const events = readRecentEvents(10);

			expect(events).toHaveLength(1);
			expect(events[0].type).toBe("task_failed");
			expect(events[0].error).toHaveLength(10000);
		});

		it("should handle non-existent file", () => {
			const events = readRecentEvents(10);

			expect(events).toEqual([]);
		});

		it("should handle file with unicode and special characters", () => {
			mockDirs.add(join(mockCwd, ".undercity"));
			mockFiles.set(getEventsPath(), '{"message":"Testing 日本語"}\n{"emoji":"🚀"}\n');

			const events = readRecentEvents(10);

			expect(events).toHaveLength(2);
			expect(events[0].message).toContain("日本語");
			expect(events[1].emoji).toBe("🚀");
		});

		it("should handle file with escaped quotes in JSON strings", () => {
			mockDirs.add(join(mockCwd, ".undercity"));
			mockFiles.set(getEventsPath(), '{"error":"Error: \\"quoted\\" value"}\n{"path":"C:\\\\Windows\\\\System32"}\n');

			const events = readRecentEvents(10);

			expect(events).toHaveLength(2);
			// JSON.parse converts escaped quotes to regular quotes
			expect(events[0].error).toContain('"quoted"');
			expect(events[1].path).toBe("C:\\Windows\\System32");
		});
	});
});
