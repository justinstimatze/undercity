/**
 * Grind Event Logger
 *
 * Structured event logging optimized for post-grind analysis.
 * Writes to .undercity/grind-events.jsonl.
 *
 * Design principles:
 * - Events should be actionable (why did X happen?)
 * - Failures include root cause and context
 * - Minimal noise (no redundant fields)
 * - Token usage tracked for cost analysis
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UNDERCITY_DIR = ".undercity";
const EVENTS_FILE = "grind-events.jsonl";
const MAX_EVENTS = 1000;

/**
 * Failure reasons - categorized for easy filtering
 */
export type FailureReason =
	| "no_changes" // Agent finished without modifying files
	| "verification_typecheck" // TypeScript errors
	| "verification_tests" // Test failures
	| "verification_lint" // Lint errors
	| "verification_build" // Build failed
	| "planning" // Failed during plan creation/review
	| "decomposition" // Failed during task decomposition
	| "max_attempts" // Exhausted all attempts
	| "rebase_conflict" // Conflict during rebase
	| "merge_conflict" // Conflict during merge
	| "timeout" // Agent timed out
	| "rate_limit" // Hit API rate limits
	| "agent_error" // Agent threw an error
	| "unknown"; // Uncategorized

/**
 * Event types - minimal set for what matters
 */
export type GrindEventType =
	| "grind_start"
	| "grind_end"
	| "task_start"
	| "task_complete"
	| "task_failed"
	| "task_escalated"
	| "rate_limit";

/**
 * Base event structure
 */
interface BaseEvent {
	ts: string; // ISO timestamp
	type: GrindEventType;
	batch?: string; // Batch ID
	task?: string; // Task ID
}

/**
 * Grind session start
 */
interface GrindStartEvent extends BaseEvent {
	type: "grind_start";
	tasks: number;
	parallelism: number;
	models: Record<string, number>; // e.g., { haiku: 3, sonnet: 2 }
	pid?: number; // Process ID for liveness check
}

/**
 * Grind session end
 */
interface GrindEndEvent extends BaseEvent {
	type: "grind_end";
	ok: number; // Successful
	fail: number; // Failed
	merged: number; // Merged to main
	mins: number; // Duration in minutes
	tokens?: number; // Total tokens used
}

/**
 * Task started
 */
interface TaskStartEvent extends BaseEvent {
	type: "task_start";
	model: string;
	obj: string; // Objective (truncated)
}

/**
 * Task completed successfully
 */
interface TaskCompleteEvent extends BaseEvent {
	type: "task_complete";
	model: string;
	attempts: number;
	files: number;
	tokens: number;
	secs: number;
	sha?: string;
	escalations?: string[]; // e.g., ["sonnet→opus@2"]
}

/**
 * Task failed
 */
interface TaskFailedEvent extends BaseEvent {
	type: "task_failed";
	reason: FailureReason;
	model: string;
	attempts: number;
	escalations?: string[]; // e.g., ["haiku→sonnet@2"]
	tokens: number;
	secs: number;
	error?: string; // First line of error
}

/**
 * Model escalation during task
 */
interface TaskEscalatedEvent extends BaseEvent {
	type: "task_escalated";
	from: string;
	to: string;
	attempt: number;
	why: string; // Escalation reason
}

/**
 * Rate limit hit
 */
interface RateLimitEvent extends BaseEvent {
	type: "rate_limit";
	model: string;
	wait?: number; // Wait time in seconds
}

type GrindEvent =
	| GrindStartEvent
	| GrindEndEvent
	| TaskStartEvent
	| TaskCompleteEvent
	| TaskFailedEvent
	| TaskEscalatedEvent
	| RateLimitEvent;

function getEventsPath(): string {
	return join(process.cwd(), UNDERCITY_DIR, EVENTS_FILE);
}

function ensureDir(): void {
	const dir = join(process.cwd(), UNDERCITY_DIR);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function writeEvent(event: GrindEvent): void {
	ensureDir();
	appendFileSync(getEventsPath(), `${JSON.stringify(event)}\n`);
}

/**
 * Categorize an error string into a failure reason
 */
export function categorizeFailure(error: string): FailureReason {
	const e = error.toLowerCase();

	// Check for planning-phase failures first (these have specific markers)
	if (e.includes("plan_rejected") || e.includes("plan rejected") || e.includes("planning failed")) {
		return "planning";
	}
	if (e.includes("needs_decomposition") || e.includes("decomposition failed") || e.includes("parent task not found")) {
		return "decomposition";
	}
	if (e.includes("0 writes") || e.includes("no changes") || e.includes("no_changes")) {
		return "no_changes";
	}
	if (e.includes("typecheck") || e.includes("tsc") || e.includes("type error")) {
		return "verification_typecheck";
	}
	if (e.includes("test") && (e.includes("fail") || e.includes("error"))) {
		return "verification_tests";
	}
	if (e.includes("lint") || e.includes("biome")) {
		return "verification_lint";
	}
	if (e.includes("build")) {
		return "verification_build";
	}
	if (e.includes("rebase")) {
		return "rebase_conflict";
	}
	if (e.includes("merge") && (e.includes("conflict") || e.includes("failed") || e.includes("ff-only"))) {
		return "merge_conflict";
	}
	if (e.includes("timeout")) {
		return "timeout";
	}
	if (e.includes("rate limit") || e.includes("429")) {
		return "rate_limit";
	}
	if (e.includes("max attempts") || e.includes("exhausted")) {
		return "max_attempts";
	}
	// Agent SDK or execution errors
	if (e.includes("agent") && (e.includes("error") || e.includes("crash") || e.includes("stopped"))) {
		return "agent_error";
	}
	// Tier-level errors that don't match specific patterns
	if (e.includes("tier error")) {
		return "agent_error";
	}
	// Invalid target (file/function doesn't exist)
	if (e.includes("invalid_target") || e.includes("file not found") || e.includes("does not exist")) {
		return "agent_error";
	}

	return "unknown";
}

/**
 * Extract first meaningful line from error
 */
function firstLine(error: string): string {
	const lines = error.split("\n").filter((l) => l.trim());
	const first = lines[0] || error;
	return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

// ============== Public API ==============

export function logGrindStart(options: {
	batchId: string;
	taskCount: number;
	parallelism: number;
	modelDistribution?: Record<string, number>;
}): void {
	rotateIfNeeded();
	writeEvent({
		ts: new Date().toISOString(),
		type: "grind_start",
		batch: options.batchId,
		tasks: options.taskCount,
		parallelism: options.parallelism,
		models: options.modelDistribution || {},
		pid: process.pid,
	});
}

export function logGrindEnd(options: {
	batchId: string;
	successful: number;
	failed: number;
	merged: number;
	durationMs: number;
	totalTokens?: number;
}): void {
	writeEvent({
		ts: new Date().toISOString(),
		type: "grind_end",
		batch: options.batchId,
		ok: options.successful,
		fail: options.failed,
		merged: options.merged,
		mins: Math.round(options.durationMs / 60000),
		tokens: options.totalTokens,
	});
}

export function logTaskStart(options: { batchId: string; taskId: string; objective: string; model: string }): void {
	writeEvent({
		ts: new Date().toISOString(),
		type: "task_start",
		batch: options.batchId,
		task: options.taskId,
		model: options.model,
		obj: options.objective.length > 80 ? `${options.objective.slice(0, 77)}...` : options.objective,
	});
}

export function logTaskComplete(options: {
	batchId: string;
	taskId: string;
	model: string;
	attempts: number;
	fileCount: number;
	tokens: number;
	durationMs: number;
	commitSha?: string;
}): void {
	writeEvent({
		ts: new Date().toISOString(),
		type: "task_complete",
		batch: options.batchId,
		task: options.taskId,
		model: options.model,
		attempts: options.attempts,
		files: options.fileCount,
		tokens: options.tokens,
		secs: Math.round(options.durationMs / 1000),
		sha: options.commitSha?.slice(0, 7),
	});
}

export function logTaskFailed(options: {
	batchId: string;
	taskId: string;
	error: string;
	model: string;
	attempts: number;
	escalations?: string[];
	tokens: number;
	durationMs: number;
}): void {
	writeEvent({
		ts: new Date().toISOString(),
		type: "task_failed",
		batch: options.batchId,
		task: options.taskId,
		reason: categorizeFailure(options.error),
		model: options.model,
		attempts: options.attempts,
		escalations: options.escalations?.length ? options.escalations : undefined,
		tokens: options.tokens,
		secs: Math.round(options.durationMs / 1000),
		error: firstLine(options.error),
	});
}

export function logTaskEscalated(options: {
	batchId: string;
	taskId: string;
	from: string;
	to: string;
	attempt: number;
	reason: string;
}): void {
	writeEvent({
		ts: new Date().toISOString(),
		type: "task_escalated",
		batch: options.batchId,
		task: options.taskId,
		from: options.from,
		to: options.to,
		attempt: options.attempt,
		why: options.reason,
	});
}

export function logRateLimit(options: { batchId?: string; model: string; waitSeconds?: number }): void {
	writeEvent({
		ts: new Date().toISOString(),
		type: "rate_limit",
		batch: options.batchId,
		model: options.model,
		wait: options.waitSeconds,
	});
}

// ============== Reading Events ==============

export function readRecentEvents(count = 50): GrindEvent[] {
	const path = getEventsPath();
	if (!existsSync(path)) return [];

	const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
	return lines.slice(-count).map((line) => {
		try {
			return JSON.parse(line) as GrindEvent;
		} catch {
			return { ts: new Date().toISOString(), type: "grind_end", ok: 0, fail: 0, merged: 0, mins: 0 } as GrindEndEvent;
		}
	});
}

export function getLastGrindSummary(): {
	batchId?: string;
	startedAt?: string;
	endedAt?: string;
	pid?: number;
	ok: number;
	fail: number;
	merged: number;
	tokens: number;
	failureBreakdown: Record<FailureReason, number>;
	escalations: {
		total: number;
		tasksWithEscalation: number;
		byPath: Record<string, number>; // e.g., "sonnet→opus": 3
	};
	modelUsage: {
		byModel: Record<string, number>; // e.g., { opus: 3, sonnet: 2 }
		taskModels: Array<{ taskId: string; model: string }>; // actual model used per task
	};
} | null {
	const events = readRecentEvents(500);
	if (!events.length) return null;

	// Find last grind_start
	let startIdx = -1;
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].type === "grind_start") {
			startIdx = i;
			break;
		}
	}
	if (startIdx === -1) return null;

	const session = events.slice(startIdx);
	const start = session[0] as GrindStartEvent;
	const end = session.find((e) => e.type === "grind_end") as GrindEndEvent | undefined;

	const failures = session.filter((e) => e.type === "task_failed") as TaskFailedEvent[];
	const completes = session.filter((e) => e.type === "task_complete") as TaskCompleteEvent[];

	const failureBreakdown: Record<FailureReason, number> = {
		no_changes: 0,
		verification_typecheck: 0,
		verification_tests: 0,
		verification_lint: 0,
		verification_build: 0,
		planning: 0,
		decomposition: 0,
		max_attempts: 0,
		rebase_conflict: 0,
		merge_conflict: 0,
		timeout: 0,
		rate_limit: 0,
		agent_error: 0,
		unknown: 0,
	};

	for (const f of failures) {
		failureBreakdown[f.reason]++;
	}

	// Track escalations from complete events
	const escalations = {
		total: 0,
		tasksWithEscalation: 0,
		byPath: {} as Record<string, number>,
	};

	for (const c of completes) {
		if (c.escalations && c.escalations.length > 0) {
			escalations.tasksWithEscalation++;
			for (const esc of c.escalations) {
				escalations.total++;
				// Parse escalation string like "haiku→sonnet@2" to get just the path
				const path = esc.split("@")[0];
				escalations.byPath[path] = (escalations.byPath[path] ?? 0) + 1;
			}
		}
	}

	const totalTokens = completes.reduce((sum, c) => sum + c.tokens, 0) + failures.reduce((sum, f) => sum + f.tokens, 0);

	// Track actual model usage (not just escalations)
	const modelUsage = {
		byModel: {} as Record<string, number>,
		taskModels: [] as Array<{ taskId: string; model: string }>,
	};

	// Use task_complete events for final model used (after any escalations)
	for (const c of completes) {
		modelUsage.byModel[c.model] = (modelUsage.byModel[c.model] ?? 0) + 1;
		modelUsage.taskModels.push({ taskId: c.task ?? "unknown", model: c.model });
	}
	for (const f of failures) {
		modelUsage.byModel[f.model] = (modelUsage.byModel[f.model] ?? 0) + 1;
		modelUsage.taskModels.push({ taskId: f.task ?? "unknown", model: f.model });
	}

	return {
		batchId: start.batch,
		startedAt: start.ts,
		endedAt: end?.ts,
		pid: start.pid,
		ok: end?.ok ?? completes.length,
		fail: end?.fail ?? failures.length,
		merged: end?.merged ?? 0,
		tokens: totalTokens,
		failureBreakdown,
		escalations,
		modelUsage,
	};
}

function rotateIfNeeded(): void {
	const path = getEventsPath();
	if (!existsSync(path)) return;

	const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
	if (lines.length > MAX_EVENTS) {
		writeFileSync(path, `${lines.slice(-Math.floor(MAX_EVENTS / 2)).join("\n")}\n`);
	}
}

export function clearEvents(): void {
	const path = getEventsPath();
	if (existsSync(path)) writeFileSync(path, "");
}

// ============== Legacy API (for backwards compatibility) ==============
// These wrap the new API to avoid breaking existing callers

export function startGrindSession(options: {
	batchId: string;
	taskCount: number;
	maxCount?: number;
	parallelism: number;
	modelDistribution?: Record<string, number>;
}): void {
	logGrindStart(options);
}

export function endGrindSession(options: {
	batchId: string;
	successful: number;
	failed: number;
	merged: number;
	durationMs: number;
}): void {
	logGrindEnd(options);
}

export function logTaskQueued(_options: {
	batchId: string;
	taskId: string;
	objective: string;
	recommendedModel: string;
}): void {
	// Removed - adds noise without value
}

export function logTaskDecomposed(_options: {
	batchId: string;
	taskId: string;
	originalObjective: string;
	subtaskCount: number;
	subtasks: Array<{ objective: string }>;
	reasoning: string;
}): void {
	// Removed - not useful for debugging
}

export function logTaskStarted(options: {
	batchId: string;
	taskId: string;
	objective: string;
	model: string;
	worktreePath?: string;
}): void {
	logTaskStart({
		batchId: options.batchId,
		taskId: options.taskId,
		objective: options.objective,
		model: options.model,
	});
}

export function logTaskProgress(_options: { batchId: string; taskId: string; stage: string; details?: string }): void {
	// Removed - too noisy, not actionable
}

// Legacy logTaskComplete is now the new format (same signature)

// Legacy logTaskFailed - accept old format
export function logTaskFailedLegacy(options: {
	batchId: string;
	taskId: string;
	objective: string;
	error: string;
	durationMs?: number;
	stage?: string;
}): void {
	logTaskFailed({
		batchId: options.batchId,
		taskId: options.taskId,
		error: options.error,
		model: "unknown",
		attempts: 0,
		tokens: 0,
		durationMs: options.durationMs ?? 0,
	});
}

export function logMergeStarted(_options: { batchId: string; taskId: string; branch: string }): void {
	// Removed - merge is part of task lifecycle
}

export function logMergeComplete(_options: { batchId: string; taskId: string }): void {
	// Removed - success logged in task_complete
}

export function logMergeFailed(_options: { batchId: string; taskId: string; error: string }): void {
	// Removed - failure logged in task_failed with merge_conflict reason
}

export function logFastPathComplete(_options: {
	batchId: string;
	taskId: string;
	objective: string;
	durationMs: number;
	modifiedFiles?: string[];
	tool: string;
}): void {
	// Removed - fast path is rare and not useful for debugging
}

export function logFastPathFailed(_options: {
	batchId: string;
	taskId: string;
	objective: string;
	error: string;
	tool: string;
}): void {
	// Removed - fast path fallback is expected behavior
}

export function logRateLimitHit(options: { batchId?: string; model: string; details?: string }): void {
	logRateLimit({ batchId: options.batchId, model: options.model });
}

export function logError(_message: string, _options?: { batchId?: string; taskId?: string; error?: string }): void {
	// Removed - errors are captured in task_failed
}

// Legacy types for backwards compat
export type GrindEventType_Legacy =
	| "grind_start"
	| "grind_complete"
	| "batch_start"
	| "batch_complete"
	| "task_queued"
	| "task_decomposed"
	| "task_started"
	| "task_progress"
	| "task_complete"
	| "task_failed"
	| "fast_path_complete"
	| "fast_path_failed"
	| "merge_started"
	| "merge_complete"
	| "merge_failed"
	| "rate_limit_hit"
	| "error";

/**
 * Check if a process with given PID is still running
 */
function isProcessAlive(pid: number): boolean {
	try {
		// Sending signal 0 tests if process exists without actually signaling it
		process.kill(pid, 0);
		return true;
	} catch {
		// ESRCH = no such process, EPERM = exists but no permission (still alive)
		return false;
	}
}

export function getCurrentGrindStatus(): {
	isRunning: boolean;
	batchId?: string;
	startedAt?: string;
	tasksQueued: number;
	tasksStarted: number;
	tasksComplete: number;
	tasksFailed: number;
	fastPathComplete: number;
	fastPathFailed: number;
	lastEvent?: GrindEvent;
} {
	const summary = getLastGrindSummary();
	if (!summary) {
		return {
			isRunning: false,
			tasksQueued: 0,
			tasksStarted: 0,
			tasksComplete: 0,
			tasksFailed: 0,
			fastPathComplete: 0,
			fastPathFailed: 0,
		};
	}

	// Determine if grind is actually running
	// If no endedAt, check if the process is still alive
	let isRunning = !summary.endedAt;
	if (isRunning && summary.pid) {
		isRunning = isProcessAlive(summary.pid);
	}

	return {
		isRunning,
		batchId: summary.batchId,
		startedAt: summary.startedAt,
		tasksQueued: 0,
		tasksStarted: 0,
		tasksComplete: summary.ok,
		tasksFailed: summary.fail,
		fastPathComplete: 0,
		fastPathFailed: 0,
	};
}
