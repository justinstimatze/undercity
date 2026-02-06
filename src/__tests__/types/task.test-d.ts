/**
 * Type tests for task-related structures
 *
 * Tests type safety for task board, task metadata, and related interfaces
 * using vitest's expectTypeOf for compile-time type assertions.
 */
import { describe, expectTypeOf, test } from "vitest";
import type { TaskStatus as StorageTaskStatus } from "../../storage.js";
import type {
	AddTaskOptions,
	HandoffContext,
	LastAttemptContext,
	MarkTaskInProgressParams,
	Task,
	TaskBoard,
} from "../../task.js";
import type {
	TaskType as ExecutionTaskType,
	MetaTaskAction as SchemaMetaTaskAction,
	MetaTaskRecommendation as SchemaMetaTaskRecommendation,
	MetaTaskType as SchemaMetaTaskType,
	TaskStatus as SchemaTaskStatus,
	TaskCategory,
} from "../../task-schema.js";
// Import TaskType from both locations with explicit names
import type {
	TaskType as FeatureTaskType,
	ResearchConclusion,
	TaskBatchResult,
	TaskMetrics,
	TaskSetMetadata,
	TaskUsage,
	TicketContent,
	TriageIssue,
	TriageReport,
} from "../../types.js";

describe("Task interface type tests", () => {
	test("Task has correct required fields", () => {
		expectTypeOf<Task>().toHaveProperty("id");
		expectTypeOf<Task>().toHaveProperty("objective");
		expectTypeOf<Task>().toHaveProperty("status");
		expectTypeOf<Task>().toHaveProperty("createdAt");

		// Verify field types
		expectTypeOf<Task["id"]>().toBeString();
		expectTypeOf<Task["objective"]>().toBeString();
		expectTypeOf<Task["createdAt"]>().toEqualTypeOf<Date>();
	});

	test("Task has correct optional fields", () => {
		expectTypeOf<Task["priority"]>().toEqualTypeOf<number | undefined>();
		expectTypeOf<Task["sessionId"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<Task["error"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<Task["handoffContext"]>().toEqualTypeOf<HandoffContext | undefined>();
		expectTypeOf<Task["lastAttempt"]>().toEqualTypeOf<LastAttemptContext | undefined>();
		expectTypeOf<Task["researchConclusion"]>().toEqualTypeOf<ResearchConclusion | undefined>();
		expectTypeOf<Task["ticket"]>().toEqualTypeOf<TicketContent | undefined>();
	});

	test("Task status union type is correct", () => {
		type ExpectedStatus =
			| "pending"
			| "in_progress"
			| "decomposed"
			| "complete"
			| "failed"
			| "blocked"
			| "duplicate"
			| "canceled"
			| "obsolete";

		expectTypeOf<Task["status"]>().toEqualTypeOf<ExpectedStatus>();

		// Positive tests - valid statuses
		expectTypeOf<"pending">().toMatchTypeOf<Task["status"]>();
		expectTypeOf<"in_progress">().toMatchTypeOf<Task["status"]>();
		expectTypeOf<"complete">().toMatchTypeOf<Task["status"]>();
		expectTypeOf<"failed">().toMatchTypeOf<Task["status"]>();

		// @ts-expect-error - invalid status should fail
		expectTypeOf<"invalid_status">().toMatchTypeOf<Task["status"]>();
	});

	test("Task matchmaking fields are correct", () => {
		expectTypeOf<Task["packageHints"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<Task["dependsOn"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<Task["relatedTo"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<Task["conflicts"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<Task["estimatedFiles"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<Task["tags"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<Task["computedPackages"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<Task["riskScore"]>().toEqualTypeOf<number | undefined>();
	});

	test("Task decomposition fields are correct", () => {
		expectTypeOf<Task["parentId"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<Task["subtaskIds"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<Task["isDecomposed"]>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<Task["decompositionDepth"]>().toEqualTypeOf<number | undefined>();
	});
});

describe("HandoffContext and LastAttemptContext type tests", () => {
	test("HandoffContext has correct structure", () => {
		expectTypeOf<HandoffContext["filesRead"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<HandoffContext["decisions"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<HandoffContext["codeContext"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<HandoffContext["notes"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<HandoffContext["lastAttempt"]>().toEqualTypeOf<LastAttemptContext | undefined>();
		expectTypeOf<HandoffContext["isRetry"]>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<HandoffContext["humanGuidance"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<HandoffContext["previousError"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<HandoffContext["previousAttempts"]>().toEqualTypeOf<number | undefined>();
	});

	test("LastAttemptContext has correct required fields", () => {
		expectTypeOf<LastAttemptContext>().toHaveProperty("model");
		expectTypeOf<LastAttemptContext>().toHaveProperty("category");
		expectTypeOf<LastAttemptContext>().toHaveProperty("error");
		expectTypeOf<LastAttemptContext>().toHaveProperty("filesModified");
		expectTypeOf<LastAttemptContext>().toHaveProperty("attemptedAt");
		expectTypeOf<LastAttemptContext>().toHaveProperty("attemptCount");

		expectTypeOf<LastAttemptContext["model"]>().toBeString();
		expectTypeOf<LastAttemptContext["category"]>().toBeString();
		expectTypeOf<LastAttemptContext["error"]>().toBeString();
		expectTypeOf<LastAttemptContext["filesModified"]>().toEqualTypeOf<string[]>();
		expectTypeOf<LastAttemptContext["attemptedAt"]>().toEqualTypeOf<Date>();
		expectTypeOf<LastAttemptContext["attemptCount"]>().toBeNumber();
	});
});

describe("TaskBoard type tests", () => {
	test("TaskBoard has correct structure", () => {
		expectTypeOf<TaskBoard>().toHaveProperty("tasks");
		expectTypeOf<TaskBoard>().toHaveProperty("lastUpdated");

		expectTypeOf<TaskBoard["tasks"]>().toEqualTypeOf<Task[]>();
		expectTypeOf<TaskBoard["lastUpdated"]>().toEqualTypeOf<Date>();
	});
});

describe("Parameter interfaces type tests", () => {
	test("AddTaskOptions has correct structure", () => {
		expectTypeOf<AddTaskOptions["priority"]>().toEqualTypeOf<number | undefined>();
		expectTypeOf<AddTaskOptions["handoffContext"]>().toEqualTypeOf<HandoffContext | undefined>();
		expectTypeOf<AddTaskOptions["path"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<AddTaskOptions["skipDuplicateCheck"]>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<AddTaskOptions["dependsOn"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<AddTaskOptions["relatedTo"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<AddTaskOptions["tags"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<AddTaskOptions["ticket"]>().toEqualTypeOf<TicketContent | undefined>();
	});

	test("MarkTaskInProgressParams has correct required fields", () => {
		expectTypeOf<MarkTaskInProgressParams>().toHaveProperty("id");
		expectTypeOf<MarkTaskInProgressParams>().toHaveProperty("sessionId");

		expectTypeOf<MarkTaskInProgressParams["id"]>().toBeString();
		expectTypeOf<MarkTaskInProgressParams["sessionId"]>().toBeString();
		expectTypeOf<MarkTaskInProgressParams["path"]>().toEqualTypeOf<string | undefined>();
	});
});

describe("TaskStatus union from task.ts and storage.ts", () => {
	test("Task status from task.ts matches expected union", () => {
		type ExpectedStatus =
			| "pending"
			| "in_progress"
			| "decomposed"
			| "complete"
			| "failed"
			| "blocked"
			| "duplicate"
			| "canceled"
			| "obsolete";

		expectTypeOf<Task["status"]>().toEqualTypeOf<ExpectedStatus>();
	});

	test("TaskStatus from storage.ts should be compatible", () => {
		// StorageTaskStatus should be a subset or equal to Task["status"]
		expectTypeOf<StorageTaskStatus>().toMatchTypeOf<Task["status"]>();
	});
});

describe("Types from types.ts", () => {
	test("TaskBatchResult has correct structure", () => {
		expectTypeOf<TaskBatchResult>().toHaveProperty("completedTasks");
		expectTypeOf<TaskBatchResult>().toHaveProperty("failedTasks");
		expectTypeOf<TaskBatchResult>().toHaveProperty("totalDuration");
		expectTypeOf<TaskBatchResult>().toHaveProperty("conflicts");

		expectTypeOf<TaskBatchResult["completedTasks"]>().toEqualTypeOf<string[]>();
		expectTypeOf<TaskBatchResult["failedTasks"]>().toEqualTypeOf<string[]>();
		expectTypeOf<TaskBatchResult["totalDuration"]>().toBeNumber();
	});

	test("TaskSetMetadata has correct structure", () => {
		expectTypeOf<TaskSetMetadata>().toHaveProperty("taskIds");
		expectTypeOf<TaskSetMetadata>().toHaveProperty("sessionIds");
		expectTypeOf<TaskSetMetadata>().toHaveProperty("startedAt");
		expectTypeOf<TaskSetMetadata>().toHaveProperty("estimatedDuration");
		expectTypeOf<TaskSetMetadata>().toHaveProperty("riskLevel");

		expectTypeOf<TaskSetMetadata["taskIds"]>().toEqualTypeOf<string[]>();
		expectTypeOf<TaskSetMetadata["sessionIds"]>().toEqualTypeOf<string[]>();
		expectTypeOf<TaskSetMetadata["startedAt"]>().toEqualTypeOf<Date>();
		expectTypeOf<TaskSetMetadata["estimatedDuration"]>().toBeNumber();
		expectTypeOf<TaskSetMetadata["riskLevel"]>().toEqualTypeOf<"low" | "medium" | "high">();
	});

	test("TaskUsage has correct structure", () => {
		expectTypeOf<TaskUsage>().toHaveProperty("taskId");
		expectTypeOf<TaskUsage>().toHaveProperty("model");
		expectTypeOf<TaskUsage>().toHaveProperty("tokens");
		expectTypeOf<TaskUsage>().toHaveProperty("timestamp");

		expectTypeOf<TaskUsage["taskId"]>().toBeString();
		expectTypeOf<TaskUsage["sessionId"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<TaskUsage["agentId"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<TaskUsage["model"]>().toEqualTypeOf<"sonnet" | "opus">();
		expectTypeOf<TaskUsage["timestamp"]>().toEqualTypeOf<Date>();
		expectTypeOf<TaskUsage["durationMs"]>().toEqualTypeOf<number | undefined>();
	});

	test("TaskMetrics has correct structure", () => {
		expectTypeOf<TaskMetrics>().toHaveProperty("taskId");
		expectTypeOf<TaskMetrics>().toHaveProperty("sessionId");
		expectTypeOf<TaskMetrics>().toHaveProperty("objective");
		expectTypeOf<TaskMetrics>().toHaveProperty("success");
		expectTypeOf<TaskMetrics>().toHaveProperty("durationMs");
		expectTypeOf<TaskMetrics>().toHaveProperty("totalTokens");
		expectTypeOf<TaskMetrics>().toHaveProperty("agentsSpawned");
		expectTypeOf<TaskMetrics>().toHaveProperty("agentTypes");
		expectTypeOf<TaskMetrics>().toHaveProperty("startedAt");
		expectTypeOf<TaskMetrics>().toHaveProperty("completedAt");

		expectTypeOf<TaskMetrics["success"]>().toBeBoolean();
		expectTypeOf<TaskMetrics["durationMs"]>().toBeNumber();
		expectTypeOf<TaskMetrics["totalTokens"]>().toBeNumber();
		expectTypeOf<TaskMetrics["agentsSpawned"]>().toBeNumber();
	});
});

describe("TicketContent type tests", () => {
	test("TicketContent has correct optional fields", () => {
		expectTypeOf<TicketContent["description"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<TicketContent["acceptanceCriteria"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<TicketContent["testPlan"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<TicketContent["implementationNotes"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<TicketContent["source"]>().toEqualTypeOf<
			"pm" | "user" | "research" | "codebase_gap" | "pattern_analysis" | undefined
		>();
		expectTypeOf<TicketContent["researchFindings"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<TicketContent["rationale"]>().toEqualTypeOf<string | undefined>();
	});
});

describe("TriageIssue and TriageReport type tests", () => {
	test("TriageIssue has correct structure", () => {
		expectTypeOf<TriageIssue>().toHaveProperty("type");
		expectTypeOf<TriageIssue>().toHaveProperty("reason");
		expectTypeOf<TriageIssue>().toHaveProperty("action");
		expectTypeOf<TriageIssue>().toHaveProperty("detectedAt");

		expectTypeOf<TriageIssue["reason"]>().toBeString();
		expectTypeOf<TriageIssue["relatedTaskIds"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<TriageIssue["detectedAt"]>().toEqualTypeOf<Date>();
	});

	test("TriageReport has correct structure", () => {
		expectTypeOf<TriageReport>().toHaveProperty("timestamp");
		expectTypeOf<TriageReport>().toHaveProperty("healthScore");
		expectTypeOf<TriageReport>().toHaveProperty("ticketCoverage");
		expectTypeOf<TriageReport>().toHaveProperty("issueCount");
		expectTypeOf<TriageReport>().toHaveProperty("pendingTasks");
		expectTypeOf<TriageReport>().toHaveProperty("failedTasks");
		expectTypeOf<TriageReport>().toHaveProperty("totalTasks");

		expectTypeOf<TriageReport["timestamp"]>().toEqualTypeOf<Date>();
		expectTypeOf<TriageReport["healthScore"]>().toBeNumber();
		expectTypeOf<TriageReport["ticketCoverage"]>().toBeNumber();
		expectTypeOf<TriageReport["pendingTasks"]>().toBeNumber();
		expectTypeOf<TriageReport["failedTasks"]>().toBeNumber();
		expectTypeOf<TriageReport["totalTasks"]>().toBeNumber();
	});
});

describe("ResearchConclusion type tests", () => {
	test("ResearchConclusion has correct structure", () => {
		expectTypeOf<ResearchConclusion>().toHaveProperty("outcome");
		expectTypeOf<ResearchConclusion>().toHaveProperty("rationale");
		expectTypeOf<ResearchConclusion>().toHaveProperty("noveltyScore");
		expectTypeOf<ResearchConclusion>().toHaveProperty("proposalsGenerated");
		expectTypeOf<ResearchConclusion>().toHaveProperty("concludedAt");

		expectTypeOf<ResearchConclusion["outcome"]>().toEqualTypeOf<"implement" | "no_go" | "insufficient" | "absorbed">();
		expectTypeOf<ResearchConclusion["rationale"]>().toBeString();
		expectTypeOf<ResearchConclusion["noveltyScore"]>().toBeNumber();
		expectTypeOf<ResearchConclusion["proposalsGenerated"]>().toBeNumber();
		expectTypeOf<ResearchConclusion["linkedDecisionId"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<ResearchConclusion["linkedTaskIds"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<ResearchConclusion["concludedAt"]>().toBeString();
	});
});

describe("Duplicate type definitions - types.ts vs task-schema.ts", () => {
	test("TaskType from types.ts (feature classification)", () => {
		type ExpectedFeatureTaskType = "feature" | "bugfix" | "refactor" | "docs" | "test" | "chore" | "unknown";

		expectTypeOf<FeatureTaskType>().toEqualTypeOf<ExpectedFeatureTaskType>();

		// Positive tests
		expectTypeOf<"feature">().toMatchTypeOf<FeatureTaskType>();
		expectTypeOf<"bugfix">().toMatchTypeOf<FeatureTaskType>();
		expectTypeOf<"refactor">().toMatchTypeOf<FeatureTaskType>();

		// @ts-expect-error - invalid feature type
		expectTypeOf<"invalid_feature_type">().toMatchTypeOf<FeatureTaskType>();
	});

	test("TaskType from task-schema.ts (execution classification)", () => {
		type ExpectedExecutionTaskType = "meta" | "research" | "implementation";

		expectTypeOf<ExecutionTaskType>().toEqualTypeOf<ExpectedExecutionTaskType>();

		// Positive tests
		expectTypeOf<"meta">().toMatchTypeOf<ExecutionTaskType>();
		expectTypeOf<"research">().toMatchTypeOf<ExecutionTaskType>();
		expectTypeOf<"implementation">().toMatchTypeOf<ExecutionTaskType>();

		// @ts-expect-error - invalid execution type
		expectTypeOf<"invalid_execution_type">().toMatchTypeOf<ExecutionTaskType>();
	});

	test("MetaTaskType from task-schema.ts", () => {
		type ExpectedMetaTaskType = "triage" | "prune" | "plan" | "prioritize" | "generate";

		expectTypeOf<SchemaMetaTaskType>().toEqualTypeOf<ExpectedMetaTaskType>();

		// Positive tests
		expectTypeOf<"triage">().toMatchTypeOf<SchemaMetaTaskType>();
		expectTypeOf<"plan">().toMatchTypeOf<SchemaMetaTaskType>();

		// @ts-expect-error - invalid meta task type
		expectTypeOf<"invalid_meta">().toMatchTypeOf<SchemaMetaTaskType>();
	});

	test("MetaTaskAction from task-schema.ts", () => {
		type ExpectedMetaTaskAction =
			| "remove"
			| "complete"
			| "fix_status"
			| "merge"
			| "add"
			| "update"
			| "prioritize"
			| "decompose"
			| "block"
			| "unblock";

		expectTypeOf<SchemaMetaTaskAction>().toEqualTypeOf<ExpectedMetaTaskAction>();

		// Positive tests
		expectTypeOf<"remove">().toMatchTypeOf<SchemaMetaTaskAction>();
		expectTypeOf<"add">().toMatchTypeOf<SchemaMetaTaskAction>();

		// @ts-expect-error - invalid action
		expectTypeOf<"invalid_action">().toMatchTypeOf<SchemaMetaTaskAction>();
	});

	test("MetaTaskRecommendation from task-schema.ts", () => {
		expectTypeOf<SchemaMetaTaskRecommendation>().toHaveProperty("action");
		expectTypeOf<SchemaMetaTaskRecommendation>().toHaveProperty("reason");
		expectTypeOf<SchemaMetaTaskRecommendation>().toHaveProperty("confidence");

		expectTypeOf<SchemaMetaTaskRecommendation["action"]>().toEqualTypeOf<SchemaMetaTaskAction>();
		expectTypeOf<SchemaMetaTaskRecommendation["taskId"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<SchemaMetaTaskRecommendation["relatedTaskIds"]>().toEqualTypeOf<string[] | undefined>();
		expectTypeOf<SchemaMetaTaskRecommendation["reason"]>().toBeString();
		expectTypeOf<SchemaMetaTaskRecommendation["confidence"]>().toBeNumber();
	});
});

describe("TaskCategory and TaskStatus from task-schema.ts", () => {
	test("TaskCategory has correct values", () => {
		// Sample of expected categories
		expectTypeOf<"meta:triage">().toMatchTypeOf<TaskCategory>();
		expectTypeOf<"plan">().toMatchTypeOf<TaskCategory>();
		expectTypeOf<"research">().toMatchTypeOf<TaskCategory>();
		expectTypeOf<"refactor">().toMatchTypeOf<TaskCategory>();
		expectTypeOf<"test">().toMatchTypeOf<TaskCategory>();

		// @ts-expect-error - invalid category
		expectTypeOf<"invalid_category">().toMatchTypeOf<TaskCategory>();
	});

	test("TaskStatus from task-schema.ts matches expected union", () => {
		type ExpectedSchemaStatus =
			| "pending"
			| "in_progress"
			| "decomposed"
			| "complete"
			| "failed"
			| "blocked"
			| "duplicate"
			| "canceled"
			| "obsolete";

		expectTypeOf<SchemaTaskStatus>().toEqualTypeOf<ExpectedSchemaStatus>();

		// Should match Task status from task.ts
		expectTypeOf<SchemaTaskStatus>().toEqualTypeOf<Task["status"]>();
	});
});
