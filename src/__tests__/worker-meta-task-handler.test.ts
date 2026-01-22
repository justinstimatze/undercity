/**
 * Tests for worker/meta-task-handler.ts
 *
 * Tests meta-task and research task handling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetaTaskType } from "../types.js";
import {
	handleMetaTaskResult,
	handleResearchTaskResult,
	type MetaTaskDependencies,
} from "../worker/meta-task-handler.js";
import type { TaskExecutionState, TaskIdentity } from "../worker/state.js";

// Mock the logger
vi.mock("../logger.js", () => {
	const mockLogger: Record<string, unknown> = {
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
		child: vi.fn(() => mockLogger),
	};
	return { sessionLogger: mockLogger };
});

// Mock output module
vi.mock("../output.js", () => ({
	workerVerification: vi.fn(),
	workerPhase: vi.fn(),
	warning: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
}));

// Mock meta-tasks module
vi.mock("../meta-tasks.js", () => ({
	parseMetaTaskResult: vi.fn(),
}));

// Mock task-schema
vi.mock("../task-schema.js", () => ({
	parseResearchResult: vi.fn(() => null),
}));

describe("worker/meta-task-handler", () => {
	const createIdentity = (overrides: Partial<TaskIdentity> = {}): TaskIdentity => ({
		taskId: "test-task-123",
		sessionId: "session-456",
		task: "[meta:triage] Analyze task board",
		baseCommit: "abc123",
		isMetaTask: true,
		isResearchTask: false,
		metaType: "triage",
		...overrides,
	});

	const createState = (overrides: Partial<TaskExecutionState> = {}): TaskExecutionState => ({
		attempts: 1,
		currentModel: "sonnet",
		sameModelRetries: 0,
		attemptRecords: [],
		tokenUsage: [],
		writeCountThisExecution: 0,
		phase: { phase: "executing", model: "sonnet", attempt: 1, startedAt: Date.now() },
		lastAgentOutput: "",
		lastAgentTurns: 0,
		currentAgentSessionId: undefined,
		lastFeedback: undefined,
		writesPerFile: new Map(),
		noOpEditCount: 0,
		consecutiveNoWriteAttempts: 0,
		errorHistory: [],
		lastErrorCategory: null,
		lastErrorMessage: null,
		lastDetailedErrors: [],
		pendingErrorSignature: null,
		filesBeforeAttempt: [],
		autoRemediationAttempted: false,
		taskAlreadyCompleteReason: null,
		invalidTargetReason: null,
		needsDecompositionReason: null,
		pendingTickets: [],
		currentBriefing: undefined,
		executionPlan: null,
		injectedLearningIds: [],
		currentHandoffContext: undefined,
		complexityAssessment: null,
		reviewTriageResult: null,
		...overrides,
	});

	const createDeps = (): MetaTaskDependencies => ({
		commitWork: vi.fn(async () => undefined),
		recordMetricsAttempts: vi.fn(),
		completeMetricsTask: vi.fn(),
	});

	const createConfig = () => ({
		maxAttempts: 5,
		maxRetriesPerTier: 3,
		maxOpusRetries: 7,
		startingModel: "sonnet" as const,
		maxTier: "opus" as const,
		runTypecheck: true,
		runTests: true,
		skipOptionalVerification: false,
		reviewPasses: true,
		maxReviewPassesPerTier: 2,
		maxOpusReviewPasses: 3,
		multiLensAtOpus: false,
		autoCommit: true,
		stream: false,
		verbose: false,
		enablePlanning: true,
		auditBash: false,
		useSystemPromptPreset: false,
		workingDirectory: "/test",
		stateDir: ".undercity",
		branch: undefined,
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("handleMetaTaskResult", () => {
		it("returns done:false when parsing fails", async () => {
			const { parseMetaTaskResult } = await import("../meta-tasks.js");
			vi.mocked(parseMetaTaskResult).mockReturnValue(null);

			const identity = createIdentity();
			const state = createState();
			const deps = createDeps();
			const metaType: MetaTaskType = "triage";

			const result = handleMetaTaskResult(identity, state, "invalid output", metaType, Date.now(), deps);

			expect(result.done).toBe(false);
			if (!result.done) {
				expect(result.feedback).toContain("could not be parsed");
				expect(result.feedback).toContain("recommendations");
			}
		});

		it("returns done:true with result when parsing succeeds", async () => {
			const { parseMetaTaskResult } = await import("../meta-tasks.js");
			vi.mocked(parseMetaTaskResult).mockReturnValue({
				recommendations: [
					{ action: "add", objective: "Task 1", priority: 3 },
					{ action: "add", objective: "Task 2", priority: 5 },
				],
			});

			const identity = createIdentity();
			const state = createState({ attempts: 2 });
			const deps = createDeps();
			const metaType: MetaTaskType = "triage";

			const result = handleMetaTaskResult(identity, state, '{"recommendations": [...]}', metaType, Date.now(), deps);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result.status).toBe("complete");
				expect(result.result.task).toBe(identity.task);
				expect(result.result.model).toBe(state.currentModel);
				expect(result.result.metaTaskResult).toBeDefined();
				expect(result.result.metaTaskResult?.recommendations).toHaveLength(2);
			}
		});

		it("records attempt on success", async () => {
			const { parseMetaTaskResult } = await import("../meta-tasks.js");
			vi.mocked(parseMetaTaskResult).mockReturnValue({
				recommendations: [],
			});

			const identity = createIdentity();
			const state = createState({ attemptRecords: [] });
			const deps = createDeps();
			const metaType: MetaTaskType = "triage";

			handleMetaTaskResult(identity, state, "{}", metaType, Date.now(), deps);

			expect(state.attemptRecords).toHaveLength(1);
			expect(state.attemptRecords[0].success).toBe(true);
		});

		it("calls metrics dependencies on success", async () => {
			const { parseMetaTaskResult } = await import("../meta-tasks.js");
			vi.mocked(parseMetaTaskResult).mockReturnValue({
				recommendations: [],
			});

			const identity = createIdentity();
			const state = createState();
			const deps = createDeps();
			const metaType: MetaTaskType = "prune";

			handleMetaTaskResult(identity, state, "{}", metaType, Date.now(), deps);

			expect(deps.recordMetricsAttempts).toHaveBeenCalledWith(state.attemptRecords);
			expect(deps.completeMetricsTask).toHaveBeenCalledWith(true);
		});

		it("does not call metrics on failure", async () => {
			const { parseMetaTaskResult } = await import("../meta-tasks.js");
			vi.mocked(parseMetaTaskResult).mockReturnValue(null);

			const identity = createIdentity();
			const state = createState();
			const deps = createDeps();
			const metaType: MetaTaskType = "triage";

			handleMetaTaskResult(identity, state, "bad output", metaType, Date.now(), deps);

			expect(deps.recordMetricsAttempts).not.toHaveBeenCalled();
			expect(deps.completeMetricsTask).not.toHaveBeenCalled();
		});
	});

	describe("handleResearchTaskResult", () => {
		it("returns done:false when no file was written", async () => {
			const identity = createIdentity({
				task: "[research] Investigate API patterns",
				isMetaTask: false,
				isResearchTask: true,
			});
			const state = createState({ writeCountThisExecution: 0 });
			const config = createConfig();
			const deps = createDeps();

			const result = await handleResearchTaskResult(identity, state, config, "output", Date.now(), deps);

			expect(result.done).toBe(false);
			if (!result.done) {
				expect(result.feedback).toContain("must write");
				expect(result.feedback).toContain("findings");
			}
		});

		it("returns done:true when file was written", async () => {
			const identity = createIdentity({
				task: "[research] Investigate API patterns",
				isMetaTask: false,
				isResearchTask: true,
			});
			const state = createState({ writeCountThisExecution: 1 });
			const config = createConfig();
			const deps = createDeps();

			const result = await handleResearchTaskResult(identity, state, config, "output", Date.now(), deps);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result.status).toBe("complete");
			}
		});

		it("records attempt on success", async () => {
			const identity = createIdentity({
				task: "[research] Research topic",
				isResearchTask: true,
			});
			const state = createState({
				writeCountThisExecution: 1,
				attemptRecords: [],
			});
			const config = createConfig();
			const deps = createDeps();

			await handleResearchTaskResult(identity, state, config, "output", Date.now(), deps);

			expect(state.attemptRecords).toHaveLength(1);
			expect(state.attemptRecords[0].success).toBe(true);
		});

		it("commits work when autoCommit enabled", async () => {
			const identity = createIdentity({
				task: "[research] Research topic",
				isResearchTask: true,
			});
			const state = createState({ writeCountThisExecution: 1 });
			const config = createConfig();
			const deps = createDeps();

			await handleResearchTaskResult(identity, state, config, "output", Date.now(), deps);

			expect(deps.commitWork).toHaveBeenCalledWith(identity.task);
		});

		it("does not commit when autoCommit disabled", async () => {
			const identity = createIdentity({
				task: "[research] Research topic",
				isResearchTask: true,
			});
			const state = createState({ writeCountThisExecution: 1 });
			const config = { ...createConfig(), autoCommit: false };
			const deps = createDeps();

			await handleResearchTaskResult(identity, state, config, "output", Date.now(), deps);

			expect(deps.commitWork).not.toHaveBeenCalled();
		});

		it("calls metrics dependencies on success", async () => {
			const identity = createIdentity({
				task: "[research] Research topic",
				isResearchTask: true,
			});
			const state = createState({ writeCountThisExecution: 1 });
			const config = createConfig();
			const deps = createDeps();

			await handleResearchTaskResult(identity, state, config, "output", Date.now(), deps);

			expect(deps.recordMetricsAttempts).toHaveBeenCalledWith(state.attemptRecords);
			expect(deps.completeMetricsTask).toHaveBeenCalledWith(true);
		});

		it("does not call metrics on failure", async () => {
			const identity = createIdentity({
				task: "[research] Research topic",
				isResearchTask: true,
			});
			const state = createState({ writeCountThisExecution: 0 });
			const config = createConfig();
			const deps = createDeps();

			await handleResearchTaskResult(identity, state, config, "output", Date.now(), deps);

			expect(deps.recordMetricsAttempts).not.toHaveBeenCalled();
			expect(deps.completeMetricsTask).not.toHaveBeenCalled();
		});

		it("includes researchResult in result when parsed", async () => {
			const { parseResearchResult } = await import("../task-schema.js");
			vi.mocked(parseResearchResult).mockReturnValue({
				summary: "Research summary",
				findings: [{ finding: "Found X", confidence: 0.9, category: "fact" }],
				nextSteps: ["Do Y"],
				sources: ["source1.ts"],
			});

			const identity = createIdentity({
				task: "[research] Research topic",
				isResearchTask: true,
			});
			const state = createState({ writeCountThisExecution: 1 });
			const config = createConfig();
			const deps = createDeps();

			const result = await handleResearchTaskResult(identity, state, config, "output", Date.now(), deps);

			expect(result.done).toBe(true);
			if (result.done) {
				expect(result.result.researchResult).toBeDefined();
				expect(result.result.researchResult?.summary).toBe("Research summary");
			}
		});
	});
});
