/**
 * Capability Ledger Tests
 *
 * Tests for the capability ledger module that tracks keyword patterns
 * from task objectives and their success rates per model tier.
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
import type { CapabilityLedger, TaskResult } from "../capability-ledger.js";
import { getLedgerStats, getRecommendedModel, loadLedger, updateLedger } from "../capability-ledger.js";

/**
 * Create a mock TaskResult with sensible defaults
 */
const createMockTaskResult = (overrides: Partial<TaskResult> = {}): TaskResult => ({
	objective: "fix the login bug",
	model: "sonnet",
	success: true,
	escalated: false,
	...overrides,
});

/**
 * Create a mock CapabilityLedger with sensible defaults
 */
const createMockLedger = (overrides: Partial<CapabilityLedger> = {}): CapabilityLedger => ({
	patterns: {},
	totalEntries: 0,
	version: "1.0",
	lastUpdated: new Date(),
	...overrides,
});

describe("capability-ledger", () => {
	beforeEach(() => {
		// Clear mock state before each test
		mockFiles.clear();
		mockDirs.clear();
		vi.clearAllMocks();
	});

	describe("loadLedger", () => {
		it("returns default ledger when file does not exist", () => {
			const ledger = loadLedger(".test-state");

			expect(ledger.patterns).toEqual({});
			expect(ledger.totalEntries).toBe(0);
			expect(ledger.version).toBe("1.0");
			expect(ledger.lastUpdated).toBeInstanceOf(Date);
		});

		it("loads existing ledger from disk", () => {
			const existingLedger = createMockLedger({
				totalEntries: 10,
				patterns: {
					fix: {
						pattern: "fix",
						byModel: {
							haiku: {
								attempts: 5,
								successes: 4,
								escalations: 1,
								totalTokens: 1000,
								totalDurationMs: 5000,
								totalRetries: 6,
							},
							sonnet: {
								attempts: 3,
								successes: 3,
								escalations: 0,
								totalTokens: 3000,
								totalDurationMs: 9000,
								totalRetries: 3,
							},
							opus: {
								attempts: 2,
								successes: 2,
								escalations: 0,
								totalTokens: 10000,
								totalDurationMs: 6000,
								totalRetries: 2,
							},
						},
						lastSeen: new Date("2024-01-01"),
					},
				},
			});
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(existingLedger));

			const ledger = loadLedger(".test-state");

			expect(ledger.totalEntries).toBe(10);
			expect(ledger.patterns.fix).toBeDefined();
			expect(ledger.patterns.fix.byModel.sonnet.attempts).toBe(5);
		});

		it("returns default ledger when file contains invalid JSON", () => {
			mockFiles.set(".test-state/capability-ledger.json", "{ invalid json }");

			const ledger = loadLedger(".test-state");

			expect(ledger.patterns).toEqual({});
			expect(ledger.totalEntries).toBe(0);
		});

		it("uses default state directory when not specified", () => {
			const ledger = loadLedger();

			expect(ledger.patterns).toEqual({});
			expect(ledger.version).toBe("1.0");
		});
	});

	describe("updateLedger", () => {
		it("creates new pattern entries for new keywords", () => {
			const taskResult = createMockTaskResult({
				objective: "add new feature",
				model: "sonnet",
				success: true,
				escalated: false,
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(ledger.patterns.add).toBeDefined();
			expect(ledger.patterns.add.byModel.sonnet.attempts).toBe(1);
			expect(ledger.patterns.add.byModel.sonnet.successes).toBe(1);
			expect(ledger.patterns.add.byModel.sonnet.escalations).toBe(0);
		});

		it("extracts multiple keywords from a single objective", () => {
			const taskResult = createMockTaskResult({
				objective: "refactor and fix the login module",
				model: "sonnet",
				success: true,
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(ledger.patterns.refactor).toBeDefined();
			expect(ledger.patterns.fix).toBeDefined();
			expect(ledger.patterns.refactor.byModel.sonnet.attempts).toBe(1);
			expect(ledger.patterns.fix.byModel.sonnet.attempts).toBe(1);
		});

		it("updates existing pattern stats", () => {
			// Set up existing ledger
			const existingLedger = createMockLedger({
				totalEntries: 5,
				patterns: {
					fix: {
						pattern: "fix",
						byModel: {
							haiku: { attempts: 3, successes: 2, escalations: 1, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
							sonnet: {
								attempts: 0,
								successes: 0,
								escalations: 0,
								totalTokens: 0,
								totalDurationMs: 0,
								totalRetries: 0,
							},
							opus: { attempts: 0, successes: 0, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
						},
						lastSeen: new Date("2024-01-01"),
					},
				},
			});
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(existingLedger));

			const taskResult = createMockTaskResult({
				objective: "fix another bug",
				model: "sonnet",
				success: true,
				escalated: false,
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(ledger.patterns.fix.byModel.sonnet.attempts).toBe(4);
			expect(ledger.patterns.fix.byModel.sonnet.successes).toBe(3);
			expect(ledger.totalEntries).toBe(6);
		});

		it("records failed tasks correctly", () => {
			const taskResult = createMockTaskResult({
				objective: "implement login feature",
				model: "sonnet",
				success: false,
				escalated: false,
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(ledger.patterns.implement.byModel.sonnet.attempts).toBe(1);
			expect(ledger.patterns.implement.byModel.sonnet.successes).toBe(0);
		});

		it("records escalated tasks correctly", () => {
			const taskResult = createMockTaskResult({
				objective: "debug complex issue",
				model: "sonnet",
				success: true,
				escalated: true,
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(ledger.patterns.debug.byModel.sonnet.attempts).toBe(1);
			expect(ledger.patterns.debug.byModel.sonnet.escalations).toBe(1);
		});

		it("records token cost when provided", () => {
			const taskResult = createMockTaskResult({
				objective: "optimize performance",
				model: "opus",
				success: true,
				tokenCost: 15000,
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(ledger.patterns.optimize.byModel.opus.totalTokens).toBe(15000);
		});

		it("records duration when provided", () => {
			const taskResult = createMockTaskResult({
				objective: "build new component",
				model: "sonnet",
				success: true,
				durationMs: 30000,
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(ledger.patterns.build.byModel.sonnet.totalDurationMs).toBe(30000);
		});

		it("records retry attempts when provided", () => {
			const taskResult = createMockTaskResult({
				objective: "test edge cases",
				model: "sonnet",
				success: true,
				attempts: 3,
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(ledger.patterns.test.byModel.sonnet.totalRetries).toBe(3);
		});

		it("deduplicates keywords in objective", () => {
			const taskResult = createMockTaskResult({
				objective: "fix the bug, then fix another bug",
				model: "sonnet",
				success: true,
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			// Should only count "fix" once despite appearing twice
			expect(ledger.patterns.fix.byModel.sonnet.attempts).toBe(1);
		});

		it("handles punctuation in keywords", () => {
			const taskResult = createMockTaskResult({
				objective: "fix! the bug, add: new feature",
				model: "sonnet",
				success: true,
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(ledger.patterns.fix).toBeDefined();
			expect(ledger.patterns.add).toBeDefined();
		});

		it("ignores objectives with no action keywords", () => {
			const taskResult = createMockTaskResult({
				objective: "hello world",
				model: "sonnet",
				success: true,
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(Object.keys(ledger.patterns)).toHaveLength(0);
			// totalEntries still increments even with no keywords
			expect(ledger.totalEntries).toBe(1);
		});

		it("creates directory if it does not exist", () => {
			mockDirs.clear();

			const taskResult = createMockTaskResult({
				objective: "add new feature",
				model: "sonnet",
			});

			updateLedger(taskResult, ".new-state-dir");

			expect(mockDirs.has(".new-state-dir")).toBe(true);
		});

		it("handles migration of old ledgers without new fields", () => {
			// Simulate old ledger format without totalTokens, totalDurationMs, totalRetries
			const oldLedger = {
				patterns: {
					fix: {
						pattern: "fix",
						byModel: {
							haiku: { attempts: 3, successes: 2, escalations: 1 },
							sonnet: { attempts: 0, successes: 0, escalations: 0 },
							opus: { attempts: 0, successes: 0, escalations: 0 },
						},
						lastSeen: new Date("2024-01-01"),
					},
				},
				totalEntries: 3,
				version: "1.0",
				lastUpdated: new Date(),
			};
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(oldLedger));

			const taskResult = createMockTaskResult({
				objective: "fix bug",
				model: "sonnet",
				success: true,
				tokenCost: 1000,
			});

			// Should not throw and should add the new fields
			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(ledger.patterns.fix.byModel.sonnet.totalTokens).toBe(1000);
			expect(ledger.patterns.fix.byModel.sonnet.attempts).toBe(4);
		});
	});

	describe("getRecommendedModel", () => {
		it("returns sonnet with low confidence when no keywords found", () => {
			// Create a ledger with enough entries but no matching keywords
			const ledger = createMockLedger({ totalEntries: 10 });
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(ledger));

			const recommendation = getRecommendedModel("hello world", ".test-state");

			expect(recommendation.model).toBe("sonnet");
			expect(recommendation.confidence).toBe(0.3);
			expect(recommendation.reason).toContain("Insufficient data");
		});

		it("returns sonnet when insufficient total entries", () => {
			const ledger = createMockLedger({ totalEntries: 3 });
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(ledger));

			const recommendation = getRecommendedModel("fix bug", ".test-state");

			expect(recommendation.model).toBe("sonnet");
			expect(recommendation.confidence).toBe(0.3);
			expect(recommendation.reason).toContain("Insufficient data");
		});

		it("returns sonnet when no matching patterns found", () => {
			const ledger = createMockLedger({
				totalEntries: 10,
				patterns: {
					add: {
						pattern: "add",
						byModel: {
							haiku: { attempts: 5, successes: 4, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 5 },
							sonnet: {
								attempts: 0,
								successes: 0,
								escalations: 0,
								totalTokens: 0,
								totalDurationMs: 0,
								totalRetries: 0,
							},
							opus: { attempts: 0, successes: 0, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
						},
						lastSeen: new Date(),
					},
				},
			});
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(ledger));

			const recommendation = getRecommendedModel("fix bug", ".test-state");

			expect(recommendation.model).toBe("sonnet");
			expect(recommendation.reason).toContain("No matching patterns");
		});

		it("recommends sonnet when sonnet is viable and not escalating", () => {
			const ledger = createMockLedger({
				totalEntries: 10,
				patterns: {
					fix: {
						pattern: "fix",
						byModel: {
							haiku: {
								attempts: 10,
								successes: 9,
								escalations: 1,
								totalTokens: 5000,
								totalDurationMs: 30000,
								totalRetries: 11,
							},
							sonnet: {
								attempts: 0,
								successes: 0,
								escalations: 0,
								totalTokens: 0,
								totalDurationMs: 0,
								totalRetries: 0,
							},
							opus: { attempts: 0, successes: 0, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
						},
						lastSeen: new Date(),
					},
				},
			});
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(ledger));

			const recommendation = getRecommendedModel("fix the bug", ".test-state");

			expect(recommendation.model).toBe("sonnet");
			expect(recommendation.confidence).toBeGreaterThan(0.5);
			expect(recommendation.patternRates).toBeDefined();
			expect(recommendation.costMetrics).toBeDefined();
		});

		it("recommends opus when escalation rate is high", () => {
			const ledger = createMockLedger({
				totalEntries: 10,
				patterns: {
					refactor: {
						pattern: "refactor",
						byModel: {
							// High escalation rate (>=30%) and low success for haiku
							haiku: {
								attempts: 10,
								successes: 3,
								escalations: 4,
								totalTokens: 5000,
								totalDurationMs: 50000,
								totalRetries: 15,
							},
							// High escalation rate (>=30%) and low success for sonnet
							sonnet: {
								attempts: 10,
								successes: 3,
								escalations: 4,
								totalTokens: 15000,
								totalDurationMs: 45000,
								totalRetries: 12,
							},
							// Not enough attempts for opus expected value
							opus: {
								attempts: 2,
								successes: 2,
								escalations: 0,
								totalTokens: 20000,
								totalDurationMs: 18000,
								totalRetries: 2,
							},
						},
						lastSeen: new Date(),
					},
				},
			});
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(ledger));

			const recommendation = getRecommendedModel("refactor the module", ".test-state");

			expect(recommendation.model).toBe("opus");
			expect(recommendation.reason).toContain("escalation");
		});

		it("aggregates stats across multiple matching keywords", () => {
			const ledger = createMockLedger({
				totalEntries: 20,
				patterns: {
					fix: {
						pattern: "fix",
						byModel: {
							haiku: {
								attempts: 5,
								successes: 4,
								escalations: 0,
								totalTokens: 2500,
								totalDurationMs: 15000,
								totalRetries: 5,
							},
							sonnet: {
								attempts: 3,
								successes: 3,
								escalations: 0,
								totalTokens: 9000,
								totalDurationMs: 27000,
								totalRetries: 3,
							},
							opus: { attempts: 0, successes: 0, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
						},
						lastSeen: new Date(),
					},
					add: {
						pattern: "add",
						byModel: {
							haiku: {
								attempts: 5,
								successes: 4,
								escalations: 0,
								totalTokens: 2500,
								totalDurationMs: 15000,
								totalRetries: 5,
							},
							sonnet: {
								attempts: 2,
								successes: 2,
								escalations: 0,
								totalTokens: 6000,
								totalDurationMs: 18000,
								totalRetries: 2,
							},
							opus: { attempts: 0, successes: 0, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
						},
						lastSeen: new Date(),
					},
				},
			});
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(ledger));

			const recommendation = getRecommendedModel("fix and add feature", ".test-state");

			// haiku has 10 attempts, 8 successes across both patterns = 80% success rate
			expect(recommendation.patternRates?.sonnet.attempts).toBe(10);
			expect(recommendation.patternRates?.sonnet.successRate).toBeCloseTo(0.8, 2);
		});

		it("calculates expected value correctly for cost-based recommendation", () => {
			const ledger = createMockLedger({
				totalEntries: 30,
				patterns: {
					optimize: {
						pattern: "optimize",
						byModel: {
							// Haiku: 70% success rate, 1.5 avg retries
							haiku: {
								attempts: 10,
								successes: 7,
								escalations: 2,
								totalTokens: 5000,
								totalDurationMs: 30000,
								totalRetries: 15,
							},
							// Sonnet: 90% success rate, 1.2 avg retries
							sonnet: {
								attempts: 10,
								successes: 9,
								escalations: 0,
								totalTokens: 30000,
								totalDurationMs: 90000,
								totalRetries: 12,
							},
							// Opus: 95% success rate, 1.0 avg retries
							opus: {
								attempts: 5,
								successes: 5,
								escalations: 0,
								totalTokens: 50000,
								totalDurationMs: 45000,
								totalRetries: 5,
							},
						},
						lastSeen: new Date(),
					},
				},
			});
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(ledger));

			const recommendation = getRecommendedModel("optimize performance", ".test-state");

			// All models have >= 3 attempts and >= 60% success rate
			// Expected values:
			// - haiku: 0.7 / (1 * 1.5) = 0.467
			// - sonnet: 0.9 / (10 * 1.2) = 0.075
			// - opus: 0.95 / (100 * 1.0) = 0.0095 (actually uses success of 1.0 = 5/5)
			// haiku has best expected value
			expect(recommendation.model).toBe("sonnet");
			expect(recommendation.costMetrics?.sonnet.expectedValue).toBeGreaterThan(0);
		});

		it("returns cost metrics with average calculations", () => {
			const ledger = createMockLedger({
				totalEntries: 10,
				patterns: {
					test: {
						pattern: "test",
						byModel: {
							haiku: {
								attempts: 4,
								successes: 3,
								escalations: 1,
								totalTokens: 4000,
								totalDurationMs: 20000,
								totalRetries: 8,
							},
							sonnet: {
								attempts: 0,
								successes: 0,
								escalations: 0,
								totalTokens: 0,
								totalDurationMs: 0,
								totalRetries: 0,
							},
							opus: { attempts: 0, successes: 0, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
						},
						lastSeen: new Date(),
					},
				},
			});
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(ledger));

			const recommendation = getRecommendedModel("test feature", ".test-state");

			expect(recommendation.costMetrics?.sonnet.avgTokens).toBe(1000); // 4000/4
			expect(recommendation.costMetrics?.sonnet.avgDurationMs).toBe(5000); // 20000/4
			expect(recommendation.costMetrics?.sonnet.avgRetries).toBe(2); // 8/4
		});

		it("uses fallback logic when insufficient data for expected value", () => {
			const ledger = createMockLedger({
				totalEntries: 10,
				patterns: {
					deploy: {
						pattern: "deploy",
						byModel: {
							// Only 2 attempts - below minimum threshold for expected value
							haiku: {
								attempts: 2,
								successes: 2,
								escalations: 0,
								totalTokens: 1000,
								totalDurationMs: 10000,
								totalRetries: 2,
							},
							// 4 attempts but only 50% success - below 60% threshold
							sonnet: {
								attempts: 4,
								successes: 2,
								escalations: 0,
								totalTokens: 12000,
								totalDurationMs: 36000,
								totalRetries: 4,
							},
							// Only 1 attempt - below threshold
							opus: {
								attempts: 1,
								successes: 0,
								escalations: 0,
								totalTokens: 10000,
								totalDurationMs: 9000,
								totalRetries: 1,
							},
						},
						lastSeen: new Date(),
					},
				},
			});
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(ledger));

			const recommendation = getRecommendedModel("deploy application", ".test-state");

			// Should use fallback logic since no model meets expected value criteria
			// Neither haiku (2 attempts) nor sonnet (50% success) nor opus (1 attempt) meet thresholds
			expect(recommendation.model).toBe("sonnet");
			expect(recommendation.reason).toContain("Insufficient conclusive data");
		});

		it("recommends sonnet when sonnet is viable and haiku is not", () => {
			const ledger = createMockLedger({
				totalEntries: 15,
				patterns: {
					migrate: {
						pattern: "migrate",
						byModel: {
							haiku: {
								attempts: 5,
								successes: 2,
								escalations: 2,
								totalTokens: 2500,
								totalDurationMs: 25000,
								totalRetries: 7,
							},
							sonnet: {
								attempts: 5,
								successes: 5,
								escalations: 0,
								totalTokens: 15000,
								totalDurationMs: 45000,
								totalRetries: 5,
							},
							opus: { attempts: 0, successes: 0, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
						},
						lastSeen: new Date(),
					},
				},
			});
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(ledger));

			const recommendation = getRecommendedModel("migrate database", ".test-state");

			// Sonnet has best expected value: 1.0 / (10 * 1) = 0.1
			// vs haiku: 0.4 / (1 * 1.4) = 0.286 but only 40% success rate (below 60%)
			expect(recommendation.model).toBe("sonnet");
		});

		it("recommends opus when opus has good success rate and others fail", () => {
			const ledger = createMockLedger({
				totalEntries: 15,
				patterns: {
					investigate: {
						pattern: "investigate",
						byModel: {
							haiku: {
								attempts: 4,
								successes: 1,
								escalations: 3,
								totalTokens: 2000,
								totalDurationMs: 20000,
								totalRetries: 6,
							},
							sonnet: {
								attempts: 4,
								successes: 1,
								escalations: 3,
								totalTokens: 12000,
								totalDurationMs: 36000,
								totalRetries: 6,
							},
							opus: {
								attempts: 3,
								successes: 3,
								escalations: 0,
								totalTokens: 30000,
								totalDurationMs: 27000,
								totalRetries: 3,
							},
						},
						lastSeen: new Date(),
					},
				},
			});
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(ledger));

			const recommendation = getRecommendedModel("investigate memory leak", ".test-state");

			expect(recommendation.model).toBe("opus");
		});
	});

	describe("getLedgerStats", () => {
		it("returns zero stats for empty ledger", () => {
			const stats = getLedgerStats(".test-state");

			expect(stats.totalEntries).toBe(0);
			expect(stats.patternCount).toBe(0);
			expect(stats.topPatterns).toHaveLength(0);
			expect(stats.modelDistribution.sonnet).toBe(0);
			expect(stats.modelDistribution.sonnet).toBe(0);
			expect(stats.modelDistribution.opus).toBe(0);
		});

		it("returns correct pattern count", () => {
			const ledger = createMockLedger({
				totalEntries: 10,
				patterns: {
					fix: {
						pattern: "fix",
						byModel: {
							haiku: { attempts: 3, successes: 2, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
							sonnet: {
								attempts: 2,
								successes: 2,
								escalations: 0,
								totalTokens: 0,
								totalDurationMs: 0,
								totalRetries: 0,
							},
							opus: { attempts: 0, successes: 0, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
						},
						lastSeen: new Date(),
					},
					add: {
						pattern: "add",
						byModel: {
							haiku: { attempts: 2, successes: 2, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
							sonnet: {
								attempts: 1,
								successes: 1,
								escalations: 0,
								totalTokens: 0,
								totalDurationMs: 0,
								totalRetries: 0,
							},
							opus: { attempts: 0, successes: 0, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
						},
						lastSeen: new Date(),
					},
				},
			});
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(ledger));

			const stats = getLedgerStats(".test-state");

			expect(stats.patternCount).toBe(2);
			expect(stats.totalEntries).toBe(10);
		});

		it("calculates model distribution correctly", () => {
			const ledger = createMockLedger({
				totalEntries: 15,
				patterns: {
					fix: {
						pattern: "fix",
						byModel: {
							haiku: { attempts: 5, successes: 4, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
							sonnet: {
								attempts: 3,
								successes: 3,
								escalations: 0,
								totalTokens: 0,
								totalDurationMs: 0,
								totalRetries: 0,
							},
							opus: { attempts: 2, successes: 2, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
						},
						lastSeen: new Date(),
					},
					add: {
						pattern: "add",
						byModel: {
							haiku: { attempts: 3, successes: 2, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
							sonnet: {
								attempts: 2,
								successes: 2,
								escalations: 0,
								totalTokens: 0,
								totalDurationMs: 0,
								totalRetries: 0,
							},
							opus: { attempts: 0, successes: 0, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
						},
						lastSeen: new Date(),
					},
				},
			});
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(ledger));

			const stats = getLedgerStats(".test-state");

			expect(stats.modelDistribution.sonnet).toBe(8); // 5 + 3
			expect(stats.modelDistribution.sonnet).toBe(5); // 3 + 2
			expect(stats.modelDistribution.opus).toBe(2); // 2 + 0
		});

		it("returns top patterns sorted by total attempts", () => {
			const ledger = createMockLedger({
				totalEntries: 30,
				patterns: {
					fix: {
						pattern: "fix",
						byModel: {
							haiku: {
								attempts: 10,
								successes: 8,
								escalations: 0,
								totalTokens: 0,
								totalDurationMs: 0,
								totalRetries: 0,
							},
							sonnet: {
								attempts: 5,
								successes: 5,
								escalations: 0,
								totalTokens: 0,
								totalDurationMs: 0,
								totalRetries: 0,
							},
							opus: { attempts: 0, successes: 0, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
						},
						lastSeen: new Date(),
					},
					add: {
						pattern: "add",
						byModel: {
							haiku: { attempts: 3, successes: 2, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
							sonnet: {
								attempts: 2,
								successes: 2,
								escalations: 0,
								totalTokens: 0,
								totalDurationMs: 0,
								totalRetries: 0,
							},
							opus: { attempts: 0, successes: 0, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
						},
						lastSeen: new Date(),
					},
					refactor: {
						pattern: "refactor",
						byModel: {
							haiku: { attempts: 5, successes: 3, escalations: 1, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
							sonnet: {
								attempts: 3,
								successes: 3,
								escalations: 0,
								totalTokens: 0,
								totalDurationMs: 0,
								totalRetries: 0,
							},
							opus: { attempts: 2, successes: 2, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
						},
						lastSeen: new Date(),
					},
				},
			});
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(ledger));

			const stats = getLedgerStats(".test-state");

			expect(stats.topPatterns[0].pattern).toBe("fix");
			expect(stats.topPatterns[0].attempts).toBe(15); // 10 + 5 + 0
			expect(stats.topPatterns[1].pattern).toBe("refactor");
			expect(stats.topPatterns[1].attempts).toBe(10); // 5 + 3 + 2
			expect(stats.topPatterns[2].pattern).toBe("add");
			expect(stats.topPatterns[2].attempts).toBe(5); // 3 + 2 + 0
		});

		it("limits top patterns to 10", () => {
			const patterns: CapabilityLedger["patterns"] = {};
			for (let i = 0; i < 15; i++) {
				const name = `pattern${i}`;
				patterns[name] = {
					pattern: name,
					byModel: {
						haiku: {
							attempts: i + 1,
							successes: i,
							escalations: 0,
							totalTokens: 0,
							totalDurationMs: 0,
							totalRetries: 0,
						},
						sonnet: { attempts: 0, successes: 0, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
						opus: { attempts: 0, successes: 0, escalations: 0, totalTokens: 0, totalDurationMs: 0, totalRetries: 0 },
					},
					lastSeen: new Date(),
				};
			}

			const ledger = createMockLedger({ totalEntries: 100, patterns });
			mockFiles.set(".test-state/capability-ledger.json", JSON.stringify(ledger));

			const stats = getLedgerStats(".test-state");

			expect(stats.topPatterns.length).toBe(10);
		});
	});

	describe("keyword extraction", () => {
		it("extracts all action patterns", () => {
			// Test a subset of action patterns
			const actionKeywords = ["add", "fix", "refactor", "update", "remove", "create", "implement", "optimize"];

			for (const keyword of actionKeywords) {
				mockFiles.clear();
				const taskResult = createMockTaskResult({
					objective: `${keyword} something`,
					model: "sonnet",
				});

				updateLedger(taskResult, ".test-state");

				const ledger = loadLedger(".test-state");
				expect(ledger.patterns[keyword]).toBeDefined();
			}
		});

		it("handles empty objective", () => {
			const taskResult = createMockTaskResult({
				objective: "",
				model: "sonnet",
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(Object.keys(ledger.patterns)).toHaveLength(0);
		});

		it("handles objective with only punctuation", () => {
			const taskResult = createMockTaskResult({
				objective: "!!! ??? ###",
				model: "sonnet",
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(Object.keys(ledger.patterns)).toHaveLength(0);
		});

		it("is case insensitive", () => {
			const taskResult = createMockTaskResult({
				objective: "FIX THE BUG",
				model: "sonnet",
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(ledger.patterns.fix).toBeDefined();
		});
	});

	describe("ledger persistence", () => {
		it("persists data across multiple operations", () => {
			// First operation
			updateLedger(
				createMockTaskResult({
					objective: "fix bug one",
					model: "sonnet",
					success: true,
				}),
				".test-state",
			);

			// Second operation
			updateLedger(
				createMockTaskResult({
					objective: "fix bug two",
					model: "sonnet",
					success: false,
				}),
				".test-state",
			);

			// Third operation with different keyword
			updateLedger(
				createMockTaskResult({
					objective: "add feature",
					model: "sonnet",
					success: true,
				}),
				".test-state",
			);

			const ledger = loadLedger(".test-state");

			expect(ledger.totalEntries).toBe(3);
			expect(ledger.patterns.fix.byModel.sonnet.attempts).toBe(2);
			expect(ledger.patterns.fix.byModel.sonnet.successes).toBe(1);
			expect(ledger.patterns.add.byModel.sonnet.attempts).toBe(1);
		});

		it("uses atomic write with temp file", async () => {
			const { writeFileSync, renameSync } = await import("node:fs");

			const taskResult = createMockTaskResult({
				objective: "fix bug",
				model: "sonnet",
			});

			updateLedger(taskResult, ".test-state");

			// Should write to temp file first
			expect(writeFileSync).toHaveBeenCalled();
			// Then rename to final path
			expect(renameSync).toHaveBeenCalled();
		});

		it("updates lastUpdated timestamp on save", () => {
			const beforeUpdate = new Date();

			updateLedger(
				createMockTaskResult({
					objective: "fix bug",
					model: "sonnet",
				}),
				".test-state",
			);

			const afterUpdate = new Date();
			const ledgerJson = mockFiles.get(".test-state/capability-ledger.json");
			const ledger = JSON.parse(ledgerJson ?? "{}");
			const lastUpdated = new Date(ledger.lastUpdated);

			expect(lastUpdated.getTime()).toBeGreaterThanOrEqual(beforeUpdate.getTime());
			expect(lastUpdated.getTime()).toBeLessThanOrEqual(afterUpdate.getTime());
		});
	});

	describe("edge cases", () => {
		it("handles very long objectives", () => {
			const longObjective = `${"fix ".repeat(1000)}the bug`;
			const taskResult = createMockTaskResult({
				objective: longObjective,
				model: "sonnet",
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(ledger.patterns.fix).toBeDefined();
			// Only one "fix" counted despite many repetitions
			expect(ledger.patterns.fix.byModel.sonnet.attempts).toBe(1);
		});

		it("handles special characters in objectives", () => {
			// Special characters attached to words get stripped by cleaning
			// "fix@bug" becomes "fixbug" which isn't in ACTION_PATTERNS
			// Use spaces around keywords to ensure they're extracted
			const taskResult = createMockTaskResult({
				objective: "fix @ bug # 1 and add $ feature % 2",
				model: "sonnet",
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(ledger.patterns.fix).toBeDefined();
			expect(ledger.patterns.add).toBeDefined();
		});

		it("handles numeric strings in objectives", () => {
			const taskResult = createMockTaskResult({
				objective: "fix 123 bugs and add 456 features",
				model: "sonnet",
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(ledger.patterns.fix).toBeDefined();
			expect(ledger.patterns.add).toBeDefined();
		});

		it("handles zero token cost and duration", () => {
			const taskResult = createMockTaskResult({
				objective: "fix bug",
				model: "sonnet",
				tokenCost: 0,
				durationMs: 0,
				attempts: 0,
			});

			updateLedger(taskResult, ".test-state");

			const ledger = loadLedger(".test-state");
			expect(ledger.patterns.fix.byModel.sonnet.totalTokens).toBe(0);
			expect(ledger.patterns.fix.byModel.sonnet.totalDurationMs).toBe(0);
			expect(ledger.patterns.fix.byModel.sonnet.totalRetries).toBe(0);
		});

		it("handles all model tiers", () => {
			for (const model of ["sonnet", "sonnet", "opus"] as const) {
				mockFiles.clear();
				const taskResult = createMockTaskResult({
					objective: "fix bug",
					model,
				});

				updateLedger(taskResult, ".test-state");

				const ledger = loadLedger(".test-state");
				expect(ledger.patterns.fix.byModel[model].attempts).toBe(1);
			}
		});
	});
});
