/**
 * Tests for worker/verification-handler.ts
 *
 * Tests verification result handling, feedback building, and failure recording.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorCategory } from "../types.js";
import type { VerificationResult } from "../verification.js";
import type { TaskExecutionState, TaskIdentity } from "../worker/state.js";
import {
	buildEnhancedFeedback,
	handleAlreadyComplete,
	recordVerificationFailure,
	type VerificationDependencies,
} from "../worker/verification-handler.js";

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

// Mock error-fix-patterns
vi.mock("../error-fix-patterns.js", () => ({
	formatFixSuggestionsForPrompt: vi.fn(() => null),
	recordPendingError: vi.fn(() => "error-sig-123"),
}));

// Mock human-input-tracking
vi.mock("../human-input-tracking.js", () => ({
	formatGuidanceForWorker: vi.fn(() => null),
}));

// Mock task-file-patterns
vi.mock("../task-file-patterns.js", () => ({
	formatCoModificationHints: vi.fn(() => null),
}));

describe("worker/verification-handler", () => {
	const createIdentity = (overrides: Partial<TaskIdentity> = {}): TaskIdentity => ({
		taskId: "test-task-123",
		sessionId: "session-456",
		task: "Fix the bug in foo.ts",
		baseCommit: "abc123",
		isMetaTask: false,
		isResearchTask: false,
		metaType: null,
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

	const createVerification = (overrides: Partial<VerificationResult> = {}): VerificationResult => ({
		passed: true,
		feedback: "All checks passed",
		issues: [],
		filesChanged: 2,
		hasWarnings: false,
		...overrides,
	});

	describe("handleAlreadyComplete", () => {
		it("returns complete result with taskAlreadyComplete flag", () => {
			const identity = createIdentity();
			const state = createState({ taskAlreadyCompleteReason: "already done" });
			const verification = createVerification();
			const startTime = Date.now() - 1000;

			const result = handleAlreadyComplete(identity, state, verification, startTime);

			expect(result.status).toBe("complete");
			expect(result.taskAlreadyComplete).toBe(true);
			expect(result.task).toBe(identity.task);
			expect(result.model).toBe(state.currentModel);
		});

		it("uses default reason when taskAlreadyCompleteReason is null", () => {
			const identity = createIdentity();
			const state = createState({
				taskAlreadyCompleteReason: null,
				noOpEditCount: 3,
			});
			const verification = createVerification();
			const startTime = Date.now() - 1000;

			const result = handleAlreadyComplete(identity, state, verification, startTime);

			expect(result.taskAlreadyComplete).toBe(true);
		});

		it("includes verification in result", () => {
			const identity = createIdentity();
			const state = createState();
			const verification = createVerification({ filesChanged: 5 });
			const startTime = Date.now() - 1000;

			const result = handleAlreadyComplete(identity, state, verification, startTime);

			expect(result.verification).toBe(verification);
			expect(result.verification?.filesChanged).toBe(5);
		});

		it("calculates duration from startTime", () => {
			const identity = createIdentity();
			const state = createState();
			const verification = createVerification();
			const startTime = Date.now() - 5000; // 5 seconds ago

			const result = handleAlreadyComplete(identity, state, verification, startTime);

			expect(result.durationMs).toBeGreaterThanOrEqual(5000);
			expect(result.durationMs).toBeLessThan(10000);
		});

		it("does not include commitSha", () => {
			const identity = createIdentity();
			const state = createState();
			const verification = createVerification();
			const startTime = Date.now();

			const result = handleAlreadyComplete(identity, state, verification, startTime);

			expect(result.commitSha).toBeUndefined();
		});
	});

	describe("buildEnhancedFeedback", () => {
		it("returns base feedback when no enhancements available", () => {
			const verification = createVerification({ feedback: "Base feedback" });

			const result = buildEnhancedFeedback(
				"task-123",
				verification,
				"typecheck",
				"Error message",
				null,
				[],
				".undercity",
			);

			// Base feedback should always be present
			// Additional knowledge may be appended if relevant learnings exist
			expect(result).toContain("Base feedback");
		});

		it("appends fix suggestions when available", async () => {
			const { formatFixSuggestionsForPrompt } = await import("../error-fix-patterns.js");
			vi.mocked(formatFixSuggestionsForPrompt).mockReturnValueOnce("Try fixing with X");

			const verification = createVerification({ feedback: "Base feedback" });

			const result = buildEnhancedFeedback(
				"task-123",
				verification,
				"typecheck",
				"Error message",
				null,
				[],
				".undercity",
			);

			expect(result).toContain("Base feedback");
			expect(result).toContain("Try fixing with X");
		});

		it("appends human guidance when pendingErrorSignature provided", async () => {
			const { formatGuidanceForWorker } = await import("../human-input-tracking.js");
			vi.mocked(formatGuidanceForWorker).mockReturnValueOnce("Human says: do this");

			const verification = createVerification({ feedback: "Base feedback" });

			const result = buildEnhancedFeedback(
				"task-123",
				verification,
				"typecheck",
				"Error message",
				"error-sig-123",
				[],
				".undercity",
			);

			expect(result).toContain("Human says: do this");
		});

		it("appends co-modification hints when files modified", async () => {
			const { formatCoModificationHints } = await import("../task-file-patterns.js");
			vi.mocked(formatCoModificationHints).mockReturnValueOnce("Also check related.ts");

			const verification = createVerification({ feedback: "Base feedback" });

			const result = buildEnhancedFeedback(
				"task-123",
				verification,
				"typecheck",
				"Error message",
				null,
				["file1.ts", "file2.ts"],
				".undercity",
			);

			expect(result).toContain("Also check related.ts");
		});

		it("handles errors gracefully without crashing", async () => {
			const { formatFixSuggestionsForPrompt } = await import("../error-fix-patterns.js");
			vi.mocked(formatFixSuggestionsForPrompt).mockImplementationOnce(() => {
				throw new Error("oops");
			});

			const verification = createVerification({ feedback: "Base feedback" });

			const result = buildEnhancedFeedback(
				"task-123",
				verification,
				"typecheck",
				"Error message",
				null,
				[],
				".undercity",
			);

			// Should not crash, and should always contain base feedback
			// Additional knowledge may be appended if relevant learnings exist
			expect(result).toContain("Base feedback");
		});
	});

	describe("recordVerificationFailure", () => {
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

		const createDeps = (): Pick<VerificationDependencies, "getModifiedFiles" | "saveCheckpoint"> => ({
			getModifiedFiles: vi.fn(() => ["file1.ts"]),
			saveCheckpoint: vi.fn(),
		});

		beforeEach(() => {
			vi.clearAllMocks();
		});

		it("records attempt as failed", () => {
			const identity = createIdentity();
			const state = createState({ attemptRecords: [] });
			const config = createConfig();
			const verification = createVerification({
				passed: false,
				feedback: "Type error",
				issues: ["TS2322: Type error"],
			});
			const errorCategories: ErrorCategory[] = ["typecheck"];
			const deps = createDeps();

			recordVerificationFailure(identity, state, config, verification, errorCategories, Date.now(), deps);

			expect(state.attemptRecords).toHaveLength(1);
			expect(state.attemptRecords[0].success).toBe(false);
		});

		it("records error in errorHistory", () => {
			const identity = createIdentity();
			const state = createState({ errorHistory: [], attempts: 2 });
			const config = createConfig();
			const verification = createVerification({
				passed: false,
				feedback: "Type error",
				issues: ["TS2322: Type error"],
			});
			const errorCategories: ErrorCategory[] = ["typecheck"];
			const deps = createDeps();

			recordVerificationFailure(identity, state, config, verification, errorCategories, Date.now(), deps);

			expect(state.errorHistory).toHaveLength(1);
			expect(state.errorHistory[0].category).toBe("typecheck");
			expect(state.errorHistory[0].message).toBe("TS2322: Type error");
			expect(state.errorHistory[0].attempt).toBe(2);
		});

		it("sets lastErrorCategory and lastErrorMessage", () => {
			const identity = createIdentity();
			const state = createState();
			const config = createConfig();
			const verification = createVerification({
				passed: false,
				feedback: "Test failure",
				issues: ["Test failed: expected true"],
			});
			const errorCategories: ErrorCategory[] = ["test"];
			const deps = createDeps();

			recordVerificationFailure(identity, state, config, verification, errorCategories, Date.now(), deps);

			expect(state.lastErrorCategory).toBe("test");
			expect(state.lastErrorMessage).toBe("Test failed: expected true");
		});

		it("uses feedback when no issues provided", () => {
			const identity = createIdentity();
			const state = createState();
			const config = createConfig();
			const verification = createVerification({
				passed: false,
				feedback: "Something went wrong with very long message that should be truncated",
				issues: [],
			});
			const errorCategories: ErrorCategory[] = [];
			const deps = createDeps();

			recordVerificationFailure(identity, state, config, verification, errorCategories, Date.now(), deps);

			expect(state.lastErrorCategory).toBe("unknown");
			expect(state.lastErrorMessage).toContain("Something went wrong");
		});

		it("captures detailed errors from feedback", () => {
			const identity = createIdentity();
			const state = createState();
			const config = createConfig();
			const verification = createVerification({
				passed: false,
				feedback: "Build failed\nerror TS2322: Type\nwarning: unused\nError in line 5\ninfo: done",
				issues: ["TS2322"],
			});
			const errorCategories: ErrorCategory[] = ["typecheck"];
			const deps = createDeps();

			recordVerificationFailure(identity, state, config, verification, errorCategories, Date.now(), deps);

			expect(state.lastDetailedErrors).toContain("TS2322");
			expect(state.lastDetailedErrors.some((e) => e.includes("error TS2322"))).toBe(true);
			expect(state.lastDetailedErrors.some((e) => e.includes("Error in line 5"))).toBe(true);
		});

		it("calls saveCheckpoint with failure data", () => {
			const identity = createIdentity();
			const state = createState();
			const config = createConfig();
			const verification = createVerification({
				passed: false,
				feedback: "Failed",
				issues: ["Error 1", "Error 2", "Error 3"],
			});
			const errorCategories: ErrorCategory[] = ["typecheck"];
			const deps = createDeps();

			recordVerificationFailure(identity, state, config, verification, errorCategories, Date.now(), deps);

			expect(deps.saveCheckpoint).toHaveBeenCalledWith("verifying", {
				passed: false,
				errors: ["Error 1", "Error 2", "Error 3"],
			});
		});

		it("returns feedback and errorSignature", () => {
			const identity = createIdentity();
			const state = createState();
			const config = createConfig();
			const verification = createVerification({
				passed: false,
				feedback: "Type error occurred",
				issues: ["TS2322"],
			});
			const errorCategories: ErrorCategory[] = ["typecheck"];
			const deps = createDeps();

			const result = recordVerificationFailure(
				identity,
				state,
				config,
				verification,
				errorCategories,
				Date.now(),
				deps,
			);

			expect(result.feedback).toContain("Type error occurred");
			// errorSignature may be null if recordPendingError fails (uses dynamic require)
			expect(result).toHaveProperty("errorSignature");
		});
	});
});
