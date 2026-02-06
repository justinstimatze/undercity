# Type Testing Survey

Survey of critical TypeScript types and interfaces in `src/` that need type-level testing.

## Categories

1. [Storage Types](#1-storage-types) - SQLite schema mappings and JSON persistence
2. [Task Types](#2-task-types) - Task state machine, status unions, and domain objects
3. [Validation Types](#3-validation-types) - Security, sanitization, and Zod schemas
4. [Routing Types](#4-routing-types) - Model routing, complexity assessment, self-tuning
5. [Context Types](#5-context-types) - Agent context, knowledge, and decision tracking
6. [Worker/Orchestrator Types](#6-workerorchestrator-types) - Execution state, hooks, and results
7. [RAG Types](#7-rag-types) - Document, chunk, and search types

---

## 1. Storage Types

Types at the SQLite boundary where TypeScript objects are serialized/deserialized.

### `TaskRecord` / `TaskRow`
- **File:** `src/storage.ts` (line 2295 / 2327)
- **Purpose:** Database-facing task record. `TaskRow` maps raw SQLite columns (snake_case, JSON strings, `number | null`) to `TaskRecord` (camelCase, parsed arrays, `undefined`). The `rowToTask()` function performs `JSON.parse()` casts on 10+ columns.
- **Why test:** The `TaskRow` -> `TaskRecord` conversion uses unchecked `as` casts on every `JSON.parse()` call (e.g., `JSON.parse(row.package_hints) as string[]`). A schema migration that adds/removes a column or changes a JSON shape will silently produce runtime mismatches. Type tests should verify that `TaskRecord` fields align with `TaskRow` fields after transformation.
- **Risk if untested:** HIGH - Data corruption on read from SQLite. Every task operation depends on this conversion.
- **Existing validation:** None. Raw `as` casts only.

### `TaskStatus`
- **File:** `src/storage.ts` (line 2254)
- **Purpose:** Union type of 9 valid task statuses: `"pending" | "in_progress" | "decomposed" | "complete" | "failed" | "blocked" | "duplicate" | "canceled" | "obsolete"`.
- **Why test:** This union is duplicated in `src/task.ts` (Task.status) with the same 9 variants. A type test should verify both unions remain synchronized. Adding a status to one but not the other causes silent type narrowing failures.
- **Risk if untested:** MEDIUM - Status mismatch between storage layer and API layer.
- **Existing validation:** None. The `rowToTask` function uses `row.status as TaskStatus` unchecked cast.

### `LearningRow` / `Learning`
- **File:** `src/storage.ts` (line 557) / `src/knowledge.ts` (line 35)
- **Purpose:** SQLite row type mapped to the `Learning` domain type. `rowToLearning()` converts snake_case columns and parses JSON.
- **Why test:** `keywords` stored as JSON string, parsed with `JSON.parse(row.keywords) as string[]`. The `category` field is cast with `row.category as LearningCategory` without validation.
- **Risk if untested:** MEDIUM - Corrupted learning data or category misclassification.
- **Existing validation:** `validateKnowledgeBase()` exists for the full knowledge base but not individual rows.

### `ErrorPatternRow` / `ErrorFixRow` / `ErrorPattern` / `ErrorFix`
- **File:** `src/storage.ts` (lines 592-631)
- **Purpose:** Error pattern tracking with fixes. Row types map to domain types with JSON array fields.
- **Why test:** `files_changed` stored as JSON string. The mapping function performs unchecked `JSON.parse()` casts.
- **Risk if untested:** LOW - Error patterns are informational, not execution-critical.
- **Existing validation:** None.

### `DecisionRow` / `DecisionResolutionRow`
- **File:** `src/storage.ts` (lines 767-786)
- **Purpose:** SQLite row types for the decision tracking system. Maps to `DecisionPoint` and `DecisionResolution`.
- **Why test:** `options` and `keywords` are JSON-serialized. The `category` field uses `as DecisionCategory` cast. The `resolved_by` field uses `as "auto" | "pm" | "human"` cast. The `outcome` field uses `as "success" | "failure" | "pending"` cast.
- **Risk if untested:** MEDIUM - Decision system integrity; incorrect casts could affect PM automation.
- **Existing validation:** Type guard `isDecisionPoint()` exists in `automated-pm.ts`.

### `PermanentFailure` / `PendingErrorDB`
- **File:** `src/storage.ts` (lines 1148, 1229)
- **Purpose:** Permanent failure tracking and pending error resolution.
- **Why test:** `filesAttempted` and `detailedErrors` stored as JSON arrays.
- **Risk if untested:** LOW - Informational tracking.

### `TaskFileRecord`
- **File:** `src/storage.ts` (line 976)
- **Purpose:** Records task-to-file relationships for pattern matching.
- **Why test:** `filesModified` and `keywords` stored as JSON arrays.
- **Risk if untested:** LOW - Used for file prediction, not execution-critical.

### `HumanOverrideDB`
- **File:** `src/storage.ts` (line 940)
- **Purpose:** Human override of PM/auto decisions.
- **Why test:** `originalResolver` uses `"auto" | "pm"` union.
- **Risk if untested:** LOW - Audit trail type.

---

## 2. Task Types

Core domain types for the task management system.

### `Task`
- **File:** `src/task.ts` (line 60)
- **Purpose:** Primary task domain object with 30+ fields. Contains status union, optional sub-objects (`HandoffContext`, `LastAttemptContext`, `ResearchConclusion`, `TicketContent`, `TriageIssue[]`), and computed fields.
- **Why test:** The `status` field is a 9-variant union that must stay synchronized with `TaskStatus` in storage.ts. The `Task` type uses `Date` objects while `TaskRecord` uses ISO strings -- type tests should verify the `recordToTask()` and `taskToRecord()` transformations are lossless. Multiple optional nested types create combinatorial complexity.
- **Risk if untested:** HIGH - Central domain type; every subsystem depends on it.
- **Existing validation:** `isTaskObjectiveSafe()` validates objectives only, not structure.

### `HandoffContext`
- **File:** `src/task.ts` (line 142)
- **Purpose:** Context passed from Claude Code sessions to workers. Contains nested `LastAttemptContext`.
- **Why test:** This type is defined in both `src/task.ts` and `src/storage.ts` with the same shape but different timestamp types (`Date` vs `string`). Type tests should verify structural compatibility.
- **Risk if untested:** MEDIUM - Context loss during handoff.
- **Existing validation:** None.

### `LastAttemptContext`
- **File:** `src/task.ts` (line 123) / `src/storage.ts` (line 2268)
- **Purpose:** Failed attempt information for retry tasks. Dual definitions with different timestamp representations.
- **Why test:** `attemptedAt` is `Date` in task.ts, `string` in storage.ts. The conversion in `recordToTask()` handles this with `new Date(record.lastAttempt.attemptedAt)`.
- **Risk if untested:** MEDIUM - Incorrect retry context on task resumption.

### `TicketContent`
- **File:** `src/types.ts` (line 1446)
- **Purpose:** Rich ticket metadata attached to tasks. Contains `source` field with 5-variant union.
- **Why test:** The `source` union (`"pm" | "user" | "research" | "codebase_gap" | "pattern_analysis"`) must align with `TaskProposalSourceSchema` in pm-schemas.ts. Stored as JSON in SQLite.
- **Risk if untested:** MEDIUM - Ticket data integrity.
- **Existing validation:** Zod schema in pm-schemas.ts validates proposals but not stored tickets.

### `TriageIssue` / `TriageIssueType` / `TriageAction`
- **File:** `src/types.ts` (lines 1466-1502)
- **Purpose:** Triage analysis results. `TriageIssueType` is a 14-variant union. `TriageAction` is a 6-variant union.
- **Why test:** The `TriageIssueType` union has expanded over time (14 variants including failed-task subtypes). New variants must be handled exhaustively in triage logic. Stored as JSON array in SQLite.
- **Risk if untested:** MEDIUM - Missing triage issue handling.

### `MetaTaskType` / `MetaTaskAction` / `MetaTaskRecommendation` / `MetaTaskResult`
- **File:** `src/types.ts` (lines 1230-1293)
- **Purpose:** Meta-task system types. `MetaTaskType` is a 5-variant union. `MetaTaskAction` is a 10-variant union.
- **Why test:** `MetaTaskType` is defined in both `src/types.ts` and `src/task-schema.ts` -- must stay synchronized. `MetaTaskAction` has 10 variants that determine task board mutations. The `isMetaTask()` and `getMetaTaskType()` regex-based type guards should be tested against the union.
- **Risk if untested:** MEDIUM - Duplicate type definition drift.
- **Existing validation:** Regex-based `isMetaTask()` function (not a TypeScript type guard).

### `TaskCategory` / `TaskType` (task-schema.ts)
- **File:** `src/task-schema.ts` (lines 47, 118)
- **Purpose:** Task routing types. `TaskCategory` is a 28-variant union. `TaskType` is `"meta" | "research" | "implementation"`.
- **Why test:** `TaskCategory` has 28 variants matched against a runtime array `TASK_CATEGORIES`. A type test should verify the union and array stay synchronized. The `extractTaskCategory()` function casts with `prefix as TaskCategory` after array check.
- **Risk if untested:** MEDIUM - Unrecognized task categories silently return null.
- **Existing validation:** Runtime array comparison only.

---

## 3. Validation Types

Security-critical types enforcing runtime constraints.

### `TaskSecurityResult`
- **File:** `src/task-security.ts` (line 25)
- **Purpose:** Result of task objective security validation.
- **Why test:** Boolean `isSafe` flag gates whether tasks enter the system. Type tests should verify the result shape.
- **Risk if untested:** LOW - Simple interface, well-tested at runtime.

### `SecurityPattern` / `SecuritySeverity`
- **File:** `src/task-security.ts` (lines 39-53)
- **Purpose:** Security pattern definitions. `SecuritySeverity` is `"block" | "warn"`. `category` has a 6-variant union.
- **Why test:** The `category` field union (`"shell" | "exfiltration" | "malware" | "sensitive_file" | "capability" | "path_traversal"`) determines how security violations are reported. Adding a category without handling it causes silent drops.
- **Risk if untested:** MEDIUM - Security validation completeness.

### `SanitizationResult`
- **File:** `src/content-sanitizer.ts` (line 38)
- **Purpose:** Result of content sanitization against prompt injection.
- **Why test:** `blocked` boolean determines if content enters the system.
- **Risk if untested:** LOW - Simple interface.

### `PatternSeverity` / `InjectionPattern`
- **File:** `src/content-sanitizer.ts` (lines 21-33)
- **Purpose:** Injection pattern definitions. `PatternSeverity` is `"block" | "strip" | "warn"`.
- **Why test:** Severity determines handling behavior. Must be exhaustively handled.
- **Risk if untested:** MEDIUM - Unhandled severity causes unexpected behavior.

### `TaskProposal` (Zod-derived)
- **File:** `src/pm-schemas.ts` (line 91)
- **Purpose:** Zod-inferred type for task proposals. Validated at runtime by `TaskProposalSchema`.
- **Why test:** The Zod schema enforces min/max lengths, enum values, and array limits. Type tests should verify the inferred TypeScript type matches expectations (e.g., `suggestedPriority` defaults to 500).
- **Risk if untested:** LOW - Runtime validation via Zod already catches mismatches.
- **Existing validation:** Full Zod schema validation.

### `PMResearchResult` / `PMIdeationResult` (Zod-derived)
- **File:** `src/pm-schemas.ts` (lines 117, 137)
- **Purpose:** Zod-inferred types for PM research and ideation outputs.
- **Why test:** Complex nested schemas with array limits and defaults.
- **Risk if untested:** LOW - Zod provides runtime validation.
- **Existing validation:** Full Zod schema validation.

### Structured Output Schemas (Zod-derived)
- **File:** `src/structured-output-schemas.ts`
- **Types:** `ExtractedLearningsOutput`, `DecompositionSubtasksOutput`, `ExecutionPlanOutput`, `PlanReviewOutput`, `PMRefineOutput`
- **Purpose:** Zod schemas converted to JSON Schema for Claude SDK structured output.
- **Why test:** These schemas are converted to JSON Schema via `toJSONSchema()` and must produce valid JSON Schema. The `extractStructuredOutput<T>()` generic helper performs runtime Zod validation.
- **Risk if untested:** MEDIUM - Invalid JSON Schema conversion causes SDK structured output to fail silently, falling back to text parsing.
- **Existing validation:** Zod `safeParse()` at runtime.

---

## 4. Routing Types

Model selection, complexity assessment, and routing profile types.

### `ComplexityLevel`
- **File:** `src/complexity.ts` (line 28)
- **Purpose:** 5-variant union: `"trivial" | "simple" | "standard" | "complex" | "critical"`.
- **Why test:** This type drives model routing, team composition, and resource allocation. It's used across the entire system. The `TeamComposition` interface depends on it. Type tests should verify exhaustive handling.
- **Risk if untested:** HIGH - Model routing depends on this union being exhaustively handled.
- **Existing validation:** None at the type level.

### `ComplexityAssessment`
- **File:** `src/complexity.ts` (line 63)
- **Purpose:** Result of complexity analysis. Contains `level`, `model`, `estimatedScope` (4-variant union), `team` (nested `TeamComposition`), and optional `localTool`.
- **Why test:** `estimatedScope` uses `"single-file" | "few-files" | "many-files" | "cross-package"` union. The `model` field uses `"haiku" | "sonnet" | "opus"` which includes the deprecated "haiku". Type tests should verify the `team` nested interface is consistent.
- **Risk if untested:** MEDIUM - Scope estimation affects resource allocation.

### `TeamComposition`
- **File:** `src/complexity.ts` (line 43)
- **Purpose:** Worker/validator configuration per complexity level.
- **Why test:** Multiple `"haiku" | "sonnet" | "opus"` fields that should be validated against the current `ModelTier` type.
- **Risk if untested:** MEDIUM - Team misconfiguration.

### `RoutingThreshold` / `RoutingProfile`
- **File:** `src/self-tuning.ts` (lines 40, 52)
- **Purpose:** Self-tuning model routing. `RoutingProfile` is persisted to JSON.
- **Why test:** `thresholds` uses `Record<string, RoutingThreshold>` with string keys like `"sonnet:simple"`. Type tests should verify the key format. `modelSuccessRates` uses `Record<ModelTier, number>` which must stay consistent with `ModelTier` changes.
- **Risk if untested:** MEDIUM - Routing profile deserialization.
- **Existing validation:** None. Raw JSON parse.

### `ModelTier` / `ModelChoice` / `HistoricalModelChoice`
- **File:** `src/types.ts` (lines 45, 529, 534)
- **Purpose:** Model selection types. `ModelTier = "sonnet" | "opus"`. `HistoricalModelChoice` adds `"haiku"` for backward compatibility.
- **Why test:** `normalizeModel()` maps haiku->sonnet. Multiple places in the codebase use `"haiku" | "sonnet" | "opus"` inline instead of referencing these types. Type tests should verify `normalizeModel()` handles all variants.
- **Risk if untested:** MEDIUM - Model routing inconsistency.
- **Existing validation:** `normalizeModel()` function, `isValidModelTier()` type guard in config.ts.

### `ErrorCategory`
- **File:** `src/types.ts` (line 650)
- **Purpose:** 10-variant union for error categorization including 4 `no_changes_*` subtypes.
- **Why test:** Exhaustive handling required in verification and metrics. The `no_changes_*` subtypes were added incrementally. Type tests should verify `assertExhaustiveErrorCategory()` in verification.ts handles all variants.
- **Risk if untested:** MEDIUM - New error categories silently unhandled.
- **Existing validation:** `assertExhaustiveErrorCategory()` with `never` type guard in verification.ts.

---

## 5. Context Types

Knowledge, decision tracking, and context-building types.

### `LearningCategory`
- **File:** `src/knowledge.ts` (line 30)
- **Purpose:** 4-variant union: `"pattern" | "gotcha" | "preference" | "fact"`.
- **Why test:** Used in Zod schema `ExtractedLearningsSchema` (structured-output-schemas.ts) and in storage layer casts. Must stay synchronized.
- **Risk if untested:** MEDIUM - Learning misclassification.
- **Existing validation:** Zod enum in ExtractedLearningsSchema.

### `DecisionCategory`
- **File:** `src/decision-tracker.ts` (line 32)
- **Purpose:** 4-variant union: `"auto_handle" | "pm_decidable" | "human_required" | "research_conclusion"`.
- **Why test:** Drives the PM decision routing logic. Storage layer casts with `as DecisionCategory`.
- **Risk if untested:** MEDIUM - Decisions routed to wrong handler.
- **Existing validation:** Regex patterns in `DECISION_PATTERNS` (partial coverage).

### `ConfidenceLevel`
- **File:** `src/decision-tracker.ts` (line 41)
- **Purpose:** 3-variant union: `"high" | "medium" | "low"`.
- **Why test:** Used in `PMDecisionResult` and storage casts.
- **Risk if untested:** LOW - Simple union with existing type guard.
- **Existing validation:** `isPMDecisionResult()` type guard checks valid values.

### `DecisionPoint` / `DecisionResolution` / `HumanOverride` / `DecisionStore`
- **File:** `src/decision-tracker.ts` (lines 46-117)
- **Purpose:** Full decision tracking system types. `DecisionStore` contains pending/resolved/overrides.
- **Why test:** `DecisionPoint` is defined in both `decision-tracker.ts` and `storage.ts`. The `DecisionResolution.resolvedBy` uses `"auto" | "pm" | "human"` union. `DecisionResolution.outcome` uses `"success" | "failure" | "pending"` union.
- **Risk if untested:** MEDIUM - Duplicate type definitions could drift.
- **Existing validation:** `isDecisionPoint()` type guard in automated-pm.ts.

### `PMDecisionResult`
- **File:** `src/automated-pm.ts` (line 160)
- **Purpose:** PM decision output with confidence, escalation flag.
- **Why test:** `isPMDecisionResult()` type guard validates this at runtime.
- **Risk if untested:** LOW - Has existing type guard.
- **Existing validation:** `isPMDecisionResult()` type guard.

### `PlanSection`
- **File:** `src/context.ts` (line 21)
- **Purpose:** Parsed markdown section for context extraction.
- **Why test:** Simple interface, not at a system boundary.
- **Risk if untested:** LOW.

---

## 6. Worker/Orchestrator Types

Execution state management and hook types.

### `SessionStatus` / `StepStatus` / `AgentStatus` / `MergeStatus`
- **File:** `src/types.ts` (lines 14, 63, 94, 142)
- **Purpose:** State machine unions. `SessionStatus` has 8 variants, `StepStatus` has 8, `AgentStatus` has 5, `MergeStatus` has 8.
- **Why test:** These unions define state machines. Type tests should verify exhaustive handling where switch/if chains consume these types. `MergeStatus` determines merge queue behavior.
- **Risk if untested:** HIGH - State machine transitions missing cases cause undefined behavior.
- **Existing validation:** None at type level.

### `MergeQueueItem`
- **File:** `src/types.ts` (line 152)
- **Purpose:** Items in the serial merge queue. 20+ fields including optional retry state.
- **Why test:** Complex interface with `strategyUsed` union (`"theirs" | "ours" | "default"`). Multiple date fields and retry tracking. Used in merge queue processing.
- **Risk if untested:** MEDIUM - Merge queue item structure integrity.

### `ParallelTaskState` / `ParallelRecoveryState`
- **File:** `src/types.ts` (lines 915, 942)
- **Purpose:** Crash recovery state. `ParallelTaskState.status` uses 5-variant union. Persisted to JSON.
- **Why test:** Recovery state is serialized/deserialized from JSON. Status union must align with the recovery logic. Contains nested `TaskCheckpoint`.
- **Risk if untested:** HIGH - Crash recovery data corruption.

### `TaskCheckpoint`
- **File:** `src/types.ts` (line 1329)
- **Purpose:** Checkpoint for crash recovery. `phase` is a 6-variant union.
- **Why test:** Phase tracking determines where to resume after crash. Union must be exhaustively handled in recovery logic.
- **Risk if untested:** HIGH - Incorrect checkpoint phase causes infinite loops or skipped work on recovery.

### `ActiveTaskState` / `CompletedTaskState` / `BatchMetadata`
- **File:** `src/types.ts` (lines 991, 1014, 971)
- **Purpose:** Atomic recovery types. `ActiveTaskState.status` is `"pending" | "running"`. `CompletedTaskState.status` is `"complete" | "failed" | "merged"`.
- **Why test:** The status unions for active vs completed are disjoint by design. Type tests should verify they don't overlap and together cover all terminal states.
- **Risk if untested:** MEDIUM - Recovery state machine correctness.

### `ProjectProfile`
- **File:** `src/types.ts` (line 1348)
- **Purpose:** Detected project configuration for verification commands. Contains `packageManager` (4-variant), `testRunner` (4-variant), `linter` (3-variant), `buildTool` (5-variant) unions.
- **Why test:** Multiple small unions that must be exhaustively handled in verification.ts command construction.
- **Risk if untested:** MEDIUM - Verification commands wrong for project type.

### `OutputEvent`
- **File:** `src/output.ts` (line 19)
- **Purpose:** Structured event for agent-mode output. `type` field is a 12-variant union.
- **Why test:** The event type union determines JSON output format for machine consumers. New event types must be handled in output formatting.
- **Risk if untested:** LOW - Output formatting, not execution-critical.

### `TaskAssignment`
- **File:** `src/types.ts` (line 1301)
- **Purpose:** Assignment written to worktree before worker starts. Contains `ModelChoice`, checkpoint state.
- **Why test:** Persisted to JSON in worktree. Must survive crash/restart cycle.
- **Risk if untested:** MEDIUM - Worker identity and resumption.

---

## 7. RAG Types

Retrieval-augmented generation system types.

### `Document` / `Chunk` / `SearchResult` / `IndexResult`
- **File:** `src/rag/types.ts` (lines 11-62)
- **Purpose:** Core RAG data model. `Document.metadata` and `Chunk.metadata` use `Record<string, unknown>`.
- **Why test:** `metadata` fields accept arbitrary data. `DocumentRow` and `ChunkRow` are SQLite mappings with snake_case columns.
- **Risk if untested:** LOW - RAG is supplementary, not execution-critical.

### `DocumentRow` / `ChunkRow`
- **File:** `src/rag/types.ts` (lines 96+)
- **Purpose:** SQLite row types for RAG database.
- **Why test:** Row-to-domain conversion has similar JSON parse risks as main storage types.
- **Risk if untested:** LOW - RAG data integrity.

---

## Priority Matrix

Types ranked by testing priority based on risk, system criticality, and existing validation gaps.

### P0 - Must Test (HIGH risk, no existing validation)

| Type | File | Reason |
|------|------|--------|
| `TaskRecord` / `TaskRow` | `storage.ts` | 10+ unchecked JSON.parse casts at SQLite boundary |
| `Task.status` / `TaskStatus` | `task.ts` / `storage.ts` | Duplicate 9-variant union, no sync verification |
| `SessionStatus` | `types.ts` | 8-variant state machine, no exhaustive check |
| `StepStatus` | `types.ts` | 8-variant state machine, no exhaustive check |
| `MergeStatus` | `types.ts` | 8-variant state machine, drives merge queue |
| `TaskCheckpoint.phase` | `types.ts` | 6-variant union, crash recovery depends on it |
| `ParallelTaskState.status` | `types.ts` | 5-variant union, crash recovery state |

### P1 - Should Test (MEDIUM risk, partial or no validation)

| Type | File | Reason |
|------|------|--------|
| `ErrorCategory` | `types.ts` | 10-variant union with incremental additions |
| `ComplexityLevel` | `complexity.ts` | 5-variant union driving model routing |
| `MetaTaskType` (dual definition) | `types.ts` / `task-schema.ts` | Duplicate definition, regex-based guards |
| `MetaTaskAction` | `types.ts` | 10-variant union for board mutations |
| `TriageIssueType` | `types.ts` | 14-variant union, expanding over time |
| `TaskCategory` | `task-schema.ts` | 28-variant union, runtime array sync required |
| `DecisionCategory` | `decision-tracker.ts` | 4-variant union, drives PM routing |
| `LearningCategory` | `knowledge.ts` | 4-variant union, Zod and storage must sync |
| `HandoffContext` (dual definition) | `task.ts` / `storage.ts` | Different timestamp types |
| `ModelTier` / `ModelChoice` | `types.ts` | Multiple inline unions across codebase |
| `ActiveTaskState.status` / `CompletedTaskState.status` | `types.ts` | Disjoint status unions for recovery |
| `SecuritySeverity` / `SecurityPattern.category` | `task-security.ts` | Security severity exhaustive handling |
| `PatternSeverity` | `content-sanitizer.ts` | Injection severity exhaustive handling |
| `RoutingProfile` | `self-tuning.ts` | JSON persistence with Record key format |
| Structured output Zod schemas | `structured-output-schemas.ts` | JSON Schema conversion correctness |

### P2 - Nice to Test (LOW risk, or has existing Zod validation)

| Type | File | Reason |
|------|------|--------|
| `TaskProposal` | `pm-schemas.ts` | Has full Zod validation |
| `PMResearchResult` | `pm-schemas.ts` | Has full Zod validation |
| `PMDecisionResult` | `automated-pm.ts` | Has `isPMDecisionResult()` type guard |
| `DecisionPoint` | `decision-tracker.ts` | Has `isDecisionPoint()` type guard |
| `ConfidenceLevel` | `decision-tracker.ts` | Simple 3-variant union with guard |
| `OutputEvent.type` | `output.ts` | 12-variant union, output formatting |
| RAG types | `rag/types.ts` | Supplementary system |
| `ErrorFix` / `ErrorPattern` | `storage.ts` | Informational tracking |
| `PermanentFailure` | `storage.ts` | Informational tracking |

---

## Recommended Type Test Approaches

### 1. Union Synchronization Tests
Verify duplicate unions stay in sync:
```typescript
// Verify Task.status and TaskStatus have the same variants
type AssertStatusSync = Expect<Equal<Task["status"], TaskStatus>>;
```

### 2. Exhaustive Handling Tests
Verify all variants of a union are handled:
```typescript
// Verify a switch covers all MergeStatus variants
function assertExhaustive(status: MergeStatus): string {
  switch (status) {
    case "pending": return "p";
    // ... all cases
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
```

### 3. Storage Boundary Tests
Verify TaskRow -> TaskRecord conversion preserves types:
```typescript
// Verify all TaskRecord keys have corresponding TaskRow columns
type AssertRecordKeys = Expect<
  keyof TaskRecord extends string ? true : false
>;
```

### 4. Zod Schema Alignment Tests
Verify Zod-inferred types match expected interfaces:
```typescript
// Verify TaskProposal matches expected shape
type AssertProposal = Expect<
  Equal<TaskProposal["source"], "research" | "pattern_analysis" | "codebase_gap" | "user_request">
>;
```

### 5. Disjoint Union Tests
Verify recovery state unions don't overlap:
```typescript
// ActiveTaskState.status and CompletedTaskState.status should be disjoint
type ActiveStatuses = ActiveTaskState["status"];
type CompletedStatuses = CompletedTaskState["status"];
type Overlap = Extract<ActiveStatuses, CompletedStatuses>;
type AssertDisjoint = Expect<Equal<Overlap, never>>;
```
