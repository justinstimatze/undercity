/**
 * Tests for decision-tracker.ts
 *
 * Tests decision capture, resolution, pending decisions retrieval,
 * classification patterns, storage persistence, and edge cases with mock fs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock state
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
let mockNow = 1704067200000; // Fixed timestamp: 2024-01-01T00:00:00.000Z
let mockRandomSeed = 0.123456;

// Store original implementations
const _originalDate = Date;
const _originalDateNow = Date.now;
const _originalMathRandom = Math.random;

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
Math.random = vi.fn(() => mockRandomSeed);

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

// Import after mocking
import {
	captureDecision,
	classifyDecision,
	type DecisionPoint,
	type DecisionStore,
	getPendingDecisions,
	loadDecisionStore,
	resolveDecision,
	updateDecisionOutcome,
} from "../decision-tracker.js";

describe("decision-tracker.ts", () => {
	beforeEach(() => {
		mockFiles.clear();
		mockDirs.clear();
		mockNow = 1704067200000;
		mockRandomSeed = 0.123456;
		vi.clearAllMocks();
	});

	afterEach(() => {
		mockFiles.clear();
		mockDirs.clear();
		vi.clearAllMocks();
	});

	describe("loadDecisionStore", () => {
		it("should return empty store when file does not exist", () => {
			const store = loadDecisionStore();

			expect(store.pending).toEqual([]);
			expect(store.resolved).toEqual([]);
			expect(store.overrides).toEqual([]);
			expect(store.version).toBe("1.0");
			expect(store.lastUpdated).toBe(new Date(mockNow).toISOString());
		});

		it("should load existing store from disk", () => {
			const existingStore: DecisionStore = {
				pending: [
					{
						id: "dec-1",
						taskId: "task-1",
						question: "Should I fix this?",
						context: "Found a bug",
						category: "pm_decidable",
						keywords: ["fix", "bug", "found"],
						capturedAt: "2024-01-01T00:00:00.000Z",
					},
				],
				resolved: [],
				overrides: [],
				version: "1.0",
				lastUpdated: "2024-01-01T00:00:00.000Z",
			};
			mockFiles.set(".undercity/decisions.json", JSON.stringify(existingStore));

			const store = loadDecisionStore();

			expect(store.pending).toHaveLength(1);
			expect(store.pending[0].id).toBe("dec-1");
			expect(store.pending[0].question).toBe("Should I fix this?");
		});

		it("should handle corrupted JSON gracefully", () => {
			mockFiles.set(".undercity/decisions.json", "{ invalid json }");

			const store = loadDecisionStore();

			expect(store.pending).toEqual([]);
			expect(store.resolved).toEqual([]);
			expect(store.version).toBe("1.0");
		});

		it("should use custom state directory", () => {
			const customStore: DecisionStore = {
				pending: [],
				resolved: [],
				overrides: [],
				version: "1.0",
				lastUpdated: "2024-01-01T00:00:00.000Z",
			};
			mockFiles.set("/custom/.undercity/decisions.json", JSON.stringify(customStore));

			const store = loadDecisionStore("/custom/.undercity");

			expect(store).toBeDefined();
			expect(store.version).toBe("1.0");
		});
	});

	describe("classifyDecision", () => {
		it("should classify auto_handle patterns", () => {
			const testCases: Array<[string, string]> = [
				["Should I retry?", "attempting again after failure"],
				["What about lint errors?", "fixing lint in the code"],
				["Need to rebase", "rebasing onto main branch"],
				["Rate limit hit", "throttling requests"],
				["Escalating to better model", "escalating to sonnet model"],
			];

			for (const [question, context] of testCases) {
				const category = classifyDecision(question, context);
				expect(category).toBe("auto_handle");
			}
		});

		it("should classify human_required patterns", () => {
			const testCases: Array<[string, string]> = [
				["Security issue?", "authentication tokens exposed"],
				["Breaking change?", "backwards compatibility concerns"],
				["Should I delete?", "remove production database"],
				["API key found", "credential in source code"],
				["Payment logic", "billing subscription update"],
				["GDPR concern", "personal data processing"],
			];

			for (const [question, context] of testCases) {
				const category = classifyDecision(question, context);
				expect(category).toBe("human_required");
			}
		});

		it("should classify pm_decidable patterns", () => {
			const testCases: Array<[string, string]> = [
				["Should I refactor?", "two approaches available"],
				["Which approach?", "option A or option B"],
				["Refactor while fixing?", "also update other code"],
				["Priority?", "prioritize this task"],
				["Out of scope?", "scope of this change"],
				["Trade-off here", "performance versus readability"],
			];

			for (const [question, context] of testCases) {
				const category = classifyDecision(question, context);
				expect(category).toBe("pm_decidable");
			}
		});

		it("should default to pm_decidable for unmatched patterns", () => {
			const category = classifyDecision("Random question?", "No specific patterns matched here");

			expect(category).toBe("pm_decidable");
		});

		it("should prioritize human_required over other patterns", () => {
			// Question that might match multiple patterns
			const category = classifyDecision("Should I retry?", "Authentication security token issue");

			expect(category).toBe("human_required");
		});

		it("should handle case-insensitive matching", () => {
			const category1 = classifyDecision("SHOULD I RETRY?", "RETRYING NOW");
			const category2 = classifyDecision("should i retry?", "retrying now");

			expect(category1).toBe("auto_handle");
			expect(category2).toBe("auto_handle");
		});
	});

	describe("captureDecision", () => {
		it("should capture a basic decision", () => {
			const decision = captureDecision("task-1", "Should I fix this bug?", "Found a bug in the code");

			expect(decision.id).toMatch(/^dec-/);
			expect(decision.taskId).toBe("task-1");
			expect(decision.question).toBe("Should I fix this bug?");
			expect(decision.context).toBe("Found a bug in the code");
			expect(decision.category).toBe("pm_decidable");
			expect(decision.keywords).toContain("fix");
			expect(decision.keywords).toContain("bug");
			expect(decision.keywords).toContain("code");
			expect(decision.capturedAt).toBe(new Date(mockNow).toISOString());
		});

		it("should capture decision with options", () => {
			const decision = captureDecision("task-1", "Which approach?", "Two ways to solve this", [
				"Approach A",
				"Approach B",
			]);

			expect(decision.options).toEqual(["Approach A", "Approach B"]);
		});

		it("should persist decision to disk", () => {
			mockDirs.add(".undercity");

			captureDecision("task-1", "Question?", "Context");

			expect(mockFiles.has(".undercity/decisions.json")).toBe(true);
			const content = mockFiles.get(".undercity/decisions.json");
			expect(content).toBeDefined();

			const store = JSON.parse(content!) as DecisionStore;
			expect(store.pending).toHaveLength(1);
		});

		it("should create directory if it does not exist", () => {
			captureDecision("task-1", "Question?", "Context");

			expect(mockDirs.has(".undercity")).toBe(true);
		});

		it("should use atomic write with temp file", () => {
			mockDirs.add(".undercity");

			captureDecision("task-1", "Question?", "Context");

			// Should have created temp file and renamed it
			expect(mockFiles.has(".undercity/decisions.json")).toBe(true);
			expect(mockFiles.has(".undercity/decisions.json.tmp")).toBe(false);
		});

		it("should append to existing decisions", () => {
			mockDirs.add(".undercity");

			const decision1 = captureDecision("task-1", "Question 1?", "Context 1");
			mockRandomSeed = 0.654321; // Change seed for different ID
			const decision2 = captureDecision("task-2", "Question 2?", "Context 2");

			const store = loadDecisionStore();
			expect(store.pending).toHaveLength(2);
			expect(store.pending[0].id).toBe(decision1.id);
			expect(store.pending[1].id).toBe(decision2.id);
		});

		it("should extract keywords correctly", () => {
			const decision = captureDecision(
				"task-1",
				"Should I refactor the authentication module?",
				"The code has complex logic and needs simplification",
			);

			expect(decision.keywords).toContain("refactor");
			expect(decision.keywords).toContain("authentication");
			expect(decision.keywords).toContain("module");
			expect(decision.keywords).toContain("code");
			expect(decision.keywords).toContain("complex");
			expect(decision.keywords).toContain("logic");
			expect(decision.keywords).toContain("needs");
			expect(decision.keywords).toContain("simplification");

			// Should not contain stop words
			expect(decision.keywords).not.toContain("the");
			expect(decision.keywords).not.toContain("has");
			expect(decision.keywords).not.toContain("and");
		});

		it("should handle empty strings gracefully", () => {
			const decision = captureDecision("task-1", "", "");

			expect(decision.question).toBe("");
			expect(decision.context).toBe("");
			expect(decision.keywords).toEqual([]);
		});

		it("should handle special characters in text", () => {
			const decision = captureDecision("task-1", "Fix @user's bug?", "Bug in $variable with 100% failure!");

			expect(decision.question).toBe("Fix @user's bug?");
			expect(decision.context).toBe("Bug in $variable with 100% failure!");
			expect(decision.keywords).toContain("fix");
			expect(decision.keywords).toContain("bug");
			expect(decision.keywords).toContain("variable");
			expect(decision.keywords).toContain("failure");
		});

		it("should use custom state directory", () => {
			mockDirs.add("/custom/.undercity");

			captureDecision("task-1", "Question?", "Context", undefined, "/custom/.undercity");

			expect(mockFiles.has("/custom/.undercity/decisions.json")).toBe(true);
		});
	});

	describe("resolveDecision", () => {
		it("should resolve a pending decision", () => {
			const decision = captureDecision("task-1", "Question?", "Context");

			const success = resolveDecision(decision.id, {
				resolvedBy: "pm",
				decision: "Go ahead with approach A",
				reasoning: "It's faster",
				confidence: "high",
			});

			expect(success).toBe(true);

			const store = loadDecisionStore();
			expect(store.pending).toHaveLength(0);
			expect(store.resolved).toHaveLength(1);
			expect(store.resolved[0].id).toBe(decision.id);
			expect(store.resolved[0].resolution.decision).toBe("Go ahead with approach A");
			expect(store.resolved[0].resolution.reasoning).toBe("It's faster");
			expect(store.resolved[0].resolution.confidence).toBe("high");
			expect(store.resolved[0].resolution.resolvedBy).toBe("pm");
		});

		it("should return false for non-existent decision", () => {
			const success = resolveDecision("non-existent-id", {
				resolvedBy: "auto",
				decision: "Done",
			});

			expect(success).toBe(false);
		});

		it("should move decision from pending to resolved", () => {
			const decision = captureDecision("task-1", "Question?", "Context");

			const storeBefore = loadDecisionStore();
			expect(storeBefore.pending).toHaveLength(1);
			expect(storeBefore.resolved).toHaveLength(0);

			resolveDecision(decision.id, {
				resolvedBy: "auto",
				decision: "Fixed",
			});

			const storeAfter = loadDecisionStore();
			expect(storeAfter.pending).toHaveLength(0);
			expect(storeAfter.resolved).toHaveLength(1);
		});

		it("should set resolvedAt timestamp", () => {
			const decision = captureDecision("task-1", "Question?", "Context");

			mockNow = 1704067200000 + 10000; // 10 seconds later
			resolveDecision(decision.id, {
				resolvedBy: "human",
				decision: "Approved",
			});

			const store = loadDecisionStore();
			expect(store.resolved[0].resolution.resolvedAt).toBe(new Date(mockNow).toISOString());
		});

		it("should preserve all decision fields in resolved entry", () => {
			const decision = captureDecision("task-1", "Question?", "Context", ["A", "B"]);

			resolveDecision(decision.id, {
				resolvedBy: "pm",
				decision: "Option A",
			});

			const store = loadDecisionStore();
			const resolved = store.resolved[0];

			expect(resolved.id).toBe(decision.id);
			expect(resolved.taskId).toBe(decision.taskId);
			expect(resolved.question).toBe(decision.question);
			expect(resolved.context).toBe(decision.context);
			expect(resolved.options).toEqual(["A", "B"]);
			expect(resolved.category).toBe(decision.category);
			expect(resolved.keywords).toEqual(decision.keywords);
			expect(resolved.capturedAt).toBe(decision.capturedAt);
		});

		it("should handle resolution with minimal data", () => {
			const decision = captureDecision("task-1", "Question?", "Context");

			const success = resolveDecision(decision.id, {
				resolvedBy: "auto",
				decision: "Done",
			});

			expect(success).toBe(true);

			const store = loadDecisionStore();
			expect(store.resolved[0].resolution.reasoning).toBeUndefined();
			expect(store.resolved[0].resolution.confidence).toBeUndefined();
		});

		it("should use custom state directory", () => {
			mockDirs.add("/custom/.undercity");
			const decision = captureDecision("task-1", "Question?", "Context", undefined, "/custom/.undercity");

			const success = resolveDecision(
				decision.id,
				{
					resolvedBy: "auto",
					decision: "Done",
				},
				"/custom/.undercity",
			);

			expect(success).toBe(true);
		});
	});

	describe("getPendingDecisions", () => {
		it("should return all pending decisions when no taskId provided", () => {
			captureDecision("task-1", "Question 1?", "Context 1");
			mockRandomSeed = 0.654321;
			captureDecision("task-2", "Question 2?", "Context 2");
			mockRandomSeed = 0.987654;
			captureDecision("task-3", "Question 3?", "Context 3");

			const pending = getPendingDecisions();

			expect(pending).toHaveLength(3);
		});

		it("should filter by taskId when provided", () => {
			captureDecision("task-1", "Question 1?", "Context 1");
			mockRandomSeed = 0.654321;
			captureDecision("task-2", "Question 2?", "Context 2");
			mockRandomSeed = 0.987654;
			captureDecision("task-1", "Question 3?", "Context 3");

			const pending = getPendingDecisions("task-1");

			expect(pending).toHaveLength(2);
			expect(pending[0].taskId).toBe("task-1");
			expect(pending[1].taskId).toBe("task-1");
		});

		it("should return empty array when no pending decisions", () => {
			const pending = getPendingDecisions();

			expect(pending).toEqual([]);
		});

		it("should return empty array when taskId not found", () => {
			captureDecision("task-1", "Question?", "Context");

			const pending = getPendingDecisions("task-99");

			expect(pending).toEqual([]);
		});

		it("should not include resolved decisions", () => {
			const decision1 = captureDecision("task-1", "Question 1?", "Context 1");
			mockRandomSeed = 0.654321;
			captureDecision("task-1", "Question 2?", "Context 2");

			resolveDecision(decision1.id, {
				resolvedBy: "auto",
				decision: "Done",
			});

			const pending = getPendingDecisions("task-1");

			expect(pending).toHaveLength(1);
			expect(pending[0].question).toBe("Question 2?");
		});

		it("should use custom state directory", () => {
			mockDirs.add("/custom/.undercity");
			captureDecision("task-1", "Question?", "Context", undefined, "/custom/.undercity");

			const pending = getPendingDecisions(undefined, "/custom/.undercity");

			expect(pending).toHaveLength(1);
		});
	});

	describe("updateDecisionOutcome", () => {
		it("should update outcome of resolved decision", () => {
			const decision = captureDecision("task-1", "Question?", "Context");
			resolveDecision(decision.id, {
				resolvedBy: "pm",
				decision: "Approved",
			});

			const success = updateDecisionOutcome(decision.id, "success");

			expect(success).toBe(true);

			const store = loadDecisionStore();
			expect(store.resolved[0].resolution.outcome).toBe("success");
		});

		it("should update outcome to failure", () => {
			const decision = captureDecision("task-1", "Question?", "Context");
			resolveDecision(decision.id, {
				resolvedBy: "auto",
				decision: "Done",
			});

			updateDecisionOutcome(decision.id, "failure");

			const store = loadDecisionStore();
			expect(store.resolved[0].resolution.outcome).toBe("failure");
		});

		it("should return false for non-existent decision", () => {
			const success = updateDecisionOutcome("non-existent-id", "success");

			expect(success).toBe(false);
		});

		it("should return false for pending decision (not resolved)", () => {
			const decision = captureDecision("task-1", "Question?", "Context");

			const success = updateDecisionOutcome(decision.id, "success");

			expect(success).toBe(false);
		});
	});

	describe("Storage size limits", () => {
		it("should keep only last 500 resolved decisions", () => {
			// Create 501 decisions and resolve them
			const decisions: DecisionPoint[] = [];
			for (let i = 0; i < 501; i++) {
				mockRandomSeed = 0.1 + i * 0.001;
				const decision = captureDecision(`task-${i}`, `Question ${i}?`, `Context ${i}`);
				decisions.push(decision);
				resolveDecision(decision.id, {
					resolvedBy: "auto",
					decision: "Done",
				});
			}

			const store = loadDecisionStore();

			// Should only keep last 500
			expect(store.resolved.length).toBeLessThanOrEqual(500);
			// First decision should be removed
			expect(store.resolved.find((d) => d.id === decisions[0].id)).toBeUndefined();
			// Last decision should be kept
			expect(store.resolved.find((d) => d.id === decisions[500].id)).toBeDefined();
		});
	});

	describe("Integration scenarios", () => {
		it("should handle capture -> resolve -> outcome flow", () => {
			// Capture
			const decision = captureDecision("task-1", "Should I refactor?", "Code is complex", ["Yes", "No"]);

			expect(decision.category).toBe("pm_decidable");

			// Resolve
			const resolved = resolveDecision(decision.id, {
				resolvedBy: "pm",
				decision: "Yes",
				reasoning: "Better maintainability",
				confidence: "high",
			});

			expect(resolved).toBe(true);

			// Update outcome
			const updated = updateDecisionOutcome(decision.id, "success");

			expect(updated).toBe(true);

			// Verify final state
			const store = loadDecisionStore();
			expect(store.pending).toHaveLength(0);
			expect(store.resolved).toHaveLength(1);
			expect(store.resolved[0].resolution.outcome).toBe("success");
		});

		it("should handle multiple decisions lifecycle", () => {
			// Create multiple decisions
			const dec1 = captureDecision("task-1", "Question 1?", "retry now");
			mockRandomSeed = 0.2;
			const dec2 = captureDecision("task-2", "Question 2?", "security issue");
			mockRandomSeed = 0.3;
			const dec3 = captureDecision("task-1", "Question 3?", "should I fix this");

			// Check classifications
			expect(dec1.category).toBe("auto_handle");
			expect(dec2.category).toBe("human_required");
			expect(dec3.category).toBe("pm_decidable");

			// Resolve first two
			resolveDecision(dec1.id, { resolvedBy: "auto", decision: "Retried" });
			resolveDecision(dec2.id, { resolvedBy: "human", decision: "Escalated" });

			// Check state
			const pending = getPendingDecisions();
			expect(pending).toHaveLength(1);
			expect(pending[0].id).toBe(dec3.id);

			const store = loadDecisionStore();
			expect(store.resolved).toHaveLength(2);
		});

		it("should maintain data integrity across multiple operations", () => {
			// Create decision
			const decision = captureDecision("task-1", "Important question?", "Critical context", ["A", "B", "C"]);

			const originalId = decision.id;
			const originalKeywords = [...decision.keywords];

			// Resolve
			resolveDecision(decision.id, {
				resolvedBy: "pm",
				decision: "Option A",
				confidence: "medium",
			});

			// Update outcome
			updateDecisionOutcome(decision.id, "success");

			// Verify all original data preserved
			const store = loadDecisionStore();
			const resolved = store.resolved[0];

			expect(resolved.id).toBe(originalId);
			expect(resolved.question).toBe("Important question?");
			expect(resolved.context).toBe("Critical context");
			expect(resolved.options).toEqual(["A", "B", "C"]);
			expect(resolved.keywords).toEqual(originalKeywords);
			expect(resolved.resolution.decision).toBe("Option A");
			expect(resolved.resolution.confidence).toBe("medium");
			expect(resolved.resolution.outcome).toBe("success");
		});
	});

	describe("Edge cases", () => {
		it("should handle very long text in questions and context", () => {
			const longQuestion = `${"Should I ".repeat(1000)}fix this?`;
			const longContext = "Context ".repeat(1000);

			const decision = captureDecision("task-1", longQuestion, longContext);

			expect(decision.question).toBe(longQuestion);
			expect(decision.context).toBe(longContext);
			expect(decision.keywords.length).toBeGreaterThan(0);
		});

		it("should handle unicode and emoji in text", () => {
			const decision = captureDecision("task-1", "Should I fix this? 🐛", "Found bug in code 中文");

			expect(decision.question).toContain("🐛");
			expect(decision.context).toContain("中文");
		});

		it("should handle concurrent operations simulation", () => {
			// Simulate multiple rapid captures
			const decisions: DecisionPoint[] = [];
			for (let i = 0; i < 10; i++) {
				mockRandomSeed = 0.1 + i * 0.01;
				mockNow = 1704067200000 + i * 100;
				const decision = captureDecision(`task-${i}`, `Question ${i}?`, `Context ${i}`);
				decisions.push(decision);
			}

			// All should be unique
			const ids = decisions.map((d) => d.id);
			const uniqueIds = new Set(ids);
			expect(uniqueIds.size).toBe(ids.length);

			// All should be persisted
			const store = loadDecisionStore();
			expect(store.pending).toHaveLength(10);
		});

		it("should handle null-like values gracefully", () => {
			const decision = captureDecision("task-1", "Question?", "Context", undefined);

			expect(decision.options).toBeUndefined();
			expect(decision.keywords).toBeDefined();
		});

		it("should handle resolution with pending outcome", () => {
			const decision = captureDecision("task-1", "Question?", "Context");

			resolveDecision(decision.id, {
				resolvedBy: "pm",
				decision: "Try it",
				outcome: "pending",
			});

			const store = loadDecisionStore();
			expect(store.resolved[0].resolution.outcome).toBe("pending");
		});
	});
});
