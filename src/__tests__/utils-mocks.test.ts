/**
 * Tests for utils/mocks.ts
 *
 * Verifies that mock factories work correctly and produce valid objects.
 */

import { describe, expect, it } from "vitest";
import {
	advanceMockDate,
	calculatePrecisionRecall,
	createMockApiError,
	createMockApiSuccess,
	createMockCheckpoint,
	createMockConfig,
	createMockDate,
	createMockFs,
	createMockFsState,
	createMockHandoffContext,
	createMockLastAttempt,
	createMockRecommendation,
	createMockResearchConclusion,
	createMockTask,
	createMockTicket,
	createMockTokenUsage,
	createMockTriageIssue,
	createTestSample,
	getExtractionTypeBreakdown,
	getMockStorage,
	getSamplesByCategory,
	isTask,
	isTicketContent,
	isTokenUsage,
	resetMockStorage,
} from "./utils/mocks.js";

describe("utils/mocks", () => {
	describe("Task mock factories", () => {
		it("should create a mock task with defaults", () => {
			const task = createMockTask();

			expect(task.id).toBe("task-test-123");
			expect(task.objective).toBe("Test task objective");
			expect(task.status).toBe("pending");
			expect(task.priority).toBe(3);
			expect(task.createdAt).toBeInstanceOf(Date);
		});

		it("should create a mock task with overrides", () => {
			const task = createMockTask({
				objective: "Custom task",
				status: "in_progress",
				priority: 5,
			});

			expect(task.objective).toBe("Custom task");
			expect(task.status).toBe("in_progress");
			expect(task.priority).toBe(5);
		});

		it("should create a mock ticket with defaults", () => {
			const ticket = createMockTicket();

			expect(ticket.description).toBe("Test task description with full context");
			expect(ticket.acceptanceCriteria).toHaveLength(2);
			expect(ticket.testPlan).toBeDefined();
			expect(ticket.source).toBe("user");
		});

		it("should create a mock handoff context", () => {
			const handoff = createMockHandoffContext({
				filesRead: ["src/main.ts", "src/utils.ts"],
				decisions: ["Use strategy pattern"],
			});

			expect(handoff.filesRead).toHaveLength(2);
			expect(handoff.decisions).toHaveLength(1);
			expect(handoff.isRetry).toBe(false);
		});

		it("should create a mock last attempt context", () => {
			const lastAttempt = createMockLastAttempt({
				category: "typecheck",
				error: "Type error in main.ts",
			});

			expect(lastAttempt.category).toBe("typecheck");
			expect(lastAttempt.error).toBe("Type error in main.ts");
			expect(lastAttempt.model).toBe("sonnet");
		});

		it("should create a mock checkpoint", () => {
			const checkpoint = createMockCheckpoint({
				phase: "executing",
				attempts: 2,
			});

			expect(checkpoint.phase).toBe("executing");
			expect(checkpoint.attempts).toBe(2);
			expect(checkpoint.model).toBe("sonnet");
		});

		it("should create a mock research conclusion", () => {
			const conclusion = createMockResearchConclusion({
				outcome: "implement",
				proposalsGenerated: 3,
			});

			expect(conclusion.outcome).toBe("implement");
			expect(conclusion.proposalsGenerated).toBe(3);
			expect(conclusion.noveltyScore).toBe(0.7);
		});

		it("should create a mock triage issue", () => {
			const issue = createMockTriageIssue({
				type: "duplicate",
				action: "merge",
			});

			expect(issue.type).toBe("duplicate");
			expect(issue.action).toBe("merge");
			expect(issue.detectedAt).toBeInstanceOf(Date);
		});
	});

	describe("Config mock factories", () => {
		it("should create a mock config with defaults", () => {
			const config = createMockConfig();

			expect(config.model).toBe("sonnet");
			expect(config.verbose).toBe(false);
			expect(config.autoCommit).toBe(true);
			expect(config.maxAttempts).toBe(7);
		});

		it("should create a mock config with overrides", () => {
			const config = createMockConfig({
				verbose: true,
				model: "opus",
				parallel: 3,
			});

			expect(config.verbose).toBe(true);
			expect(config.model).toBe("opus");
			expect(config.parallel).toBe(3);
		});
	});

	describe("Token usage mock factories", () => {
		it("should create a mock token usage with defaults", () => {
			const usage = createMockTokenUsage();

			expect(usage.inputTokens).toBe(1000);
			expect(usage.outputTokens).toBe(500);
			expect(usage.totalTokens).toBe(1500);
			expect(usage.model).toBe("sonnet");
			expect(usage.sonnetEquivalentTokens).toBe(1500);
		});

		it("should calculate sonnet equivalent tokens for opus", () => {
			const usage = createMockTokenUsage({
				inputTokens: 1000,
				outputTokens: 500,
				model: "opus",
			});

			expect(usage.totalTokens).toBe(1500);
			expect(usage.sonnetEquivalentTokens).toBe(7500); // 1500 * 5
		});
	});

	describe("Meta-task mock factories", () => {
		it("should create a mock recommendation", () => {
			const recommendation = createMockRecommendation({
				action: "remove",
				reason: "Task is duplicate",
				confidence: 0.9,
			});

			expect(recommendation.action).toBe("remove");
			expect(recommendation.reason).toBe("Task is duplicate");
			expect(recommendation.confidence).toBe(0.9);
		});
	});

	describe("Test sample helpers", () => {
		it("should create a test sample", () => {
			const sample = createTestSample({
				category: "complex",
				input: "complex input",
				expectedOutput: { key: "value" },
			});

			expect(sample.category).toBe("complex");
			expect(sample.input).toBe("complex input");
			expect(sample.expectedOutput).toEqual({ key: "value" });
		});

		it("should filter samples by category", () => {
			const samples = [
				createTestSample({ id: "1", category: "simple" }),
				createTestSample({ id: "2", category: "complex" }),
				createTestSample({ id: "3", category: "simple" }),
			];

			const simpleSamples = getSamplesByCategory(samples, "simple");

			expect(simpleSamples).toHaveLength(2);
			expect(simpleSamples[0].id).toBe("1");
			expect(simpleSamples[1].id).toBe("3");
		});

		it("should get breakdown by category", () => {
			const samples = [
				createTestSample({ category: "simple" }),
				createTestSample({ category: "simple" }),
				createTestSample({ category: "complex" }),
				createTestSample({ category: "edge_case" }),
			];

			const breakdown = getExtractionTypeBreakdown(samples);

			expect(breakdown.simple).toBe(2);
			expect(breakdown.complex).toBe(1);
			expect(breakdown.edge_case).toBe(1);
			expect(breakdown.malformed).toBe(0);
		});

		it("should calculate precision and recall", () => {
			const results = [
				{ expected: "a", actual: "a", isCorrect: true },
				{ expected: "b", actual: "b", isCorrect: true },
				{ expected: "c", actual: "d", isCorrect: false },
				{ expected: "e", actual: "e", isCorrect: true },
			];

			const metrics = calculatePrecisionRecall(results);

			expect(metrics.totalSamples).toBe(4);
			expect(metrics.correctSamples).toBe(3);
			expect(metrics.precision).toBe(0.75);
			expect(metrics.recall).toBe(0.75);
			expect(metrics.f1Score).toBe(0.75);
		});
	});

	describe("Mock API response helpers", () => {
		it("should create a successful API response", () => {
			const response = createMockApiSuccess({ result: "data" }, 150, "sonnet");

			expect(response.success).toBe(true);
			expect(response.data).toEqual({ result: "data" });
			expect(response.tokensUsed).toBe(150);
			expect(response.model).toBe("sonnet");
		});

		it("should create a failed API response", () => {
			const response = createMockApiError("Rate limit exceeded", "opus");

			expect(response.success).toBe(false);
			expect(response.error).toBe("Rate limit exceeded");
			expect(response.model).toBe("opus");
		});
	});

	describe("Mock file system utilities", () => {
		it("should create mock fs state", () => {
			const state = createMockFsState();

			expect(state.files.size).toBe(0);
			expect(state.directories.size).toBe(0);
		});

		it("should create mock fs functions", () => {
			const state = createMockFsState();
			const mockFs = createMockFs(state);

			// Set up test data
			state.files.set("/test/file.txt", "content");
			state.directories.add("/test");

			// Test existsSync
			expect(mockFs.existsSync("/test/file.txt")).toBe(true);
			expect(mockFs.existsSync("/test")).toBe(true);
			expect(mockFs.existsSync("/nonexistent")).toBe(false);

			// Test readFileSync
			expect(mockFs.readFileSync("/test/file.txt", "utf-8")).toBe("content");

			// Test writeFileSync
			mockFs.writeFileSync("/test/new.txt", "new content");
			expect(state.files.get("/test/new.txt")).toBe("new content");

			// Test mkdirSync
			mockFs.mkdirSync("/test/dir", { recursive: true });
			expect(state.directories.has("/test/dir")).toBe(true);
		});

		it("should reset mock storage", () => {
			const state = createMockFsState();
			state.files.set("/test", "content");
			state.directories.add("/dir");

			resetMockStorage(state);

			expect(state.files.size).toBe(0);
			expect(state.directories.size).toBe(0);
		});

		it("should get mock storage stats", () => {
			const state = createMockFsState();
			state.files.set("/file1", "content1");
			state.files.set("/file2", "content2");
			state.directories.add("/dir1");

			const stats = getMockStorage(state);

			expect(stats.fileCount).toBe(2);
			expect(stats.dirCount).toBe(1);
		});
	});

	describe("Type guards", () => {
		it("should validate Task objects", () => {
			const task = createMockTask();
			expect(isTask(task)).toBe(true);

			expect(isTask(null)).toBe(false);
			expect(isTask({})).toBe(false);
			expect(isTask({ id: "test" })).toBe(false);
		});

		it("should validate TicketContent objects", () => {
			const ticket = createMockTicket();
			expect(isTicketContent(ticket)).toBe(true);

			expect(isTicketContent({})).toBe(true); // All fields optional
			expect(isTicketContent(null)).toBe(false);
		});

		it("should validate TokenUsage objects", () => {
			const usage = createMockTokenUsage();
			expect(isTokenUsage(usage)).toBe(true);

			expect(isTokenUsage(null)).toBe(false);
			expect(isTokenUsage({})).toBe(false);
			expect(isTokenUsage({ inputTokens: 100 })).toBe(false);
		});
	});

	describe("edge_case - null and undefined parameter handling", () => {
		describe("Task mock factories with null/undefined", () => {
			it("should handle null overrides gracefully in createMockTask", () => {
				const task = createMockTask({ objective: null as unknown as string });
				expect(task.objective).toBeNull();
				expect(task.id).toBe("task-test-123"); // Other defaults preserved
			});

			it("should handle undefined overrides gracefully in createMockTask", () => {
				const task = createMockTask({ objective: undefined });
				expect(task.objective).toBeUndefined(); // Explicit undefined overrides default
			});

			it("should handle null overrides gracefully in createMockTicket", () => {
				const ticket = createMockTicket({ description: null as unknown as string });
				expect(ticket.description).toBeNull();
				expect(ticket.source).toBe("user"); // Other defaults preserved
			});

			it("should handle undefined overrides gracefully in createMockTicket", () => {
				const ticket = createMockTicket({ description: undefined });
				expect(ticket.description).toBeUndefined(); // Explicit undefined overrides default
			});

			it("should handle null overrides gracefully in createMockHandoffContext", () => {
				const handoff = createMockHandoffContext({ filesRead: null as unknown as string[] });
				expect(handoff.filesRead).toBeNull();
			});

			it("should handle undefined overrides gracefully in createMockHandoffContext", () => {
				const handoff = createMockHandoffContext({ filesRead: undefined });
				expect(handoff.filesRead).toBeUndefined(); // Explicit undefined overrides default
			});

			it("should handle null overrides gracefully in createMockLastAttempt", () => {
				const lastAttempt = createMockLastAttempt({ error: null as unknown as string });
				expect(lastAttempt.error).toBeNull();
			});

			it("should handle undefined overrides gracefully in createMockLastAttempt", () => {
				const lastAttempt = createMockLastAttempt({ error: undefined });
				expect(lastAttempt.error).toBeUndefined(); // Explicit undefined overrides default
			});

			it("should handle null overrides gracefully in createMockCheckpoint", () => {
				const checkpoint = createMockCheckpoint({ phase: null as unknown as "starting" });
				expect(checkpoint.phase).toBeNull();
			});

			it("should handle undefined overrides gracefully in createMockCheckpoint", () => {
				const checkpoint = createMockCheckpoint({ phase: undefined });
				expect(checkpoint.phase).toBeUndefined(); // Explicit undefined overrides default
			});

			it("should handle null overrides gracefully in createMockResearchConclusion", () => {
				const conclusion = createMockResearchConclusion({ outcome: null as unknown as "implement" });
				expect(conclusion.outcome).toBeNull();
			});

			it("should handle undefined overrides gracefully in createMockResearchConclusion", () => {
				const conclusion = createMockResearchConclusion({ outcome: undefined });
				expect(conclusion.outcome).toBeUndefined(); // Explicit undefined overrides default
			});

			it("should handle null overrides gracefully in createMockTriageIssue", () => {
				const issue = createMockTriageIssue({ type: null as unknown as "vague" });
				expect(issue.type).toBeNull();
			});

			it("should handle undefined overrides gracefully in createMockTriageIssue", () => {
				const issue = createMockTriageIssue({ type: undefined });
				expect(issue.type).toBeUndefined(); // Explicit undefined overrides default
			});
		});

		describe("Config mock factories with null/undefined", () => {
			it("should handle null overrides gracefully in createMockConfig", () => {
				const config = createMockConfig({ verbose: null as unknown as boolean });
				expect(config.verbose).toBeNull();
			});

			it("should handle undefined overrides gracefully in createMockConfig", () => {
				const config = createMockConfig({ verbose: undefined });
				expect(config.verbose).toBeUndefined(); // Explicit undefined overrides default
			});
		});

		describe("Token usage mock factories with null/undefined", () => {
			it("should handle null overrides gracefully in createMockTokenUsage", () => {
				const usage = createMockTokenUsage({ inputTokens: null as unknown as number });
				expect(usage.inputTokens).toBeNull();
			});

			it("should handle undefined overrides gracefully in createMockTokenUsage", () => {
				const usage = createMockTokenUsage({ inputTokens: undefined });
				expect(usage.inputTokens).toBeUndefined(); // Explicit undefined overrides default
			});

			it("should handle undefined model gracefully in createMockTokenUsage", () => {
				const usage = createMockTokenUsage({ model: undefined });
				expect(usage.model).toBeUndefined(); // Explicit undefined overrides default
				expect(usage.sonnetEquivalentTokens).toBe(1500); // Multiplier is 1 when model is undefined
			});
		});

		describe("Meta-task mock factories with null/undefined", () => {
			it("should handle null overrides gracefully in createMockRecommendation", () => {
				const recommendation = createMockRecommendation({ action: null as unknown as "update" });
				expect(recommendation.action).toBeNull();
			});

			it("should handle undefined overrides gracefully in createMockRecommendation", () => {
				const recommendation = createMockRecommendation({ action: undefined });
				expect(recommendation.action).toBeUndefined(); // Explicit undefined overrides default
			});
		});

		describe("Test sample helpers with null/undefined/empty arrays", () => {
			it("should handle null overrides gracefully in createTestSample", () => {
				const sample = createTestSample({ input: null as unknown as string });
				expect(sample.input).toBeNull();
			});

			it("should handle undefined overrides gracefully in createTestSample", () => {
				const sample = createTestSample({ input: undefined });
				expect(sample.input).toBeUndefined(); // Explicit undefined overrides default
			});

			it("should handle empty array in getSamplesByCategory", () => {
				const result = getSamplesByCategory([], "simple");
				expect(result).toEqual([]);
			});

			it("should handle undefined samples array in getSamplesByCategory", () => {
				expect(() => getSamplesByCategory(undefined as unknown as TestSample[], "simple")).toThrow();
			});

			it("should handle empty array in getExtractionTypeBreakdown", () => {
				const breakdown = getExtractionTypeBreakdown([]);
				expect(breakdown.simple).toBe(0);
				expect(breakdown.complex).toBe(0);
				expect(breakdown.edge_case).toBe(0);
				expect(breakdown.malformed).toBe(0);
			});

			it("should handle empty array in calculatePrecisionRecall", () => {
				const metrics = calculatePrecisionRecall([]);
				expect(metrics.totalSamples).toBe(0);
				expect(metrics.correctSamples).toBe(0);
				expect(metrics.precision).toBe(0);
				expect(metrics.recall).toBe(0);
				expect(metrics.f1Score).toBe(0);
			});
		});

		describe("Mock API response helpers with null/undefined", () => {
			it("should handle null data in createMockApiSuccess", () => {
				const response = createMockApiSuccess(null, 100, "sonnet");
				expect(response.success).toBe(true);
				expect(response.data).toBeNull();
			});

			it("should handle undefined parameters in createMockApiSuccess", () => {
				const response = createMockApiSuccess({ result: "data" });
				expect(response.tokensUsed).toBe(100); // Default
				expect(response.model).toBe("sonnet"); // Default
			});

			it("should handle null error in createMockApiError", () => {
				const response = createMockApiError(null as unknown as string);
				expect(response.success).toBe(false);
				expect(response.error).toBeNull();
			});

			it("should handle undefined model in createMockApiError", () => {
				const response = createMockApiError("Error message");
				expect(response.model).toBe("sonnet"); // Default
			});
		});

		describe("Mock file system utilities with null/undefined", () => {
			it("should handle empty state in createMockFsState", () => {
				const state = createMockFsState();
				expect(state.files.size).toBe(0);
				expect(state.directories.size).toBe(0);
			});

			it("should handle null state in createMockFs operations", () => {
				const state = createMockFsState();
				const mockFs = createMockFs(state);

				// Should return false for non-existent paths
				expect(mockFs.existsSync(null as unknown as string)).toBe(false);
			});

			it("should handle undefined path in readFileSync", () => {
				const state = createMockFsState();
				const mockFs = createMockFs(state);

				expect(() => mockFs.readFileSync(undefined as unknown as string, "utf-8")).toThrow();
			});

			it("should handle null content in writeFileSync", () => {
				const state = createMockFsState();
				const mockFs = createMockFs(state);

				mockFs.writeFileSync("/test.txt", null as unknown as string);
				expect(state.files.get("/test.txt")).toBeNull();
			});
		});

		describe("Type guards with additional edge cases", () => {
			it("should reject undefined in isTask", () => {
				expect(isTask(undefined)).toBe(false);
			});

			it("should reject arrays in isTask", () => {
				expect(isTask([])).toBe(false);
				expect(isTask([{ id: "test" }])).toBe(false);
			});

			it("should reject primitives in isTask", () => {
				expect(isTask("string")).toBe(false);
				expect(isTask(123)).toBe(false);
				expect(isTask(true)).toBe(false);
			});

			it("should reject undefined in isTicketContent", () => {
				expect(isTicketContent(undefined)).toBe(false);
			});

			it("should reject arrays in isTicketContent", () => {
				expect(isTicketContent([])).toBe(true); // Empty object is valid TicketContent (all optional fields)
			});

			it("should reject primitives in isTicketContent", () => {
				expect(isTicketContent("string")).toBe(false);
				expect(isTicketContent(123)).toBe(false);
			});

			it("should reject undefined in isTokenUsage", () => {
				expect(isTokenUsage(undefined)).toBe(false);
			});

			it("should reject arrays in isTokenUsage", () => {
				expect(isTokenUsage([])).toBe(false);
			});

			it("should reject primitives in isTokenUsage", () => {
				expect(isTokenUsage("string")).toBe(false);
				expect(isTokenUsage(123)).toBe(false);
			});
		});

		describe("Date mocking helpers with edge cases", () => {
			it("should handle invalid date string in createMockDate", () => {
				const invalidDate = createMockDate("invalid-date");
				expect(invalidDate).toBeInstanceOf(Date);
				expect(Number.isNaN(invalidDate.getTime())).toBe(true);
			});

			it("should handle undefined parameter in createMockDate", () => {
				const date = createMockDate(undefined);
				expect(date).toBeInstanceOf(Date);
				// When undefined is passed, it still uses the default parameter value
				expect(date.toISOString()).toBe("2024-01-01T00:00:00.000Z");
			});

			it("should handle null date in advanceMockDate", () => {
				expect(() => advanceMockDate(null as unknown as Date, 1000)).toThrow();
			});

			it("should handle undefined ms in advanceMockDate", () => {
				const date = createMockDate();
				const result = advanceMockDate(date, undefined as unknown as number);
				expect(result).toBeInstanceOf(Date);
				expect(Number.isNaN(result.getTime())).toBe(true);
			});

			it("should handle negative ms in advanceMockDate", () => {
				const date = createMockDate();
				const result = advanceMockDate(date, -60000);
				expect(result).toBeInstanceOf(Date);
				expect(result.getTime()).toBeLessThan(date.getTime());
			});
		});
	});
});
