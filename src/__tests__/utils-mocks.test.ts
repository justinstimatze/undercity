/**
 * Tests for utils/mocks.ts
 *
 * Verifies that mock factories work correctly and produce valid objects.
 */

import { describe, expect, it } from "vitest";
import {
	calculatePrecisionRecall,
	createMockApiError,
	createMockApiSuccess,
	createMockCheckpoint,
	createMockConfig,
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
});
