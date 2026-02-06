/**
 * Type tests for core type definitions
 *
 * Tests type safety for foundational types in types.ts using vitest's
 * expectTypeOf for compile-time type assertions.
 */
import { describe, expectTypeOf, test } from "vitest";
import {
	type Agent,
	type AgentStatus,
	type AgentType,
	type ErrorCategory,
	type FileConflict,
	type FileOperation,
	type FileTouch,
	type FileTrackingEntry,
	type HistoricalModelChoice,
	type MergeQueueItem,
	type MergeStatus,
	MODEL_NAMES,
	type ModelChoice,
	type ModelTier,
	normalizeModel,
	type SessionStatus,
	type Step,
	type StepStatus,
	type TaskCheckpoint,
	type TaskType,
	type TokenUsage,
} from "./types.js";

describe("Session Types", () => {
	test("SessionStatus is correct union", () => {
		type ExpectedSessionStatus =
			| "planning"
			| "awaiting_approval"
			| "executing"
			| "reviewing"
			| "merging"
			| "extracting"
			| "complete"
			| "failed";

		expectTypeOf<SessionStatus>().toEqualTypeOf<ExpectedSessionStatus>();

		// Positive tests - valid statuses
		expectTypeOf<"planning">().toMatchTypeOf<SessionStatus>();
		expectTypeOf<"executing">().toMatchTypeOf<SessionStatus>();
		expectTypeOf<"complete">().toMatchTypeOf<SessionStatus>();

		// @ts-expect-error - invalid status
		expectTypeOf<"invalid_session_status">().toMatchTypeOf<SessionStatus>();
	});

	test("StepStatus is correct union", () => {
		type ExpectedStepStatus =
			| "pending"
			| "assigned"
			| "in_progress"
			| "complete"
			| "failed"
			| "blocked"
			| "checkpointed"
			| "recovering"
			| "escalated";

		expectTypeOf<StepStatus>().toEqualTypeOf<ExpectedStepStatus>();

		// Positive tests
		expectTypeOf<"pending">().toMatchTypeOf<StepStatus>();
		expectTypeOf<"in_progress">().toMatchTypeOf<StepStatus>();
		expectTypeOf<"escalated">().toMatchTypeOf<StepStatus>();

		// @ts-expect-error - invalid status
		expectTypeOf<"running">().toMatchTypeOf<StepStatus>();
	});
});

describe("Agent Types", () => {
	test("AgentType is correct union", () => {
		type ExpectedAgentType = "scout" | "planner" | "builder" | "reviewer";

		expectTypeOf<AgentType>().toEqualTypeOf<ExpectedAgentType>();

		// Positive tests
		expectTypeOf<"scout">().toMatchTypeOf<AgentType>();
		expectTypeOf<"builder">().toMatchTypeOf<AgentType>();

		// @ts-expect-error - invalid agent type
		expectTypeOf<"executor">().toMatchTypeOf<AgentType>();
	});

	test("AgentStatus is correct union", () => {
		type ExpectedAgentStatus = "idle" | "working" | "done" | "error" | "stuck";

		expectTypeOf<AgentStatus>().toEqualTypeOf<ExpectedAgentStatus>();

		// Positive tests
		expectTypeOf<"idle">().toMatchTypeOf<AgentStatus>();
		expectTypeOf<"working">().toMatchTypeOf<AgentStatus>();

		// @ts-expect-error - invalid agent status
		expectTypeOf<"active">().toMatchTypeOf<AgentStatus>();
	});

	test("Agent interface has correct structure", () => {
		expectTypeOf<Agent>().toHaveProperty("id");
		expectTypeOf<Agent>().toHaveProperty("type");
		expectTypeOf<Agent>().toHaveProperty("status");
		expectTypeOf<Agent>().toHaveProperty("spawnedAt");
		expectTypeOf<Agent>().toHaveProperty("lastActivityAt");

		expectTypeOf<Agent["id"]>().toBeString();
		expectTypeOf<Agent["type"]>().toEqualTypeOf<AgentType>();
		expectTypeOf<Agent["status"]>().toEqualTypeOf<AgentStatus>();
		expectTypeOf<Agent["sdkSessionId"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<Agent["spawnedAt"]>().toEqualTypeOf<Date>();
		expectTypeOf<Agent["lastActivityAt"]>().toEqualTypeOf<Date>();
	});

	test("Step interface has correct structure", () => {
		expectTypeOf<Step>().toHaveProperty("id");
		expectTypeOf<Step>().toHaveProperty("sessionId");
		expectTypeOf<Step>().toHaveProperty("type");
		expectTypeOf<Step>().toHaveProperty("description");
		expectTypeOf<Step>().toHaveProperty("status");
		expectTypeOf<Step>().toHaveProperty("createdAt");

		expectTypeOf<Step["id"]>().toBeString();
		expectTypeOf<Step["sessionId"]>().toBeString();
		expectTypeOf<Step["type"]>().toEqualTypeOf<AgentType>();
		expectTypeOf<Step["description"]>().toBeString();
		expectTypeOf<Step["status"]>().toEqualTypeOf<StepStatus>();
		expectTypeOf<Step["agentId"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<Step["branch"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<Step["result"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<Step["error"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<Step["createdAt"]>().toEqualTypeOf<Date>();
		expectTypeOf<Step["completedAt"]>().toEqualTypeOf<Date | undefined>();
	});
});

describe("Model Types", () => {
	test("ModelTier is correct union", () => {
		type ExpectedModelTier = "sonnet" | "opus";

		expectTypeOf<ModelTier>().toEqualTypeOf<ExpectedModelTier>();

		// Positive tests
		expectTypeOf<"sonnet">().toMatchTypeOf<ModelTier>();
		expectTypeOf<"opus">().toMatchTypeOf<ModelTier>();

		// @ts-expect-error - haiku removed from current ModelTier
		expectTypeOf<"haiku">().toMatchTypeOf<ModelTier>();
	});

	test("ModelChoice is correct union", () => {
		type ExpectedModelChoice = "sonnet" | "opus";

		expectTypeOf<ModelChoice>().toEqualTypeOf<ExpectedModelChoice>();

		// Positive tests
		expectTypeOf<"sonnet">().toMatchTypeOf<ModelChoice>();
		expectTypeOf<"opus">().toMatchTypeOf<ModelChoice>();

		// @ts-expect-error - invalid model
		expectTypeOf<"gpt-4">().toMatchTypeOf<ModelChoice>();
	});

	test("HistoricalModelChoice includes deprecated haiku", () => {
		type ExpectedHistoricalModelChoice = "sonnet" | "opus" | "haiku";

		expectTypeOf<HistoricalModelChoice>().toEqualTypeOf<ExpectedHistoricalModelChoice>();

		// Positive tests
		expectTypeOf<"haiku">().toMatchTypeOf<HistoricalModelChoice>();
		expectTypeOf<"sonnet">().toMatchTypeOf<HistoricalModelChoice>();
	});

	test("MODEL_NAMES constant has correct structure", () => {
		expectTypeOf<typeof MODEL_NAMES>().toEqualTypeOf<Record<ModelTier, string>>();

		expectTypeOf<typeof MODEL_NAMES.sonnet>().toBeString();
		expectTypeOf<typeof MODEL_NAMES.opus>().toBeString();

		// @ts-expect-error - haiku not in MODEL_NAMES
		MODEL_NAMES.haiku;
	});

	test("normalizeModel function signature", () => {
		expectTypeOf(normalizeModel).parameter(0).toEqualTypeOf<HistoricalModelChoice | undefined>();
		expectTypeOf(normalizeModel).returns.toEqualTypeOf<ModelChoice>();

		// Should accept haiku
		expectTypeOf(normalizeModel).toBeCallableWith("haiku");
		expectTypeOf(normalizeModel).toBeCallableWith("sonnet");
		expectTypeOf(normalizeModel).toBeCallableWith(undefined);

		// @ts-expect-error - invalid model
		normalizeModel("gpt-4");
	});
});

describe("Merge Queue Types", () => {
	test("MergeStatus is correct union", () => {
		type ExpectedMergeStatus =
			| "pending"
			| "rebasing"
			| "testing"
			| "merging"
			| "pushing"
			| "complete"
			| "conflict"
			| "test_failed";

		expectTypeOf<MergeStatus>().toEqualTypeOf<ExpectedMergeStatus>();

		// Positive tests
		expectTypeOf<"pending">().toMatchTypeOf<MergeStatus>();
		expectTypeOf<"rebasing">().toMatchTypeOf<MergeStatus>();
		expectTypeOf<"complete">().toMatchTypeOf<MergeStatus>();

		// @ts-expect-error - invalid status
		expectTypeOf<"waiting">().toMatchTypeOf<MergeStatus>();
	});

	test("MergeQueueItem has correct required fields", () => {
		expectTypeOf<MergeQueueItem>().toHaveProperty("branch");
		expectTypeOf<MergeQueueItem>().toHaveProperty("stepId");
		expectTypeOf<MergeQueueItem>().toHaveProperty("agentId");
		expectTypeOf<MergeQueueItem>().toHaveProperty("status");
		expectTypeOf<MergeQueueItem>().toHaveProperty("queuedAt");

		expectTypeOf<MergeQueueItem["branch"]>().toBeString();
		expectTypeOf<MergeQueueItem["stepId"]>().toBeString();
		expectTypeOf<MergeQueueItem["agentId"]>().toBeString();
		expectTypeOf<MergeQueueItem["status"]>().toEqualTypeOf<MergeStatus>();
		expectTypeOf<MergeQueueItem["queuedAt"]>().toEqualTypeOf<Date>();
	});

	test("MergeQueueItem has correct optional fields", () => {
		expectTypeOf<MergeQueueItem["completedAt"]>().toEqualTypeOf<Date | undefined>();
		expectTypeOf<MergeQueueItem["error"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<MergeQueueItem["strategyUsed"]>().toEqualTypeOf<"theirs" | "ours" | "default" | undefined>();
		expectTypeOf<MergeQueueItem["conflictFiles"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<MergeQueueItem["retryCount"]>().toEqualTypeOf<number | undefined>();
		expectTypeOf<MergeQueueItem["maxRetries"]>().toEqualTypeOf<number | undefined>();
		expectTypeOf<MergeQueueItem["lastFailedAt"]>().toEqualTypeOf<Date | undefined>();
		expectTypeOf<MergeQueueItem["nextRetryAfter"]>().toEqualTypeOf<Date | undefined>();
		expectTypeOf<MergeQueueItem["originalError"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<MergeQueueItem["isRetry"]>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<MergeQueueItem["modifiedFiles"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<MergeQueueItem["duration"]>().toEqualTypeOf<number | undefined>();
		expectTypeOf<MergeQueueItem["startedAt"]>().toEqualTypeOf<Date | undefined>();
	});
});

describe("File Tracking Types", () => {
	test("FileOperation is correct union", () => {
		type ExpectedFileOperation = "read" | "write" | "edit" | "delete";

		expectTypeOf<FileOperation>().toEqualTypeOf<ExpectedFileOperation>();

		// Positive tests
		expectTypeOf<"read">().toMatchTypeOf<FileOperation>();
		expectTypeOf<"write">().toMatchTypeOf<FileOperation>();

		// @ts-expect-error - invalid operation
		expectTypeOf<"create">().toMatchTypeOf<FileOperation>();
	});

	test("FileTouch has correct structure", () => {
		expectTypeOf<FileTouch>().toHaveProperty("path");
		expectTypeOf<FileTouch>().toHaveProperty("operation");
		expectTypeOf<FileTouch>().toHaveProperty("timestamp");

		expectTypeOf<FileTouch["path"]>().toBeString();
		expectTypeOf<FileTouch["operation"]>().toEqualTypeOf<FileOperation>();
		expectTypeOf<FileTouch["timestamp"]>().toEqualTypeOf<Date>();
	});

	test("FileTrackingEntry has correct structure", () => {
		expectTypeOf<FileTrackingEntry>().toHaveProperty("agentId");
		expectTypeOf<FileTrackingEntry>().toHaveProperty("stepId");
		expectTypeOf<FileTrackingEntry>().toHaveProperty("sessionId");
		expectTypeOf<FileTrackingEntry>().toHaveProperty("files");
		expectTypeOf<FileTrackingEntry>().toHaveProperty("startedAt");

		expectTypeOf<FileTrackingEntry["agentId"]>().toBeString();
		expectTypeOf<FileTrackingEntry["stepId"]>().toBeString();
		expectTypeOf<FileTrackingEntry["sessionId"]>().toBeString();
		expectTypeOf<FileTrackingEntry["files"]>().toEqualTypeOf<FileTouch[]>();
		expectTypeOf<FileTrackingEntry["startedAt"]>().toEqualTypeOf<Date>();
		expectTypeOf<FileTrackingEntry["endedAt"]>().toEqualTypeOf<Date | undefined>();
	});

	test("FileConflict has correct structure", () => {
		expectTypeOf<FileConflict>().toHaveProperty("path");
		expectTypeOf<FileConflict>().toHaveProperty("touchedBy");

		expectTypeOf<FileConflict["path"]>().toBeString();
		expectTypeOf<FileConflict["touchedBy"]>().toBeArray();

		// Test the structure of touchedBy array elements
		type TouchedByElement = FileConflict["touchedBy"][number];
		expectTypeOf<TouchedByElement>().toHaveProperty("agentId");
		expectTypeOf<TouchedByElement>().toHaveProperty("stepId");
		expectTypeOf<TouchedByElement>().toHaveProperty("operation");
		expectTypeOf<TouchedByElement>().toHaveProperty("timestamp");

		expectTypeOf<TouchedByElement["agentId"]>().toBeString();
		expectTypeOf<TouchedByElement["stepId"]>().toBeString();
		expectTypeOf<TouchedByElement["operation"]>().toEqualTypeOf<FileOperation>();
		expectTypeOf<TouchedByElement["timestamp"]>().toEqualTypeOf<Date>();
	});
});

describe("Token Usage Types", () => {
	test("TokenUsage has correct structure", () => {
		expectTypeOf<TokenUsage>().toHaveProperty("inputTokens");
		expectTypeOf<TokenUsage>().toHaveProperty("outputTokens");
		expectTypeOf<TokenUsage>().toHaveProperty("totalTokens");
		expectTypeOf<TokenUsage>().toHaveProperty("sonnetEquivalentTokens");

		expectTypeOf<TokenUsage["inputTokens"]>().toBeNumber();
		expectTypeOf<TokenUsage["outputTokens"]>().toBeNumber();
		expectTypeOf<TokenUsage["totalTokens"]>().toBeNumber();
		expectTypeOf<TokenUsage["sonnetEquivalentTokens"]>().toBeNumber();
		expectTypeOf<TokenUsage["model"]>().toEqualTypeOf<ModelChoice | undefined>();
		expectTypeOf<TokenUsage["timestamp"]>().toEqualTypeOf<Date | undefined>();
	});
});

describe("Error Category Types", () => {
	test("ErrorCategory is correct union", () => {
		// Verify all error category variants
		expectTypeOf<"lint">().toMatchTypeOf<ErrorCategory>();
		expectTypeOf<"typecheck">().toMatchTypeOf<ErrorCategory>();
		expectTypeOf<"build">().toMatchTypeOf<ErrorCategory>();
		expectTypeOf<"test">().toMatchTypeOf<ErrorCategory>();
		expectTypeOf<"spell">().toMatchTypeOf<ErrorCategory>();
		expectTypeOf<"no_changes">().toMatchTypeOf<ErrorCategory>();
		expectTypeOf<"no_changes_complete">().toMatchTypeOf<ErrorCategory>();
		expectTypeOf<"no_changes_mismatch">().toMatchTypeOf<ErrorCategory>();
		expectTypeOf<"no_changes_confused">().toMatchTypeOf<ErrorCategory>();
		expectTypeOf<"unknown">().toMatchTypeOf<ErrorCategory>();

		// @ts-expect-error - invalid error category
		expectTypeOf<"syntax_error">().toMatchTypeOf<ErrorCategory>();
	});
});

describe("Task Type Classifications", () => {
	test("TaskType is correct union", () => {
		type ExpectedTaskType = "feature" | "bugfix" | "refactor" | "docs" | "test" | "chore" | "unknown";

		expectTypeOf<TaskType>().toEqualTypeOf<ExpectedTaskType>();

		// Positive tests
		expectTypeOf<"feature">().toMatchTypeOf<TaskType>();
		expectTypeOf<"bugfix">().toMatchTypeOf<TaskType>();
		expectTypeOf<"unknown">().toMatchTypeOf<TaskType>();

		// @ts-expect-error - invalid task type
		expectTypeOf<"enhancement">().toMatchTypeOf<TaskType>();
	});
});

describe("Task Checkpoint Types", () => {
	test("TaskCheckpoint has correct structure", () => {
		expectTypeOf<TaskCheckpoint>().toHaveProperty("phase");
		expectTypeOf<TaskCheckpoint>().toHaveProperty("model");
		expectTypeOf<TaskCheckpoint>().toHaveProperty("attempts");
		expectTypeOf<TaskCheckpoint>().toHaveProperty("savedAt");

		type ExpectedPhase = "starting" | "context" | "executing" | "verifying" | "reviewing" | "committing";
		expectTypeOf<TaskCheckpoint["phase"]>().toEqualTypeOf<ExpectedPhase>();
		expectTypeOf<TaskCheckpoint["model"]>().toEqualTypeOf<ModelChoice>();
		expectTypeOf<TaskCheckpoint["attempts"]>().toBeNumber();
		expectTypeOf<TaskCheckpoint["savedAt"]>().toEqualTypeOf<Date>();
	});

	test("TaskCheckpoint lastVerification field", () => {
		expectTypeOf<TaskCheckpoint["lastVerification"]>().toEqualTypeOf<
			| {
					passed: boolean;
					errors?: string[];
			  }
			| undefined
		>();
	});
});

describe("Invalid usage patterns (should fail compilation)", () => {
	test("rejects invalid session status", () => {
		// @ts-expect-error - invalid status
		const _status: SessionStatus = "invalid";
	});

	test("rejects invalid agent type", () => {
		// @ts-expect-error - invalid agent type
		const _agentType: AgentType = "worker";
	});

	test("rejects invalid model tier", () => {
		// @ts-expect-error - invalid model
		const _model: ModelTier = "haiku";
	});

	test("rejects invalid file operation", () => {
		// @ts-expect-error - invalid operation
		const _op: FileOperation = "append";
	});

	test("rejects invalid merge status", () => {
		// @ts-expect-error - invalid status
		const _status: MergeStatus = "queued";
	});

	test("Agent requires correct field types", () => {
		const _agent: Agent = {
			id: "agent-1",
			// @ts-expect-error - type must be AgentType
			type: "invalid",
			status: "idle",
			spawnedAt: new Date(),
			lastActivityAt: new Date(),
		};
	});

	test("Step requires correct field types", () => {
		const _step: Step = {
			id: "step-1",
			sessionId: "session-1",
			type: "builder",
			description: "Build feature",
			// @ts-expect-error - status must be StepStatus
			status: "invalid",
			createdAt: new Date(),
		};
	});

	test("MergeQueueItem requires correct strategy type", () => {
		const _item: MergeQueueItem = {
			branch: "feature-1",
			stepId: "step-1",
			agentId: "agent-1",
			status: "pending",
			queuedAt: new Date(),
			// @ts-expect-error - invalid strategy
			strategyUsed: "auto",
		};
	});
});
