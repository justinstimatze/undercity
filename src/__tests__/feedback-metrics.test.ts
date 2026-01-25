/**
 * Tests for feedback-metrics.ts
 * Pattern learning and metrics analysis
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	analyzeMetrics,
	analyzeTaskPatterns,
	extractKeywords,
	findSimilarTasks,
	formatAnalysisSummary,
	formatPatternSummary,
	getSuccessRate,
	loadMetrics,
	type MetricsAnalysis,
	suggestModelTier,
} from "../feedback-metrics.js";

// Mock fs module
vi.mock("node:fs", async () => {
	const actual = await vi.importActual("node:fs");
	return {
		...actual,
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
	};
});

import { existsSync, readFileSync } from "node:fs";

describe("feedback-metrics", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("extractKeywords", () => {
		it("should extract meaningful words from objective", () => {
			const keywords = extractKeywords("Add authentication to the user login page");
			expect(keywords).toContain("add");
			expect(keywords).toContain("authentication");
			expect(keywords).toContain("user");
			expect(keywords).toContain("login");
			expect(keywords).toContain("page");
		});

		it("should filter out stop words", () => {
			const keywords = extractKeywords("The quick brown fox jumps with the lazy dog");
			expect(keywords).not.toContain("the");
			expect(keywords).not.toContain("with");
			expect(keywords).toContain("quick");
			expect(keywords).toContain("brown");
			expect(keywords).toContain("fox");
		});

		it("should filter out short words (< 3 chars)", () => {
			const keywords = extractKeywords("Go to the API and fix it");
			expect(keywords).not.toContain("go");
			expect(keywords).not.toContain("to");
			expect(keywords).not.toContain("it");
			expect(keywords).toContain("api");
			expect(keywords).toContain("fix");
		});

		it("should return unique keywords", () => {
			const keywords = extractKeywords("Fix the bug in the bug tracker");
			const bugCount = keywords.filter((k) => k === "bug").length;
			expect(bugCount).toBe(1);
		});

		it("should handle special characters", () => {
			const keywords = extractKeywords("Update user-profile component (React)");
			expect(keywords).toContain("update");
			expect(keywords).toContain("user-profile");
			expect(keywords).toContain("component");
			expect(keywords).toContain("react");
		});

		it("should return empty array for empty string", () => {
			const keywords = extractKeywords("");
			expect(keywords).toEqual([]);
		});

		it("should handle only stop words", () => {
			const keywords = extractKeywords("the and or but if");
			expect(keywords).toEqual([]);
		});
	});

	describe("loadMetrics", () => {
		it("should return empty array if file does not exist", () => {
			vi.mocked(existsSync).mockReturnValue(false);
			const records = loadMetrics();
			expect(records).toEqual([]);
		});

		it("should parse JSONL file correctly", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				`{"taskId":"t1","objective":"Fix bug","success":true,"durationMs":1000,"totalTokens":500,"startedAt":"2024-01-01T00:00:00Z","completedAt":"2024-01-01T00:01:00Z","finalModel":"sonnet"}
{"taskId":"t2","objective":"Add feature","success":false,"durationMs":2000,"totalTokens":1000,"startedAt":"2024-01-02T00:00:00Z","completedAt":"2024-01-02T00:02:00Z","finalModel":"opus"}`,
			);

			const records = loadMetrics();
			expect(records).toHaveLength(2);
			expect(records[0].taskId).toBe("t1");
			expect(records[0].success).toBe(true);
			expect(records[1].taskId).toBe("t2");
			expect(records[1].success).toBe(false);
		});

		it("should handle old questId format", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				`{"questId":"q1","objective":"Old task","success":true,"durationMs":1000,"totalTokens":500}`,
			);

			const records = loadMetrics();
			expect(records).toHaveLength(1);
			expect(records[0].taskId).toBe("q1");
		});

		it("should apply limit option", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				`{"taskId":"t1","objective":"Task 1","success":true,"durationMs":1000,"totalTokens":500}
{"taskId":"t2","objective":"Task 2","success":true,"durationMs":1000,"totalTokens":500}
{"taskId":"t3","objective":"Task 3","success":true,"durationMs":1000,"totalTokens":500}`,
			);

			const records = loadMetrics({ limit: 2 });
			expect(records).toHaveLength(2);
			expect(records[0].taskId).toBe("t2"); // Most recent 2
			expect(records[1].taskId).toBe("t3");
		});

		it("should apply since option", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				`{"taskId":"t1","objective":"Old task","success":true,"durationMs":1000,"totalTokens":500,"startedAt":"2024-01-01T00:00:00Z"}
{"taskId":"t2","objective":"New task","success":true,"durationMs":1000,"totalTokens":500,"startedAt":"2024-06-01T00:00:00Z"}`,
			);

			const records = loadMetrics({ since: new Date("2024-03-01") });
			expect(records).toHaveLength(1);
			expect(records[0].taskId).toBe("t2");
		});

		it("should skip malformed lines", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				`{"taskId":"t1","objective":"Good","success":true,"durationMs":1000,"totalTokens":500}
not valid json
{"taskId":"t2","objective":"Also good","success":false,"durationMs":2000,"totalTokens":1000}`,
			);

			const records = loadMetrics();
			expect(records).toHaveLength(2);
		});
	});

	describe("analyzeMetrics", () => {
		it("should return empty analysis for no records", () => {
			const analysis = analyzeMetrics([]);
			expect(analysis.totalTasks).toBe(0);
			expect(analysis.overallSuccessRate).toBe(0);
		});

		it("should calculate overall success rate", () => {
			const records = [
				{
					taskId: "t1",
					objective: "Task 1",
					success: true,
					durationMs: 1000,
					totalTokens: 500,
					startedAt: new Date(),
					completedAt: new Date(),
				},
				{
					taskId: "t2",
					objective: "Task 2",
					success: true,
					durationMs: 1000,
					totalTokens: 500,
					startedAt: new Date(),
					completedAt: new Date(),
				},
				{
					taskId: "t3",
					objective: "Task 3",
					success: false,
					durationMs: 1000,
					totalTokens: 500,
					startedAt: new Date(),
					completedAt: new Date(),
				},
			];

			const analysis = analyzeMetrics(records);
			expect(analysis.totalTasks).toBe(3);
			expect(analysis.overallSuccessRate).toBeCloseTo(0.667, 2);
		});

		it("should group by model tier", () => {
			const records = [
				{
					taskId: "t1",
					objective: "Task 1",
					success: true,
					durationMs: 1000,
					totalTokens: 500,
					startedAt: new Date(),
					completedAt: new Date(),
					finalModel: "sonnet" as const,
				},
				{
					taskId: "t2",
					objective: "Task 2",
					success: false,
					durationMs: 2000,
					totalTokens: 1000,
					startedAt: new Date(),
					completedAt: new Date(),
					finalModel: "sonnet" as const,
				},
				{
					taskId: "t3",
					objective: "Task 3",
					success: true,
					durationMs: 1500,
					totalTokens: 750,
					startedAt: new Date(),
					completedAt: new Date(),
					finalModel: "sonnet" as const,
				},
			];

			const analysis = analyzeMetrics(records);
			expect(analysis.byModel.sonnet.total).toBe(2);
			expect(analysis.byModel.sonnet.successful).toBe(1);
			expect(analysis.byModel.sonnet.rate).toBe(0.5);
			expect(analysis.byModel.sonnet.total).toBe(1);
			expect(analysis.byModel.sonnet.rate).toBe(1);
		});

		it("should group by complexity", () => {
			const records = [
				{
					taskId: "t1",
					objective: "Task 1",
					success: true,
					durationMs: 1000,
					totalTokens: 500,
					startedAt: new Date(),
					completedAt: new Date(),
					complexityLevel: "simple" as const,
				},
				{
					taskId: "t2",
					objective: "Task 2",
					success: true,
					durationMs: 2000,
					totalTokens: 1000,
					startedAt: new Date(),
					completedAt: new Date(),
					complexityLevel: "complex" as const,
				},
			];

			const analysis = analyzeMetrics(records);
			expect(analysis.byComplexity.simple.total).toBe(1);
			expect(analysis.byComplexity.complex.total).toBe(1);
		});

		it("should track escalation stats", () => {
			const records = [
				{
					taskId: "t1",
					objective: "Task 1",
					success: true,
					durationMs: 1000,
					totalTokens: 500,
					startedAt: new Date(),
					completedAt: new Date(),
					wasEscalated: true,
					startingModel: "sonnet" as const,
					finalModel: "sonnet" as const,
				},
				{
					taskId: "t2",
					objective: "Task 2",
					success: false,
					durationMs: 2000,
					totalTokens: 1000,
					startedAt: new Date(),
					completedAt: new Date(),
					wasEscalated: true,
					startingModel: "sonnet" as const,
					finalModel: "opus" as const,
				},
				{
					taskId: "t3",
					objective: "Task 3",
					success: true,
					durationMs: 1500,
					totalTokens: 750,
					startedAt: new Date(),
					completedAt: new Date(),
					wasEscalated: false,
				},
			];

			const analysis = analyzeMetrics(records);
			expect(analysis.escalation.totalEscalated).toBe(2);
			expect(analysis.escalation.successAfterEscalation).toBe(1);
			expect(analysis.escalation.escalationRate).toBeCloseTo(0.667, 2);
			expect(analysis.escalation.byPath["haiku->sonnet"]).toBeDefined();
			expect(analysis.escalation.byPath["haiku->sonnet"].count).toBe(1);
		});

		it("should generate recommendations for low success rates", () => {
			const records = Array(10)
				.fill(null)
				.map((_, i) => ({
					taskId: `t${i}`,
					objective: `Task ${i}`,
					success: i < 3, // Only 30% success
					durationMs: 1000,
					totalTokens: 500,
					startedAt: new Date(),
					completedAt: new Date(),
					finalModel: "sonnet" as const,
				}));

			const analysis = analyzeMetrics(records);
			expect(analysis.recommendations.length).toBeGreaterThan(0);
			expect(analysis.recommendations.some((r) => r.includes("sonnet"))).toBe(true);
		});
	});

	describe("getSuccessRate", () => {
		it("should return success rate for model+complexity combo", () => {
			const analysis: MetricsAnalysis = {
				totalTasks: 10,
				overallSuccessRate: 0.8,
				byModel: {
					haiku: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					sonnet: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					opus: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
				},
				byComplexity: {
					trivial: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					simple: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					standard: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					complex: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					critical: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
				},
				byModelAndComplexity: {
					"sonnet:standard": { total: 5, successful: 4, failed: 1, rate: 0.8, avgDurationMs: 1000, avgTokens: 500 },
				},
				escalation: {
					totalEscalated: 0,
					escalationRate: 0,
					successAfterEscalation: 0,
					successRateAfterEscalation: 0,
					avgEscalationCost: 0,
					byPath: {},
				},
				errorPatterns: [],
				routingAccuracy: { correctTier: 0, needsEscalation: 0, overProvisioned: 0 },
				recommendations: [],
				analyzedAt: new Date(),
				oldestRecord: null,
				newestRecord: null,
			};

			const rate = getSuccessRate(analysis, "sonnet", "standard");
			expect(rate).toBe(0.8);
		});

		it("should return null if insufficient samples", () => {
			const analysis: MetricsAnalysis = {
				totalTasks: 2,
				overallSuccessRate: 0.5,
				byModel: {
					haiku: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					sonnet: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					opus: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
				},
				byComplexity: {
					trivial: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					simple: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					standard: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					complex: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					critical: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
				},
				byModelAndComplexity: {
					"haiku:simple": { total: 2, successful: 1, failed: 1, rate: 0.5, avgDurationMs: 1000, avgTokens: 500 },
				},
				escalation: {
					totalEscalated: 0,
					escalationRate: 0,
					successAfterEscalation: 0,
					successRateAfterEscalation: 0,
					avgEscalationCost: 0,
					byPath: {},
				},
				errorPatterns: [],
				routingAccuracy: { correctTier: 0, needsEscalation: 0, overProvisioned: 0 },
				recommendations: [],
				analyzedAt: new Date(),
				oldestRecord: null,
				newestRecord: null,
			};

			const rate = getSuccessRate(analysis, "sonnet", "simple", 3); // minSamples=3
			expect(rate).toBeNull();
		});
	});

	describe("suggestModelTier", () => {
		it("should suggest haiku if it meets threshold", () => {
			const analysis: MetricsAnalysis = {
				totalTasks: 20,
				overallSuccessRate: 0.8,
				byModel: {
					haiku: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					sonnet: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					opus: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
				},
				byComplexity: {
					trivial: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					simple: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					standard: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					complex: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					critical: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
				},
				byModelAndComplexity: {
					"haiku:simple": { total: 10, successful: 8, failed: 2, rate: 0.8, avgDurationMs: 1000, avgTokens: 500 },
				},
				escalation: {
					totalEscalated: 0,
					escalationRate: 0,
					successAfterEscalation: 0,
					successRateAfterEscalation: 0,
					avgEscalationCost: 0,
					byPath: {},
				},
				errorPatterns: [],
				routingAccuracy: { correctTier: 0, needsEscalation: 0, overProvisioned: 0 },
				recommendations: [],
				analyzedAt: new Date(),
				oldestRecord: null,
				newestRecord: null,
			};

			const tier = suggestModelTier(analysis, "simple");
			expect(tier).toBe("sonnet");
		});

		it("should fall back to opus if no tier meets threshold", () => {
			const analysis: MetricsAnalysis = {
				totalTasks: 20,
				overallSuccessRate: 0.4,
				byModel: {
					haiku: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					sonnet: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					opus: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
				},
				byComplexity: {
					trivial: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					simple: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					standard: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					complex: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					critical: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
				},
				byModelAndComplexity: {
					"haiku:complex": { total: 5, successful: 1, failed: 4, rate: 0.2, avgDurationMs: 1000, avgTokens: 500 },
					"sonnet:complex": { total: 5, successful: 2, failed: 3, rate: 0.4, avgDurationMs: 1500, avgTokens: 750 },
					"opus:complex": { total: 5, successful: 3, failed: 2, rate: 0.6, avgDurationMs: 2000, avgTokens: 1000 },
				},
				escalation: {
					totalEscalated: 0,
					escalationRate: 0,
					successAfterEscalation: 0,
					successRateAfterEscalation: 0,
					avgEscalationCost: 0,
					byPath: {},
				},
				errorPatterns: [],
				routingAccuracy: { correctTier: 0, needsEscalation: 0, overProvisioned: 0 },
				recommendations: [],
				analyzedAt: new Date(),
				oldestRecord: null,
				newestRecord: null,
			};

			const tier = suggestModelTier(analysis, "complex");
			expect(tier).toBe("opus");
		});
	});

	describe("analyzeTaskPatterns", () => {
		it("should return empty analysis for no records", () => {
			vi.mocked(existsSync).mockReturnValue(false);
			const analysis = analyzeTaskPatterns();
			expect(analysis.clusters).toEqual([]);
			expect(analysis.recommendations).toEqual([]);
		});

		it("should cluster tasks by keywords", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				`{"taskId":"t1","objective":"Fix authentication bug","success":true,"durationMs":1000,"totalTokens":500}
{"taskId":"t2","objective":"Fix login authentication","success":true,"durationMs":1200,"totalTokens":600}
{"taskId":"t3","objective":"Add user profile page","success":false,"durationMs":2000,"totalTokens":1000}`,
			);

			const analysis = analyzeTaskPatterns();

			// "authentication" appears in 2 tasks
			const authCluster = analysis.clusters.find((c) => c.keyword === "authentication");
			expect(authCluster).toBeDefined();
			expect(authCluster?.count).toBe(2);
			expect(authCluster?.successRate).toBe(1); // Both succeeded

			// "fix" appears in 2 tasks
			const fixCluster = analysis.clusters.find((c) => c.keyword === "fix");
			expect(fixCluster).toBeDefined();
			expect(fixCluster?.count).toBe(2);
		});

		it("should identify struggling patterns", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				`{"taskId":"t1","objective":"Refactor database module","success":false,"durationMs":1000,"totalTokens":500}
{"taskId":"t2","objective":"Refactor auth module","success":false,"durationMs":1200,"totalTokens":600}
{"taskId":"t3","objective":"Refactor cache module","success":false,"durationMs":1500,"totalTokens":700}
{"taskId":"t4","objective":"Add new feature","success":true,"durationMs":800,"totalTokens":400}`,
			);

			const analysis = analyzeTaskPatterns();

			// "refactor" tasks all failed
			expect(analysis.strugglingPatterns.some((p) => p.keyword === "refactor")).toBe(true);
			expect(analysis.recommendations.length).toBeGreaterThan(0);
		});

		it("should identify successful patterns", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				`{"taskId":"t1","objective":"Add button component","success":true,"durationMs":500,"totalTokens":250}
{"taskId":"t2","objective":"Add modal component","success":true,"durationMs":600,"totalTokens":300}
{"taskId":"t3","objective":"Add form component","success":true,"durationMs":550,"totalTokens":275}`,
			);

			const analysis = analyzeTaskPatterns();

			// "component" tasks all succeeded
			const componentPattern = analysis.topSuccessfulPatterns.find((p) => p.keyword === "component");
			expect(componentPattern).toBeDefined();
			expect(componentPattern?.successRate).toBe(1);
		});
	});

	describe("findSimilarTasks", () => {
		it("should find tasks with overlapping keywords", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				`{"taskId":"t1","objective":"Fix authentication bug in login","success":true,"durationMs":1000,"totalTokens":500,"finalModel":"sonnet"}
{"taskId":"t2","objective":"Add user profile page","success":false,"durationMs":2000,"totalTokens":1000,"finalModel":"opus"}
{"taskId":"t3","objective":"Fix authentication error handling","success":true,"durationMs":1200,"totalTokens":600,"finalModel":"sonnet"}`,
			);

			const similar = findSimilarTasks("Fix authentication issue");

			expect(similar.length).toBeGreaterThan(0);
			// t1 and t3 should be more similar (both have "fix" and "authentication")
			expect(similar[0].objective).toContain("authentication");
		});

		it("should return empty array for objectives with no keywords", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				`{"taskId":"t1","objective":"Fix bug","success":true,"durationMs":1000,"totalTokens":500}`,
			);

			const similar = findSimilarTasks("the and or"); // All stop words
			expect(similar).toEqual([]);
		});

		it("should include success status and model in results", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				`{"taskId":"t1","objective":"Implement caching layer","success":true,"durationMs":1000,"totalTokens":500,"finalModel":"sonnet"}`,
			);

			const similar = findSimilarTasks("Add caching to API");

			if (similar.length > 0) {
				expect(similar[0]).toHaveProperty("success");
				expect(similar[0]).toHaveProperty("model");
				expect(similar[0]).toHaveProperty("similarity");
			}
		});
	});

	describe("formatAnalysisSummary", () => {
		it("should format analysis as human-readable text", () => {
			const analysis: MetricsAnalysis = {
				totalTasks: 10,
				overallSuccessRate: 0.8,
				byModel: {
					haiku: { total: 5, successful: 4, failed: 1, rate: 0.8, avgDurationMs: 1000, avgTokens: 500 },
					sonnet: { total: 3, successful: 3, failed: 0, rate: 1, avgDurationMs: 1500, avgTokens: 750 },
					opus: { total: 2, successful: 1, failed: 1, rate: 0.5, avgDurationMs: 2000, avgTokens: 1000 },
				},
				byComplexity: {
					trivial: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
					simple: { total: 5, successful: 4, failed: 1, rate: 0.8, avgDurationMs: 1000, avgTokens: 500 },
					standard: { total: 3, successful: 3, failed: 0, rate: 1, avgDurationMs: 1500, avgTokens: 750 },
					complex: { total: 2, successful: 1, failed: 1, rate: 0.5, avgDurationMs: 2000, avgTokens: 1000 },
					critical: { total: 0, successful: 0, failed: 0, rate: 0, avgDurationMs: 0, avgTokens: 0 },
				},
				byModelAndComplexity: {},
				escalation: {
					totalEscalated: 2,
					escalationRate: 0.2,
					successAfterEscalation: 1,
					successRateAfterEscalation: 0.5,
					avgEscalationCost: 500,
					byPath: {},
				},
				errorPatterns: [{ category: "typecheck", count: 3, percentage: 0.5 }],
				routingAccuracy: { correctTier: 8, needsEscalation: 2, overProvisioned: 0 },
				recommendations: ["Consider using sonnet for complex tasks"],
				analyzedAt: new Date(),
				oldestRecord: new Date("2024-01-01"),
				newestRecord: new Date("2024-01-31"),
			};

			const summary = formatAnalysisSummary(analysis);

			expect(summary).toContain("Metrics Analysis (10 tasks)");
			expect(summary).toContain("80.0%");
			expect(summary).toContain("sonnet");
			expect(summary).toContain("sonnet");
			expect(summary).toContain("Escalation");
			expect(summary).toContain("typecheck");
		});
	});

	describe("formatPatternSummary", () => {
		it("should format pattern analysis as human-readable text", () => {
			const analysis = {
				clusters: [
					{
						keyword: "fix",
						count: 10,
						successCount: 8,
						failCount: 2,
						successRate: 0.8,
						avgDurationMs: 1000,
						avgTokens: 500,
						examples: ["Fix bug"],
					},
					{
						keyword: "add",
						count: 5,
						successCount: 5,
						failCount: 0,
						successRate: 1,
						avgDurationMs: 800,
						avgTokens: 400,
						examples: ["Add feature"],
					},
				],
				topSuccessfulPatterns: [
					{
						keyword: "add",
						count: 5,
						successCount: 5,
						failCount: 0,
						successRate: 1,
						avgDurationMs: 800,
						avgTokens: 400,
						examples: ["Add feature"],
					},
				],
				strugglingPatterns: [],
				recommendations: ["add tasks succeed 100% - good for haiku"],
			};

			const summary = formatPatternSummary(analysis);

			expect(summary).toContain("Task Pattern Analysis");
			expect(summary).toContain("fix");
			expect(summary).toContain("add");
			expect(summary).toContain("High-Success Patterns");
		});

		it("should handle empty clusters", () => {
			const analysis = {
				clusters: [],
				topSuccessfulPatterns: [],
				strugglingPatterns: [],
				recommendations: [],
			};

			const summary = formatPatternSummary(analysis);
			expect(summary).toContain("No patterns detected");
		});
	});
});
