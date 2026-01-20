/**
 * Command handlers for mixed commands
 * Extracted from mixed.ts to reduce complexity
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { recordAtomicityOutcome } from "../ax-programs.js";
import { getConfigSource, loadConfig } from "../config.js";
import { type OracleCard, UndercityOracle } from "../oracle.js";
import type { TaskResultSummary } from "../output.js";
import * as output from "../output.js";
import { Persistence } from "../persistence.js";
import { RateLimitTracker } from "../rate-limit.js";
import type { LastAttemptContext } from "../task.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Parse duration string (e.g., "6h", "30m", "2.5h") into milliseconds
 * Returns null if invalid format
 */
function parseDuration(duration: string): number | null {
	const match = duration.match(/^(\d+(?:\.\d+)?)(h|m|s)$/i);
	if (!match) {
		return null;
	}

	const value = Number.parseFloat(match[1]);
	const unit = match[2].toLowerCase();

	switch (unit) {
		case "h":
			return value * 60 * 60 * 1000;
		case "m":
			return value * 60 * 1000;
		case "s":
			return value * 1000;
		default:
			return null;
	}
}

/**
 * Format milliseconds into human-readable duration
 */
function formatDuration(ms: number): string {
	const hours = Math.floor(ms / (60 * 60 * 1000));
	const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));

	if (hours > 0 && minutes > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (hours > 0) {
		return `${hours}h`;
	}
	if (minutes > 0) {
		return `${minutes}m`;
	}

	const seconds = Math.floor(ms / 1000);
	return `${seconds}s`;
}

/**
 * Get the absolute path to the grind lock file.
 * Uses process.cwd() to ensure the lock is in the current project's .undercity directory.
 */
function getGrindLockPath(): string {
	return join(process.cwd(), ".undercity", "grind.lock");
}

interface GrindLock {
	pid: number;
	startedAt: string;
}

/**
 * Check if a process is still running
 */
function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Acquire exclusive lock for grind execution
 * Returns true if lock acquired, false if another grind is running
 */
function acquireGrindLock(): { acquired: boolean; existingPid?: number; startedAt?: string } {
	// Check for existing lock
	if (existsSync(getGrindLockPath())) {
		try {
			const lockData: GrindLock = JSON.parse(readFileSync(getGrindLockPath(), "utf-8"));
			// Check if process is still alive
			if (isProcessRunning(lockData.pid)) {
				return { acquired: false, existingPid: lockData.pid, startedAt: lockData.startedAt };
			}
			// Stale lock - process is dead, we can take over
			output.debug(`Removing stale grind lock (PID ${lockData.pid} no longer running)`);
		} catch {
			// Corrupted lock file - remove it
			output.debug("Removing corrupted grind lock file");
		}
	}

	// Create lock file
	const lock: GrindLock = {
		pid: process.pid,
		startedAt: new Date().toISOString(),
	};

	// Ensure directory exists
	const dir = dirname(getGrindLockPath());
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	writeFileSync(getGrindLockPath(), JSON.stringify(lock, null, 2));
	return { acquired: true };
}

/**
 * Release the grind lock
 */
function releaseGrindLock(): void {
	try {
		if (existsSync(getGrindLockPath())) {
			// Only remove if we own the lock
			const lockData: GrindLock = JSON.parse(readFileSync(getGrindLockPath(), "utf-8"));
			if (lockData.pid === process.pid) {
				unlinkSync(getGrindLockPath());
			}
		}
	} catch {
		// Ignore errors during cleanup
	}
}

// Type definitions for command options
export interface GrindOptions {
	count?: string;
	parallel?: string;
	stream?: boolean;
	verbose?: boolean;
	model?: string;
	commit?: boolean;
	typecheck?: boolean;
	review?: boolean;
	decompose?: boolean;
	taskId?: string;
	dryRun?: boolean;
	push?: boolean;
	duration?: string;
	postmortem?: boolean;
	// Verification retry options
	maxAttempts?: string;
	maxRetriesPerTier?: string;
	maxReviewPasses?: string;
	maxOpusReviewPasses?: string;
	// Decomposition depth limit (default: 1, meaning only top-level tasks can be decomposed)
	maxDecompositionDepth?: string;
	// Maximum model tier to escalate to (caps escalation at this tier)
	maxTier?: string;
}

export interface InitOptions {
	directory?: string;
	force?: boolean;
}

export interface OracleOptions {
	count?: string;
	category?: string;
	allCategories?: boolean;
}

export interface ConfigOptions {
	init?: boolean;
}

export interface ServeOptions {
	port?: string;
	grind?: boolean;
}

export interface StatusOptions {
	count?: string;
	human?: boolean;
	events?: boolean;
}

export interface TuningOptions {
	rebuild?: boolean;
	clear?: boolean;
}

export interface UsageOptions {
	login?: boolean;
	clear?: boolean;
	human?: boolean;
}

export interface DecideOptions {
	human?: boolean;
	resolve?: string; // Decision ID to resolve
	decision?: string; // The decision made
	reasoning?: string; // Reasoning for the decision
	list?: boolean; // Just list pending decisions
}

export interface PulseOptions {
	human?: boolean;
	watch?: boolean;
}

export interface BriefOptions {
	human?: boolean;
	hours?: string;
}

export interface KnowledgeOptions {
	human?: boolean;
	stats?: boolean;
	all?: boolean;
	limit?: string;
}

export interface PMOptions {
	research?: boolean;
	propose?: boolean;
	ideate?: boolean;
	add?: boolean;
}

/**
 * Pulse data structure for JSON output
 */
interface PulseData {
	timestamp: string;
	active: Array<{
		taskId: string;
		objective: string;
		elapsed: string;
		elapsedMs: number;
		worktreePath: string;
	}>;
	queue: {
		pending: number;
		inProgress: number;
		completed: number;
		failed: number;
		blocked: number;
	};
	health: {
		rateLimit: {
			fiveHourPercent: number;
			weeklyPercent: number;
			isPaused: boolean;
			resumeAt?: string;
		};
		/** Live usage from claude.ai scraping */
		liveUsage?: {
			fiveHourPercent?: number;
			weeklyPercent?: number;
			observedAt?: string;
			extraUsageEnabled?: boolean;
			extraUsageSpend?: string;
		};
		recentActivity: {
			completedLastHour: number;
			failedLastHour: number;
		};
	};
	pacing: {
		tokenBudget: number;
		tokensUsed: number;
		remaining: number;
		percentUsed: number;
		queueSize: number;
		estimatedTokensPerTask: number;
		sustainablePaceTasksPerHour: number;
	};
	attention: Array<{
		type: "decision" | "failure" | "rate_limit";
		message: string;
		id?: string;
	}>;
}

/**
 * Determine error category from verification result
 */
function getErrorCategoryFromVerification(verification?: {
	typecheckPassed: boolean;
	testsPassed: boolean;
	lintPassed: boolean;
}): string {
	if (!verification) return "unknown";
	if (!verification.typecheckPassed) return "typecheck";
	if (!verification.testsPassed) return "test";
	if (!verification.lintPassed) return "lint";
	return "build";
}

/**
 * Determine error category from task result, including planning failures
 */
function getErrorCategory(
	error?: string,
	verification?: { typecheckPassed: boolean; testsPassed: boolean; lintPassed: boolean },
): string {
	// Check for planning-phase errors first
	if (error) {
		if (error.startsWith("PLAN_REJECTED")) return "planning";
		if (error.startsWith("NEEDS_DECOMPOSITION") || error === "NEEDS_DECOMPOSITION") return "decomposition";
		if (error.includes("already complete")) return "already_complete";
	}
	// Fall back to verification-based categorization
	return getErrorCategoryFromVerification(verification);
}

/**
 * Handle the pulse command - quick state check
 *
 * Shows active workers, queue status, health metrics, and items needing attention.
 * Fits on one screen, designed for quick glances.
 */
export async function handlePulse(options: PulseOptions): Promise<void> {
	const { getAllTasks, getTaskBoardSummary } = await import("../task.js");
	const { getPendingDecisions, getDecisionsByCategory } = await import("../decision-tracker.js");
	const { fetchClaudeUsage } = await import("../claude-usage.js");

	const persistence = new Persistence();
	const savedState = persistence.getRateLimitState();
	const tracker = new RateLimitTracker(savedState ?? undefined);

	// Auto-fetch Claude Max usage from claude.ai (see claude-usage.ts for the sketchy details)
	let liveUsage: {
		fiveHourPercent?: number;
		weeklyPercent?: number;
		observedAt?: string;
		extraUsageEnabled?: boolean;
		extraUsageSpend?: string;
	} | null = null;
	const fetchedUsage = await fetchClaudeUsage();
	if (fetchedUsage.success) {
		liveUsage = {
			fiveHourPercent: fetchedUsage.fiveHourPercent,
			weeklyPercent: fetchedUsage.weeklyPercent,
			observedAt: fetchedUsage.fetchedAt,
			extraUsageEnabled: fetchedUsage.extraUsageEnabled,
			extraUsageSpend: fetchedUsage.extraUsageSpend,
		};
	}

	// Gather data
	const activeWorktrees = persistence.getAllActiveWorktrees();
	const allTasks = getAllTasks();
	const summary = getTaskBoardSummary();
	const pendingDecisions = getPendingDecisions();
	const humanRequiredDecisions = getDecisionsByCategory("human_required");
	const usage = tracker.getUsageSummary();

	// Calculate recent activity (last hour)
	const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
	const recentTasks = allTasks.filter((t) => t.completedAt && new Date(t.completedAt) >= oneHourAgo);
	const completedLastHour = recentTasks.filter((t) => t.status === "complete").length;
	const failedLastHour = recentTasks.filter((t) => t.status === "failed").length;

	// Calculate pacing info
	// Prefer live Claude Max data over stale local tracking
	const config = tracker.getState().config;
	const tokenBudget = config.maxTokensPer5Hours;
	const pendingCount = summary.pending + summary.inProgress;

	// Use live percentages if available, otherwise fall back to local tracking
	const fiveHourPercentUsed =
		liveUsage?.fiveHourPercent ?? Math.round((usage.current.last5HoursSonnet / tokenBudget) * 100);
	const tokensUsed = Math.round((fiveHourPercentUsed / 100) * tokenBudget);
	const remaining = tokenBudget - tokensUsed;

	// Estimate tokens per task from historical data (default 50k if no data)
	const totalTasks = Object.values(usage.modelBreakdown).reduce((sum, m) => sum + m.totalTasks, 0);
	const totalTokens = Object.values(usage.modelBreakdown).reduce((sum, m) => sum + m.sonnetEquivalentTokens, 0);
	const estimatedTokensPerTask = totalTasks > 0 ? Math.round(totalTokens / totalTasks) : 50000;

	// Calculate sustainable pace (tasks per hour to last 5 hours)
	const sustainablePace = estimatedTokensPerTask > 0 ? Math.floor(remaining / estimatedTokensPerTask / 5) : 0;

	// Build active workers list with elapsed time
	const now = Date.now();
	const activeList = activeWorktrees.map((w) => {
		const task = allTasks.find((t) => t.sessionId === w.sessionId);
		const elapsedMs = now - new Date(w.createdAt).getTime();
		const elapsedMin = Math.floor(elapsedMs / 60000);
		return {
			taskId: w.sessionId.split("-").slice(0, 2).join("-"), // Short ID
			objective: task?.objective?.substring(0, 50) || "Unknown task",
			elapsed: `${elapsedMin}m`,
			elapsedMs,
			worktreePath: w.path,
		};
	});

	// Build attention items
	const attention: PulseData["attention"] = [];

	// Add human-required decisions
	for (const dec of humanRequiredDecisions.slice(0, 3)) {
		attention.push({
			type: "decision",
			message: dec.question.substring(0, 60),
			id: dec.id,
		});
	}

	// Add PM-decidable decisions if there are many
	if (pendingDecisions.length > 3) {
		attention.push({
			type: "decision",
			message: `${pendingDecisions.length} pending decisions`,
		});
	}

	// Add rate limit warning
	if (tracker.isPaused()) {
		const pauseState = tracker.getPauseState();
		const resumeTime = pauseState.resumeAt ? new Date(pauseState.resumeAt).toLocaleTimeString() : "unknown";
		attention.push({
			type: "rate_limit",
			message: `Rate limited - resume at ${resumeTime}`,
		});
	} else if (usage.percentages.fiveHour >= 0.8) {
		attention.push({
			type: "rate_limit",
			message: `Rate limit warning: ${Math.round(usage.percentages.fiveHour * 100)}% of 5hr budget used`,
		});
	}

	// Add recent failures
	const recentFailures = allTasks.filter(
		(t) => t.status === "failed" && t.completedAt && new Date(t.completedAt) >= oneHourAgo,
	);
	if (recentFailures.length > 0) {
		attention.push({
			type: "failure",
			message: `${recentFailures.length} task(s) failed in last hour`,
		});
	}

	const pauseState = tracker.getPauseState();
	const resumeAtDate = pauseState.resumeAt ? new Date(pauseState.resumeAt) : undefined;

	const pulseData: PulseData = {
		timestamp: new Date().toISOString(),
		active: activeList,
		queue: {
			pending: summary.pending,
			inProgress: summary.inProgress,
			completed: summary.complete,
			failed: summary.failed,
			blocked: summary.blocked,
		},
		health: {
			// Plan limits from live claude.ai scraping (source of truth for rate limiting)
			rateLimit: {
				fiveHourPercent: liveUsage?.fiveHourPercent ?? Math.round(usage.percentages.fiveHour * 100),
				weeklyPercent: liveUsage?.weeklyPercent ?? Math.round(usage.percentages.weekly * 100),
				isPaused: tracker.isPaused(),
				resumeAt: resumeAtDate?.toISOString(),
			},
			// Raw live data with fetch timestamp (for debugging/transparency)
			liveUsage: liveUsage ?? undefined,
			recentActivity: {
				completedLastHour,
				failedLastHour,
			},
		},
		pacing: {
			tokenBudget,
			tokensUsed,
			remaining,
			percentUsed: Math.round((tokensUsed / tokenBudget) * 100),
			queueSize: pendingCount,
			estimatedTokensPerTask,
			sustainablePaceTasksPerHour: sustainablePace,
		},
		attention,
	};

	// Human-readable dashboard (opt-in with --human)
	if (!options.human) {
		console.log(JSON.stringify(pulseData, null, 2));
		return;
	}

	// Human-readable dashboard
	console.log(chalk.bold.cyan("\n⚡ Undercity Pulse\n"));

	// Active workers section
	if (activeList.length > 0) {
		console.log(chalk.bold(`ACTIVE (${activeList.length} workers)`));
		for (const w of activeList) {
			console.log(
				chalk.green(`  🔄 ${w.taskId}: "${w.objective}${w.objective.length >= 50 ? "..." : ""}" (${w.elapsed})`),
			);
		}
	} else {
		console.log(chalk.bold("ACTIVE"));
		console.log(chalk.dim("  No workers running"));
	}
	console.log();

	// Queue section
	console.log(chalk.bold(`QUEUE (${summary.pending} pending)`));
	const queueTasks = allTasks.filter((t) => t.status === "pending" && !t.isDecomposed).slice(0, 3);
	for (const t of queueTasks) {
		const priority = t.priority !== undefined ? `#${t.priority}` : "";
		console.log(chalk.dim(`  ${priority} "${t.objective.substring(0, 50)}${t.objective.length >= 50 ? "..." : ""}"`));
	}
	if (summary.pending > 3) {
		console.log(chalk.dim(`  ... and ${summary.pending - 3} more`));
	}
	console.log();

	// Health section
	console.log(chalk.bold("HEALTH"));
	if (liveUsage?.fiveHourPercent !== undefined) {
		// Live data from claude.ai
		const fiveHrColor =
			liveUsage.fiveHourPercent >= 80 ? chalk.red : liveUsage.fiveHourPercent >= 50 ? chalk.yellow : chalk.green;
		console.log(`  Claude Max: ${fiveHrColor(`${liveUsage.fiveHourPercent}%`)} of 5hr budget`);
		if (liveUsage.weeklyPercent !== undefined) {
			console.log(`  Weekly: ${liveUsage.weeklyPercent}%`);
		}
	} else {
		// Fall back to local tracking
		const fiveHrColor =
			usage.percentages.fiveHour >= 0.8 ? chalk.red : usage.percentages.fiveHour >= 0.5 ? chalk.yellow : chalk.green;
		console.log(
			`  Rate limit: ${fiveHrColor(`${Math.round(usage.percentages.fiveHour * 100)}%`)} used (local tracking)`,
		);
	}
	console.log(`  Last hour: ${completedLastHour} completed, ${failedLastHour} failed`);
	console.log();

	// Pacing section
	console.log(chalk.bold("PACING"));
	console.log(`  Budget: ${(tokenBudget / 1000000).toFixed(1)}M tokens/5hr window`);
	console.log(`  Used: ${(tokensUsed / 1000).toFixed(0)}K (${Math.round((tokensUsed / tokenBudget) * 100)}%)`);
	console.log(`  Sustainable pace: ~${sustainablePace} tasks/hour to last 5 hours`);
	console.log();

	// Attention section (only if there are items)
	if (attention.length > 0) {
		console.log(chalk.bold.yellow(`ATTENTION (${attention.length})`));
		for (const item of attention) {
			const icon = item.type === "decision" ? "⚠️" : item.type === "rate_limit" ? "🚨" : "❌";
			console.log(chalk.yellow(`  ${icon} ${item.message}`));
		}
		console.log();
	}

	// Hint for more details
	console.log(chalk.dim("Run 'undercity brief' for detailed report, 'undercity decide' to handle pending decisions."));
}

/**
 * Brief data structure for JSON output
 */
interface BriefData {
	timestamp: string;
	period: {
		hours: number;
		from: string;
		to: string;
	};
	summary: {
		tasksCompleted: number;
		tasksFailed: number;
		tasksInProgress: number;
		tasksPending: number;
		tokensUsed: number;
		estimatedCost: number;
	};
	accomplishments: Array<{
		taskId: string;
		objective: string;
		completedAt: string;
		filesModified?: number;
	}>;
	failures: Array<{
		taskId: string;
		objective: string;
		error: string;
		failedAt: string;
	}>;
	inProgress: Array<{
		taskId: string;
		objective: string;
		startedAt?: string;
		elapsed?: string;
	}>;
	blockers: Array<{
		type: "rate_limit" | "decision_required" | "merge_conflict" | "verification_failed";
		message: string;
		taskId?: string;
	}>;
	trajectory: {
		velocity: number; // tasks/hour
		estimatedClearTime?: string; // when queue will be empty at current pace
		trend: "accelerating" | "steady" | "slowing" | "stalled";
	};
	recommendations: Array<{
		priority: "high" | "medium" | "low";
		action: string;
		reason: string;
	}>;
}

/**
 * Handle the brief command - narrative summary
 *
 * Provides a story-like summary of what Undercity has accomplished,
 * issues encountered, and recommendations.
 */
export async function handleBrief(options: BriefOptions): Promise<void> {
	const { getAllTasks, getTaskBoardSummary } = await import("../task.js");
	const { getPendingDecisions } = await import("../decision-tracker.js");
	const { fetchClaudeUsage } = await import("../claude-usage.js");

	const persistence = new Persistence();
	const savedState = persistence.getRateLimitState();
	const tracker = new RateLimitTracker(savedState ?? undefined);

	// Auto-fetch Claude Max usage from claude.ai (see claude-usage.ts for the sketchy details)
	let liveUsage: {
		fiveHourPercent?: number;
		weeklyPercent?: number;
		observedAt?: string;
		extraUsageEnabled?: boolean;
		extraUsageSpend?: string;
	} | null = null;
	const fetchedUsage = await fetchClaudeUsage();
	if (fetchedUsage.success) {
		liveUsage = {
			fiveHourPercent: fetchedUsage.fiveHourPercent,
			weeklyPercent: fetchedUsage.weeklyPercent,
			observedAt: fetchedUsage.fetchedAt,
			extraUsageEnabled: fetchedUsage.extraUsageEnabled,
			extraUsageSpend: fetchedUsage.extraUsageSpend,
		};
	}

	// Time window (default 24 hours)
	const hours = Number.parseInt(options.hours || "24", 10);
	const periodStart = new Date(Date.now() - hours * 60 * 60 * 1000);
	const periodEnd = new Date();

	// Gather data
	const allTasks = getAllTasks();
	const summary = getTaskBoardSummary();
	const pendingDecisions = getPendingDecisions();
	const usage = tracker.getUsageSummary();

	// Filter tasks by time window
	const completedInPeriod = allTasks.filter(
		(t) => t.status === "complete" && t.completedAt && new Date(t.completedAt) >= periodStart,
	);
	const failedInPeriod = allTasks.filter(
		(t) => t.status === "failed" && t.completedAt && new Date(t.completedAt) >= periodStart,
	);
	const inProgressTasks = allTasks.filter((t) => t.status === "in_progress");

	// Calculate velocity (tasks per hour over the period)
	const tasksInPeriod = completedInPeriod.length + failedInPeriod.length;
	const velocity = hours > 0 ? tasksInPeriod / hours : 0;

	// Estimate clear time
	const pendingCount = summary.pending + summary.inProgress;
	let estimatedClearTime: string | undefined;
	if (velocity > 0 && pendingCount > 0) {
		const hoursToComplete = pendingCount / velocity;
		const clearDate = new Date(Date.now() + hoursToComplete * 60 * 60 * 1000);
		estimatedClearTime = clearDate.toISOString();
	}

	// Determine trend
	let trend: "accelerating" | "steady" | "slowing" | "stalled" = "steady";
	if (velocity === 0 && inProgressTasks.length === 0) {
		trend = "stalled";
	} else if (failedInPeriod.length > completedInPeriod.length) {
		trend = "slowing";
	}

	// Build blockers list
	const blockers: BriefData["blockers"] = [];

	// Rate limit blocker
	if (tracker.isPaused()) {
		const pauseState = tracker.getPauseState();
		blockers.push({
			type: "rate_limit",
			message: `Rate limited until ${pauseState.resumeAt ? new Date(pauseState.resumeAt).toLocaleTimeString() : "unknown"}`,
		});
	}

	// Decision blockers
	if (pendingDecisions.length > 0) {
		blockers.push({
			type: "decision_required",
			message: `${pendingDecisions.length} decision(s) awaiting input`,
		});
	}

	// Claude Max weekly budget blocker
	if (liveUsage?.weeklyPercent !== undefined && liveUsage.weeklyPercent >= 95) {
		blockers.push({
			type: "rate_limit",
			message: `Weekly Claude Max budget nearly exhausted (${liveUsage.weeklyPercent}%)`,
		});
	}

	// Build recommendations
	const recommendations: BriefData["recommendations"] = [];

	// Recommend addressing failures if many
	if (failedInPeriod.length >= 3) {
		recommendations.push({
			priority: "high",
			action: "Review failed tasks and consider manual intervention or task revision",
			reason: `${failedInPeriod.length} tasks failed in the last ${hours}h`,
		});
	}

	// Recommend handling decisions
	if (pendingDecisions.length > 0) {
		recommendations.push({
			priority: pendingDecisions.length > 5 ? "high" : "medium",
			action: "Run 'undercity decide' to handle pending decisions",
			reason: `${pendingDecisions.length} decision(s) blocking progress`,
		});
	}

	// Recommend rate limit awareness (prefer live usage if available)
	if (liveUsage?.weeklyPercent !== undefined && liveUsage.weeklyPercent >= 80) {
		recommendations.push({
			priority: "high",
			action: "Weekly rate limit critical - pause or reduce task volume",
			reason: `${liveUsage.weeklyPercent}% of weekly Claude Max budget used`,
		});
	} else if (liveUsage?.fiveHourPercent !== undefined && liveUsage.fiveHourPercent >= 70) {
		recommendations.push({
			priority: "medium",
			action: "Consider pacing - session budget getting low",
			reason: `${liveUsage.fiveHourPercent}% of 5-hour Claude Max budget used`,
		});
	} else if (usage.percentages.fiveHour >= 0.7) {
		recommendations.push({
			priority: "medium",
			action: "Consider pacing - rate limit budget is getting low",
			reason: `${Math.round(usage.percentages.fiveHour * 100)}% of 5-hour budget used (local tracking)`,
		});
	}

	// Recommend adding tasks if queue is empty
	if (pendingCount === 0 && completedInPeriod.length > 0) {
		recommendations.push({
			priority: "low",
			action: "Add more tasks to the queue",
			reason: "Queue is empty - Undercity is idle",
		});
	}

	// Estimate cost (rough: $3/1M input, $15/1M output for sonnet)
	const estimatedCost = (usage.current.last5HoursSonnet / 1_000_000) * 9; // Average of input/output

	const briefData: BriefData = {
		timestamp: new Date().toISOString(),
		period: {
			hours,
			from: periodStart.toISOString(),
			to: periodEnd.toISOString(),
		},
		summary: {
			tasksCompleted: completedInPeriod.length,
			tasksFailed: failedInPeriod.length,
			tasksInProgress: inProgressTasks.length,
			tasksPending: summary.pending,
			tokensUsed: usage.current.last5HoursSonnet,
			estimatedCost: Math.round(estimatedCost * 100) / 100,
		},
		accomplishments: completedInPeriod.slice(0, 20).map((t) => ({
			taskId: t.id,
			objective: t.objective,
			completedAt:
				t.completedAt instanceof Date ? t.completedAt.toISOString() : t.completedAt || new Date().toISOString(),
		})),
		failures: failedInPeriod.slice(0, 10).map((t) => ({
			taskId: t.id,
			objective: t.objective,
			error: t.error || "Unknown error",
			failedAt: t.completedAt instanceof Date ? t.completedAt.toISOString() : t.completedAt || new Date().toISOString(),
		})),
		inProgress: inProgressTasks.map((t) => ({
			taskId: t.id,
			objective: t.objective,
			startedAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : t.createdAt,
		})),
		blockers,
		trajectory: {
			velocity: Math.round(velocity * 100) / 100,
			estimatedClearTime,
			trend,
		},
		recommendations,
	};

	// JSON output (default)
	if (!options.human) {
		console.log(JSON.stringify(briefData, null, 2));
		return;
	}

	// Human-readable narrative
	console.log(chalk.bold.cyan(`\n📋 Undercity Brief (Last ${hours}h)\n`));

	// Summary line
	if (completedInPeriod.length > 0 || failedInPeriod.length > 0) {
		console.log(
			chalk.bold(
				`Completed ${completedInPeriod.length} task(s), ${failedInPeriod.length} failed, ${pendingCount} remaining`,
			),
		);
	} else {
		console.log(chalk.dim("No tasks completed in this period"));
	}
	console.log();

	// Accomplishments
	if (completedInPeriod.length > 0) {
		console.log(chalk.green.bold("Accomplishments:"));
		for (const task of completedInPeriod.slice(0, 5)) {
			console.log(chalk.green(`  ✓ ${task.objective.substring(0, 60)}${task.objective.length > 60 ? "..." : ""}`));
		}
		if (completedInPeriod.length > 5) {
			console.log(chalk.dim(`  ... and ${completedInPeriod.length - 5} more`));
		}
		console.log();
	}

	// Failures
	if (failedInPeriod.length > 0) {
		console.log(chalk.red.bold("Failures:"));
		for (const task of failedInPeriod.slice(0, 3)) {
			console.log(chalk.red(`  ✗ ${task.objective.substring(0, 50)}...`));
			console.log(chalk.dim(`    ${task.error?.substring(0, 60) || "Unknown error"}`));
		}
		if (failedInPeriod.length > 3) {
			console.log(chalk.dim(`  ... and ${failedInPeriod.length - 3} more`));
		}
		console.log();
	}

	// Blockers
	if (blockers.length > 0) {
		console.log(chalk.yellow.bold("Blockers:"));
		for (const blocker of blockers) {
			console.log(chalk.yellow(`  ⚠ ${blocker.message}`));
		}
		console.log();
	}

	// Trajectory
	console.log(chalk.bold("Trajectory:"));
	console.log(`  Velocity: ${velocity.toFixed(1)} tasks/hour`);
	console.log(`  Trend: ${trend}`);
	if (estimatedClearTime) {
		console.log(`  Queue clear: ~${new Date(estimatedClearTime).toLocaleString()}`);
	}
	console.log();

	// Recommendations
	if (recommendations.length > 0) {
		console.log(chalk.bold("Recommendations:"));
		for (const rec of recommendations) {
			const icon = rec.priority === "high" ? "🔴" : rec.priority === "medium" ? "🟡" : "🟢";
			console.log(`  ${icon} ${rec.action}`);
			console.log(chalk.dim(`     ${rec.reason}`));
		}
	}
}

/**
 * Handle the grind command
 *
 * All tasks run in isolated git worktrees for safety.
 * Use `undercity add "task"` to queue tasks, then `grind` to process them.
 */
export async function handleGrind(options: GrindOptions): Promise<void> {
	// Prevent concurrent grind execution
	const lockResult = acquireGrindLock();
	if (!lockResult.acquired) {
		output.error(
			`Another grind process is already running (PID ${lockResult.existingPid}, started ${lockResult.startedAt})`,
		);
		output.info("Use 'pkill -f undercity' to kill existing processes, or wait for completion");
		process.exit(1);
	}

	// Ensure lock is released on exit
	const cleanupLock = () => releaseGrindLock();
	process.on("exit", cleanupLock);
	process.on("SIGINT", () => {
		cleanupLock();
		process.exit(130);
	});
	process.on("SIGTERM", () => {
		cleanupLock();
		process.exit(143);
	});

	// Clean up stale workers from killed processes (>30min without checkpoint)
	const persistence = new Persistence();
	const staleCleanup = persistence.cleanupStaleWorkers();
	if (staleCleanup.cleaned > 0) {
		output.warning(`Cleaned up ${staleCleanup.cleaned} stale worker(s) from previous runs`);
		output.debug(`Stale task IDs: ${staleCleanup.taskIds.join(", ")}`);
	}

	const { Orchestrator } = await import("../orchestrator.js");
	const { startGrindProgress, updateGrindProgress, clearGrindProgress } = await import("../live-metrics.js");

	const maxCount = Number.parseInt(options.count || "0", 10);
	const parallelism = Math.min(5, Math.max(1, Number.parseInt(options.parallel || "1", 10)));

	// Parse verification retry options (use undefined to let Orchestrator use defaults)
	const maxAttempts = options.maxAttempts ? Number.parseInt(options.maxAttempts, 10) : undefined;
	const maxRetriesPerTier = options.maxRetriesPerTier ? Number.parseInt(options.maxRetriesPerTier, 10) : undefined;
	const maxReviewPassesPerTier = options.maxReviewPasses ? Number.parseInt(options.maxReviewPasses, 10) : undefined;
	const maxOpusReviewPasses = options.maxOpusReviewPasses
		? Number.parseInt(options.maxOpusReviewPasses, 10)
		: undefined;

	// Decomposition depth limit (default: 1, meaning subtasks cannot be decomposed further)
	const maxDecompositionDepth = options.maxDecompositionDepth ? Number.parseInt(options.maxDecompositionDepth, 10) : 1;

	// Parse max tier option (caps escalation at this tier)
	const maxTier = options.maxTier as "haiku" | "sonnet" | "opus" | undefined;
	if (maxTier && !["haiku", "sonnet", "opus"].includes(maxTier)) {
		output.error(`Invalid max-tier: ${maxTier}. Must be haiku, sonnet, or opus`);
		process.exit(1);
	}

	const orchestrator = new Orchestrator({
		maxConcurrent: parallelism,
		autoCommit: options.commit !== false,
		stream: options.stream || false,
		verbose: options.verbose || false,
		startingModel: (options.model || "sonnet") as "haiku" | "sonnet" | "opus",
		reviewPasses: options.review === true,
		pushOnSuccess: options.push === true,
		maxAttempts,
		maxRetriesPerTier,
		maxReviewPassesPerTier,
		maxOpusReviewPasses,
		maxTier,
	});

	// Set up auto-drain timer if duration specified
	let drainTimer: NodeJS.Timeout | null = null;
	if (options.duration) {
		const durationMs = parseDuration(options.duration);
		if (durationMs === null) {
			output.error(`Invalid duration format: ${options.duration}. Use format like "6h" or "30m"`);
			process.exit(1);
		}

		// Schedule drain signal
		drainTimer = setTimeout(() => {
			output.progress(`Duration ${options.duration} elapsed - initiating drain`);
			orchestrator.drain(() => {
				output.success("Auto-drain complete");
			});
		}, durationMs);

		output.info(`Auto-drain scheduled in ${options.duration} (${formatDuration(durationMs)})`);
	}

	// Process from task board (all tasks run in worktrees)
	output.header("Undercity Grind Mode", "Autonomous operation • Rate limit handling • Infinite processing");

	// Pre-flight check: verify Claude Max usage limits before starting
	try {
		const { fetchClaudeUsage } = await import("../claude-usage.js");
		const usage = await fetchClaudeUsage();
		if (usage?.success) {
			// Check both 5-hour and weekly limits
			const maxPercent = Math.max(usage.fiveHourPercent, usage.weeklyPercent);
			if (maxPercent >= 95) {
				output.warning(`Claude Max usage at ${maxPercent.toFixed(0)}% - consider waiting for reset`);
			} else if (maxPercent >= 80) {
				output.info(`Claude Max usage: ${maxPercent.toFixed(0)}% of limit`);
			} else {
				output.debug(`Usage headroom OK: ${maxPercent.toFixed(0)}% used`);
			}
		} else if (usage?.needsLogin) {
			output.debug("Skipping usage check (run 'undercity usage --login' to enable)");
		}
	} catch {
		// Usage check is optional - continue without it
		output.debug("Skipping usage check (may need login via 'undercity usage --login')");
	}

	// Auto-prime patterns from git history if store is empty/small
	try {
		const { getTaskFileStats, primeFromGitHistory } = await import("../task-file-patterns.js");
		const stats = getTaskFileStats();
		if (stats.uniqueKeywords < 10) {
			output.progress("Auto-priming patterns from git history...");
			const primeResult = await primeFromGitHistory(100);
			if (primeResult.patternsAdded > 0) {
				output.info(`Primed ${primeResult.patternsAdded} patterns from ${primeResult.commitsProcessed} commits`);
			}
		}
	} catch {
		// Non-critical - continue without priming
	}

	// Pre-build AST index if empty (critical for context selection)
	try {
		const { getASTIndex } = await import("../ast-index.js");
		const index = getASTIndex();
		await index.load();
		const indexStats = index.getStats();
		if (indexStats.fileCount === 0) {
			output.progress("Building AST index for smart context selection...");
			await index.rebuildFull();
			await index.save();
			const newStats = index.getStats();
			output.info(`AST index built: ${newStats.fileCount} files, ${newStats.symbolCount} symbols`);
		} else {
			output.debug(`AST index loaded: ${indexStats.fileCount} files`);
		}
	} catch {
		// Non-critical - context selection will fall back to git grep
		output.debug("AST index unavailable, will use git grep for context");
	}

	// Check if task board is empty - suggest PM if so
	try {
		const { getAllTasks } = await import("../task.js");
		const allTasks = getAllTasks();
		const pendingTasks = allTasks.filter((t) => t.status === "pending" || t.status === "in_progress");
		if (pendingTasks.length === 0) {
			output.warning("Task board is empty - nothing to grind");
			output.info("Generate tasks with: undercity pm --propose");
			output.info("Or research a topic: undercity pm 'topic' --ideate");
			return;
		}
	} catch {
		// Continue - will fail later if board truly empty
	}

	// Track how many tasks we've processed (for -n flag)
	let tasksProcessed = 0;

	// Dry-run mode skips recovery (just shows what would run from current board)
	if (options.dryRun && orchestrator.hasActiveRecovery()) {
		output.info("Skipping recovery in dry-run mode (use without --dry-run to resume)");
	}

	// Check for interrupted batch and offer to resume
	if (!options.dryRun && orchestrator.hasActiveRecovery()) {
		const recoveryInfo = orchestrator.getRecoveryInfo();
		if (recoveryInfo) {
			output.warning("Interrupted batch detected", {
				batchId: recoveryInfo.batchId,
				startedAt: recoveryInfo.startedAt.toISOString(),
				tasksComplete: recoveryInfo.tasksComplete,
				tasksFailed: recoveryInfo.tasksFailed,
				tasksPending: recoveryInfo.tasksPending,
			});

			// Auto-resume the pending tasks
			output.progress("Resuming interrupted batch...");
			const recoveryTasks = await orchestrator.resumeRecovery();

			if (recoveryTasks.length > 0) {
				// Apply -n limit to recovery tasks if specified
				const tasksToResume = maxCount > 0 ? recoveryTasks.slice(0, maxCount) : recoveryTasks;

				const result = await orchestrator.runParallel(tasksToResume);
				tasksProcessed += result.results.length;

				output.summary("Recovery Complete", [
					{ label: "Resumed", value: result.results.length },
					{ label: "Successful", value: result.successful, status: "good" },
					{ label: "Failed", value: result.failed, status: result.failed > 0 ? "bad" : "neutral" },
					{ label: "Merged", value: result.merged },
				]);

				// If -n limit reached, stop here
				if (maxCount > 0 && tasksProcessed >= maxCount) {
					return;
				}
			} else {
				output.info("No pending tasks to resume");
			}
		}
	}

	try {
		// Get tasks from task board
		// Pre-flight validation: check for duplicate work BEFORE loading tasks
		const { reconcileTasks } = await import("../task.js");
		output.info("Running pre-flight validation...");
		const preflightResult = await reconcileTasks({ lookbackCommits: 50, dryRun: false });
		if (preflightResult.duplicatesFound > 0) {
			output.success(`Pre-flight: marked ${preflightResult.duplicatesFound} task(s) as duplicate`, {
				tasks: preflightResult.tasksMarked.map((t) => t.taskId),
			});
		}

		// Baseline check: verify main branch is green before starting tasks
		// This prevents agents from being blamed for pre-existing failures
		const { verifyBaseline } = await import("../verification.js");
		const baselineResult = await verifyBaseline();
		if (!baselineResult.passed) {
			output.error("Baseline check failed - fix issues before running grind:");
			output.error(baselineResult.feedback);
			process.exit(1);
		}
		if (baselineResult.cached) {
			output.info("Baseline verified (cached)");
		} else {
			output.success("Baseline verified");
		}

		const {
			getAllItems,
			markTaskComplete,
			markTaskFailed,
			decomposeTaskIntoSubtasks,
			completeParentIfAllSubtasksDone,
			getTaskById,
		} = await import("../task.js");
		const allTasks = getAllItems();
		// Include both "pending" and "in_progress" tasks
		// in_progress tasks may be stale from a previous crashed session
		// Also filter out decomposed tasks (their subtasks will be picked up instead)
		const pendingTasks = allTasks
			.filter((q) => (q.status === "pending" || q.status === "in_progress") && !q.isDecomposed)
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)); // Higher priority first

		// If task-id specified, filter to just that task
		let tasksToProcess: typeof pendingTasks;
		if (options.taskId) {
			const targetTask = pendingTasks.find((t) => t.id === options.taskId);
			if (!targetTask) {
				// Check if task exists but isn't pending
				const allMatch = allTasks.find((t) => t.id === options.taskId);
				if (allMatch) {
					output.error(`Task ${options.taskId} exists but is not pending (status: ${allMatch.status})`);
				} else {
					output.error(`Task not found: ${options.taskId}`);
				}
				return;
			}
			tasksToProcess = [targetTask];
			output.info(`Running specific task: ${targetTask.objective.substring(0, 60)}...`);
		} else {
			// Account for tasks already processed during recovery
			const remainingCount = maxCount > 0 ? maxCount - tasksProcessed : 0;
			tasksToProcess = maxCount > 0 ? pendingTasks.slice(0, remainingCount) : pendingTasks;
		}

		// Skip if no tasks to process (either none pending or -n limit reached)
		if (tasksToProcess.length === 0) {
			if (pendingTasks.length === 0) {
				output.info("No pending or in-progress tasks on the task board");
			}
			// If tasksProcessed > 0, we already showed recovery summary
			return;
		}

		/// Lazy decomposition check: assess atomicity and decompose complex tasks
		// Also collects recommended model for each task
		type TaskWithModel = (typeof tasksToProcess)[0] & { recommendedModel?: "haiku" | "sonnet" | "opus" };
		let tasksWithModels: TaskWithModel[] = [];

		// Store atomicity check results for outcome recording (Ax training data)
		const atomicityResults = new Map<
			string,
			{
				isAtomic: boolean;
				confidence: number;
				estimatedFiles: number;
				recommendedModel: string;
				reasoning: string;
			}
		>();

		// Pre-flight validation: check for invalid paths and auto-fix when possible
		const { validateTask, assessTaskClarity } = await import("../task-validator.js");
		const { updateTaskFields } = await import("../task.js");

		output.progress("Validating task references...");
		const invalidTasks: string[] = [];

		for (const task of tasksToProcess) {
			const validation = validateTask(task.objective);

			// Auto-fix correctable paths
			if (validation.correctedObjective) {
				output.info(`Auto-fixed path in task: ${task.id}`);
				for (const issue of validation.issues.filter((i) => i.type === "path_corrected")) {
					output.debug(`  ${issue.autoFix?.originalPath} → ${issue.autoFix?.correctedPath}`);
				}
				// Update the task objective
				updateTaskFields({ id: task.id, objective: validation.correctedObjective });
				task.objective = validation.correctedObjective;
			}

			// Flag invalid tasks that can't be auto-fixed
			if (!validation.valid) {
				const errorIssues = validation.issues.filter((i) => i.severity === "error");
				output.warning(`Task ${task.id} has validation errors:`);
				for (const issue of errorIssues) {
					output.warning(`  ${issue.message}`);
					if (issue.suggestion) {
						output.debug(`  → ${issue.suggestion}`);
					}
				}
				invalidTasks.push(task.id);
			}
		}

		// Remove invalid tasks from processing (they'll stay pending for manual fix)
		if (invalidTasks.length > 0) {
			output.warning(`Skipping ${invalidTasks.length} task(s) with validation errors`);
			tasksToProcess = tasksToProcess.filter((t) => !invalidTasks.includes(t.id));
		}

		if (tasksToProcess.length === 0) {
			output.info("No valid tasks to process after validation");
			return;
		}

		// Pre-flight clarity check: route vague tasks to PM, warn about others
		output.progress("Assessing task clarity...");
		const vagueTasks: string[] = [];
		const blockedTasks: string[] = [];
		const decomposedTasks: string[] = [];

		for (const task of tasksToProcess) {
			const clarity = assessTaskClarity(task.objective);

			// Route fundamentally vague tasks to PM for intelligent decomposition
			if (clarity.tooVague) {
				output.warning(`Task ${task.id} is vague - routing to PM for decomposition:`);
				for (const issue of clarity.issues) {
					output.warning(`  - ${issue}`);
				}

				try {
					const { pmIdeate } = await import("../automated-pm.js");
					output.progress(`PM analyzing: "${task.objective.substring(0, 50)}..."`);

					const ideation = await pmIdeate(task.objective, process.cwd(), ".undercity");

					if (ideation.proposals.length > 0) {
						// PM successfully decomposed the vague task
						output.success(`PM generated ${ideation.proposals.length} specific subtask(s)`);

						// Add proposals as subtasks
						const { decomposeTaskIntoSubtasks } = await import("../task.js");
						const subtasks = ideation.proposals.map((p, idx) => ({
							objective: p.objective,
							order: idx + 1,
						}));
						decomposeTaskIntoSubtasks(task.id, subtasks);

						output.info("Subtasks created:");
						for (const proposal of ideation.proposals) {
							output.info(`  → ${proposal.objective.substring(0, 70)}...`);
						}

						// Task is now decomposed, will be skipped in main loop
						decomposedTasks.push(task.id);
					} else {
						// PM couldn't help - fall back to blocking
						output.warning("PM couldn't generate specific subtasks - blocking task");
						const { markTaskBlocked } = await import("../task.js");
						markTaskBlocked(task.id, "PM could not decompose vague task into actionable subtasks");
						blockedTasks.push(task.id);
					}
				} catch (pmError) {
					// PM failed - fall back to blocking with suggestions
					output.warning(`PM decomposition failed: ${pmError instanceof Error ? pmError.message : String(pmError)}`);
					output.info("Suggestions to fix manually:");
					for (const suggestion of clarity.suggestions) {
						output.info(`  → ${suggestion}`);
					}
					const { markTaskBlocked } = await import("../task.js");
					markTaskBlocked(task.id, clarity.tooVagueReason || "Task too vague for autonomous execution");
					blockedTasks.push(task.id);
				}
			} else if (clarity.clarity === "vague") {
				output.warning(`Task ${task.id} may be too vague for autonomous execution:`);
				for (const issue of clarity.issues) {
					output.warning(`  - ${issue}`);
				}
				for (const suggestion of clarity.suggestions) {
					output.debug(`  → ${suggestion}`);
				}
				vagueTasks.push(task.id);
			} else if (clarity.clarity === "needs_context") {
				// Just log a note, don't skip
				output.debug(
					`Task ${task.id} could benefit from more context (confidence: ${(clarity.confidence * 100).toFixed(0)}%)`,
				);
			}
		}

		// Remove blocked and decomposed tasks from processing
		if (blockedTasks.length > 0) {
			output.warning(`Blocked ${blockedTasks.length} task(s) - could not decompose`);
			tasksToProcess = tasksToProcess.filter((t) => !blockedTasks.includes(t.id));
		}
		if (decomposedTasks.length > 0) {
			output.success(`PM decomposed ${decomposedTasks.length} vague task(s) into specific subtasks`);
			tasksToProcess = tasksToProcess.filter((t) => !decomposedTasks.includes(t.id));
		}

		// Warn about remaining vague tasks that might still work
		if (vagueTasks.length > 0) {
			output.warning(`${vagueTasks.length} task(s) are vague and may require decomposition or escalation`);
		}

		if (options.decompose !== false) {
			const { checkAndDecompose } = await import("../task-decomposer.js");

			output.progress("Checking task atomicity and complexity...");

			for (const task of tasksToProcess) {
				// Skip decomposition if task has reached max depth
				const taskDepth = task.decompositionDepth ?? 0;
				if (taskDepth >= maxDecompositionDepth) {
					output.debug(
						`Skipping decomposition for "${task.objective.substring(0, 40)}..." (depth ${taskDepth} >= max ${maxDecompositionDepth})`,
					);
					tasksWithModels.push({
						...task,
						recommendedModel: "sonnet", // Default to sonnet for depth-limited tasks
					});
					continue;
				}

				const result = await checkAndDecompose(task.objective);

				if (result.action === "decomposed") {
					if (result.subtasks && result.subtasks.length > 0) {
						// Task was decomposed - add subtasks to board
						output.info(`Decomposed "${task.objective.substring(0, 50)}..." into ${result.subtasks.length} subtasks`);

						decomposeTaskIntoSubtasks(
							task.id,
							result.subtasks.map((st) => ({
								objective: st.objective,
								estimatedFiles: st.estimatedFiles,
								order: st.order,
							})),
						);

						// Log subtask creation
						for (let i = 0; i < result.subtasks.length; i++) {
							output.debug(`  Subtask ${i + 1}: ${result.subtasks[i].objective.substring(0, 60)}`);
						}
					} else {
						// Decomposition attempted but failed to produce subtasks - task is too vague
						output.warning(`Task too vague to decompose: "${task.objective.substring(0, 50)}..."`);
						const { markTaskBlocked } = await import("../task.js");
						markTaskBlocked(task.id, "Task too vague - decomposition failed to produce actionable subtasks");
						// Don't add to tasksWithModels - skip this task
					}
				} else {
					// Task is atomic - include with recommended model
					const taskWithModel: TaskWithModel = {
						...task,
						recommendedModel: result.recommendedModel || "sonnet",
					};
					tasksWithModels.push(taskWithModel);
					output.debug(`Task "${task.objective.substring(0, 40)}..." → ${result.recommendedModel || "sonnet"}`);

					// Store atomicity result for outcome recording
					atomicityResults.set(task.objective, {
						isAtomic: true,
						confidence: 0.8, // checkAndDecompose doesn't expose confidence directly
						estimatedFiles: 1,
						recommendedModel: result.recommendedModel || "sonnet",
						reasoning: result.reasoning,
					});
				}
			}

			// If all tasks were decomposed, refetch to get subtasks
			if (tasksWithModels.length === 0) {
				output.info("All tasks were decomposed. Fetching subtasks...");
				const refreshedTasks = getAllItems();
				const newPendingTasks = refreshedTasks
					.filter((q) => (q.status === "pending" || q.status === "in_progress") && !q.isDecomposed)
					.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)); // Higher priority first
				const newRemainingCount = maxCount > 0 ? maxCount - tasksProcessed : newPendingTasks.length;
				const newTasks = maxCount > 0 ? newPendingTasks.slice(0, newRemainingCount) : newPendingTasks;

				if (newTasks.length === 0) {
					output.info("No tasks ready after decomposition");
					return;
				}

				// Re-assess the new subtasks
				for (const task of newTasks) {
					const result = await checkAndDecompose(task.objective);
					tasksWithModels.push({
						...task,
						recommendedModel: result.recommendedModel || "sonnet",
					});

					// Store atomicity result for outcome recording
					atomicityResults.set(task.objective, {
						isAtomic: true,
						confidence: 0.8,
						estimatedFiles: 1,
						recommendedModel: result.recommendedModel || "sonnet",
						reasoning: result.reasoning,
					});
				}
			}
		} else {
			// No decomposition - use default model for all tasks
			tasksWithModels = tasksToProcess.map((t) => ({
				...t,
				recommendedModel: (options.model || "sonnet") as "haiku" | "sonnet" | "opus",
			}));
		}

		// Adjust models based on historical metrics (unless model explicitly set)
		if (!options.model) {
			const { adjustModelFromMetrics } = await import("../complexity.js");
			for (const task of tasksWithModels) {
				// Get complexity level from decomposer result if available, default to 'standard'
				const complexityLevel = (task as { complexity?: string }).complexity || "standard";
				const adjustedModel = await adjustModelFromMetrics(
					task.recommendedModel || "sonnet",
					complexityLevel as "trivial" | "simple" | "standard" | "complex" | "critical",
				);
				if (adjustedModel !== task.recommendedModel) {
					output.debug(
						`Metrics adjustment: ${task.objective.substring(0, 30)}... ${task.recommendedModel} → ${adjustedModel}`,
					);
					task.recommendedModel = adjustedModel;
				}
			}

			// Check capability ledger for pattern-specific model recommendations
			// This can downgrade models when historical data shows simpler models work
			const { getRecommendedModel: getLedgerRecommendation } = await import("../capability-ledger.js");
			for (const task of tasksWithModels) {
				const ledgerRec = getLedgerRecommendation(task.objective);
				// Only apply ledger recommendation if high confidence and it suggests a CHEAPER model
				// (escalation handles upgrading, ledger helps identify when we can save tokens)
				const modelOrder = ["haiku", "sonnet", "opus"] as const;
				const currentIdx = modelOrder.indexOf(task.recommendedModel || "sonnet");
				const ledgerIdx = modelOrder.indexOf(ledgerRec.model);
				if (ledgerRec.confidence >= 0.7 && ledgerIdx < currentIdx) {
					output.debug(
						`Ledger adjustment: ${task.objective.substring(0, 30)}... ${task.recommendedModel} → ${ledgerRec.model} (${ledgerRec.reason})`,
					);
					task.recommendedModel = ledgerRec.model;
				}
			}
		}

		// Group tasks by recommended model for efficient execution
		const tasksByModel = {
			haiku: tasksWithModels.filter((t) => t.recommendedModel === "haiku"),
			sonnet: tasksWithModels.filter((t) => t.recommendedModel === "sonnet"),
			opus: tasksWithModels.filter((t) => t.recommendedModel === "opus"),
		};

		// Log model distribution
		const modelCounts = Object.entries(tasksByModel)
			.filter(([, tasks]) => tasks.length > 0)
			.map(([model, tasks]) => `${model}: ${tasks.length}`)
			.join(", ");
		output.info(`Task model distribution: ${modelCounts}`);

		// Dry-run mode: show what would execute without running
		if (options.dryRun) {
			output.header("Dry Run", "Showing validation results and execution plan");

			// Show validation summary
			const validatedCount = tasksWithModels.length;
			const skippedCount = invalidTasks.length;
			const vagueCount = vagueTasks.length;

			output.summary("Validation Results", [
				{ label: "Tasks validated", value: validatedCount },
				{ label: "Tasks skipped (invalid)", value: skippedCount },
				{ label: "Tasks flagged (vague)", value: vagueCount },
			]);

			// Show invalid tasks with reasons
			if (invalidTasks.length > 0) {
				console.log("\n⚠ INVALID TASKS (would be skipped):");
				for (const taskId of invalidTasks) {
					const task = tasksToProcess.find((t) => t.id === taskId);
					if (task) {
						console.log(`  - [${taskId}] ${task.objective.substring(0, 60)}`);
					}
				}
			}

			// Show vague tasks
			if (vagueTasks.length > 0) {
				console.log("\n⚠ VAGUE TASKS (may need decomposition):");
				for (const taskId of vagueTasks) {
					const task = tasksToProcess.find((t) => t.id === taskId);
					if (task) {
						console.log(`  - [${taskId}] ${task.objective.substring(0, 60)}`);
					}
				}
			}

			output.summary("Execution Plan", [
				{ label: "Total tasks", value: tasksWithModels.length },
				{ label: "Haiku", value: tasksByModel.haiku.length },
				{ label: "Sonnet", value: tasksByModel.sonnet.length },
				{ label: "Opus", value: tasksByModel.opus.length },
				{ label: "Parallelism", value: parallelism },
			]);

			// List tasks by model tier
			for (const tier of ["haiku", "sonnet", "opus"] as const) {
				const tierTasks = tasksByModel[tier];
				if (tierTasks.length > 0) {
					console.log(`\n${tier.toUpperCase()} tier (${tierTasks.length} tasks):`);
					for (const task of tierTasks) {
						console.log(
							`  - [${task.id.substring(0, 8)}] ${task.objective.substring(0, 65)}${task.objective.length > 65 ? "..." : ""}`,
						);
					}
				}
			}

			console.log("\n✓ No tasks were executed (dry-run mode)");
			console.log("  Run without --dry-run to execute these tasks");
			return;
		}

		// Update tasksToProcess for the loop below
		tasksToProcess = tasksWithModels;

		// Build a map of objective -> task ID for status updates
		const objectiveToQuestId = new Map<string, string>();
		for (const q of tasksToProcess) {
			objectiveToQuestId.set(q.objective, q.id);
		}

		// Start grind progress tracking
		const totalToProcess = tasksWithModels.length + tasksProcessed;
		const mode = maxCount > 0 ? "fixed" : "board";
		startGrindProgress(totalToProcess, mode);
		updateGrindProgress(tasksProcessed, totalToProcess);

		// Start grind event logging
		const { startGrindSession, endGrindSession, logTaskQueued, logTaskStarted, logTaskComplete, logTaskFailed } =
			await import("../grind-events.js");
		const { getExperimentManager } = await import("../experiment.js");
		const experimentManager = getExperimentManager();
		const activeExperiment = experimentManager.getActiveExperiment();

		// Track variant assignments for experiment
		const taskVariantMap = new Map<string, string>();

		if (activeExperiment) {
			output.info(`Experiment active: "${activeExperiment.name}" (${activeExperiment.variants.length} variants)`);
		}

		const batchId = `grind-${Date.now().toString(36)}`;

		// Clear orphaned workers from any previous batch before starting
		// This is critical: workers from previous sessions are definitely dead
		const orphanCleanup = persistence.clearPreviousBatchWorkers(batchId);
		if (orphanCleanup.cleared > 0) {
			output.info(`Cleared ${orphanCleanup.cleared} orphaned worker(s) from previous sessions`);
		}

		startGrindSession({
			batchId,
			taskCount: tasksWithModels.length,
			maxCount: maxCount > 0 ? maxCount : undefined,
			parallelism,
			modelDistribution: {
				haiku: tasksByModel.haiku.length,
				sonnet: tasksByModel.sonnet.length,
				opus: tasksByModel.opus.length,
			},
		});

		// Log all tasks as queued
		for (const task of tasksWithModels) {
			logTaskQueued({
				batchId,
				taskId: task.id,
				objective: task.objective,
				recommendedModel: task.recommendedModel || "sonnet",
			});
		}

		// If experiment is active, reassign models based on variant selection
		if (activeExperiment) {
			// Clear default model groupings
			tasksByModel.haiku = [];
			tasksByModel.sonnet = [];
			tasksByModel.opus = [];

			// Reassign each task based on experiment variant
			for (const task of tasksWithModels) {
				const variant = experimentManager.selectVariant();
				if (variant) {
					taskVariantMap.set(task.id, variant.id);
					// Override model based on variant
					task.recommendedModel = variant.model;
					tasksByModel[variant.model].push(task);
					output.debug(`Task ${task.id} assigned to variant "${variant.name}" (${variant.model})`);
				} else {
					// No variant selected, use original recommendation
					tasksByModel[task.recommendedModel || "sonnet"].push(task);
				}
			}

			// Log updated model distribution
			const experimentModelCounts = Object.entries(tasksByModel)
				.filter(([, tasks]) => tasks.length > 0)
				.map(([model, tasks]) => `${model}: ${tasks.length}`)
				.join(", ");
			output.info(`Experiment model distribution: ${experimentModelCounts}`);
		}

		// Run tasks grouped by model tier (haiku first = cheapest, then sonnet, then opus)
		const modelOrder: Array<"haiku" | "sonnet" | "opus"> = ["haiku", "sonnet", "opus"];
		let completedCount = tasksProcessed;
		let totalSuccessful = 0;
		let totalFailed = 0;
		let totalMerged = 0;
		let totalDecomposed = 0;
		let totalDurationMs = 0;

		// Track task results for structured output
		const taskResults: TaskResultSummary[] = [];

		for (const modelTier of modelOrder) {
			const tierTasks = tasksByModel[modelTier];
			if (tierTasks.length === 0) continue;

			// Error boundary around each tier - one tier failing shouldn't stop others
			try {
				output.info(`Running ${tierTasks.length} task(s) with ${modelTier}...`);

				// Analyze task compatibility to detect conflicts before parallel execution
				// This uses regex-based analysis (no LLM cost) to predict file conflicts
				const { TaskBoardAnalyzer } = await import("../task-board-analyzer.js");
				const boardAnalyzer = new TaskBoardAnalyzer();
				const compatMatrix = await boardAnalyzer.generateCompatibilityMatrix(tierTasks);

				// Group tasks into compatible batches to avoid parallel conflicts
				const taskBatches: Array<typeof tierTasks> = [];
				const assignedTasks = new Set<string>();

				// Build batches by greedily adding compatible tasks
				for (const task of tierTasks) {
					if (assignedTasks.has(task.id)) continue;

					// Start a new batch with this task
					const batch: typeof tierTasks = [task];
					assignedTasks.add(task.id);

					// Try to add other tasks that are compatible with all batch members
					for (const candidate of tierTasks) {
						if (assignedTasks.has(candidate.id)) continue;

						// Check if candidate is compatible with all tasks in current batch
						const taskIdx = compatMatrix.tasks.findIndex((t) => t.id === candidate.id);
						let compatible = true;

						for (const batchMember of batch) {
							const memberIdx = compatMatrix.tasks.findIndex((t) => t.id === batchMember.id);
							if (taskIdx >= 0 && memberIdx >= 0) {
								const result = compatMatrix.matrix[taskIdx][memberIdx];
								if (!result.compatible) {
									compatible = false;
									break;
								}
							}
						}

						if (compatible) {
							batch.push(candidate);
							assignedTasks.add(candidate.id);
						}
					}

					taskBatches.push(batch);
				}

				// Log if we split into multiple batches due to conflicts
				if (taskBatches.length > 1) {
					output.info(
						`Split ${tierTasks.length} tasks into ${taskBatches.length} sequential batches to avoid conflicts`,
					);
					for (let i = 0; i < taskBatches.length; i++) {
						output.debug(`  Batch ${i + 1}: ${taskBatches[i].length} task(s)`);
					}
				}

				// Log task starts (but don't mark in_progress yet - orchestrator will do that
				// after similarity check passes to avoid false positive duplicate detection)
				for (const task of tierTasks) {
					logTaskStarted({
						batchId,
						taskId: task.id,
						objective: task.objective,
						model: modelTier,
					});
				}

				// Check if experiment wants review enabled for this tier
				const experimentReviewEnabled =
					activeExperiment &&
					tierTasks.some((t) => {
						const variantId = taskVariantMap.get(t.id);
						const variant = activeExperiment.variants.find((v) => v.id === variantId);
						return variant?.reviewEnabled;
					});

				// Execute each batch sequentially (compatible tasks within batch run in parallel)
				for (let batchIdx = 0; batchIdx < taskBatches.length; batchIdx++) {
					const batchTasks = taskBatches[batchIdx];

					if (taskBatches.length > 1) {
						output.info(`Running batch ${batchIdx + 1}/${taskBatches.length} (${batchTasks.length} task(s))...`);
					}

					// Create orchestrator for this batch
					const batchOrchestrator = new Orchestrator({
						maxConcurrent: parallelism,
						autoCommit: options.commit !== false,
						stream: options.stream || false,
						verbose: options.verbose || false,
						startingModel: modelTier,
						reviewPasses: options.review === true || experimentReviewEnabled === true,
						pushOnSuccess: options.push === true,
						maxAttempts,
						maxRetriesPerTier,
						maxReviewPassesPerTier,
						maxOpusReviewPasses,
						maxTier,
					});

					// Pass full task objects to preserve IDs for decomposition
					const batchStartTime = Date.now();
					const result = await batchOrchestrator.runParallel(batchTasks);
					const batchDurationMs = Date.now() - batchStartTime;

					// Update task status based on results
					for (const taskResult of result.results) {
						const taskId = objectiveToQuestId.get(taskResult.task);
						if (taskId) {
							// Decomposed tasks are handled separately - status already set by decomposeTaskIntoSubtasks
							if (taskResult.decomposed) {
								output.info(`Task decomposed into subtasks`, { taskId });
								completedCount++;
								updateGrindProgress(completedCount, totalToProcess);
								taskResults.push({
									task: taskResult.task,
									taskId,
									status: "decomposed",
									modifiedFiles: [],
								});
								continue;
							}

							if (taskResult.merged) {
								markTaskComplete(taskId);
								output.taskComplete(taskId, `Task merged (${modelTier})`);
								completedCount++;
								updateGrindProgress(completedCount, totalToProcess);

								// Log completion event
								logTaskComplete({
									batchId,
									taskId,
									model: taskResult.result?.model ?? modelTier,
									attempts: taskResult.result?.attempts ?? 1,
									fileCount: taskResult.modifiedFiles?.length ?? 0,
									tokens: taskResult.result?.tokenUsage?.total ?? 0,
									durationMs: batchDurationMs,
									commitSha: taskResult.result?.commitSha,
								});

								// Record experiment result if variant was assigned
								const variantId = taskVariantMap.get(taskId);
								if (variantId && activeExperiment) {
									experimentManager.recordResult({
										taskId,
										variantId,
										success: true,
										durationMs: taskResult.result?.durationMs ?? batchDurationMs,
										tokensUsed: taskResult.result?.tokenUsage?.total ?? 0,
										attempts: taskResult.result?.attempts ?? 1,
									});
								}

								// Track result for structured output
								taskResults.push({
									task: taskResult.task,
									taskId,
									status: "merged",
									modifiedFiles: taskResult.modifiedFiles,
								});

								// Check if this was a subtask and auto-complete parent if all siblings done
								const task = getTaskById(taskId);
								if (task?.parentId) {
									const parentCompleted = completeParentIfAllSubtasksDone(task.parentId);
									if (parentCompleted) {
										output.info(`Parent task ${task.parentId} auto-completed (all subtasks done)`);
									}
								}

								// Record atomicity outcome for Ax training data
								const atomicityResult = atomicityResults.get(taskResult.task);
								if (atomicityResult) {
									recordAtomicityOutcome(taskResult.task, atomicityResult, true);
								}
							} else if (taskResult.mergeError || taskResult.result?.status === "failed") {
								// Use actual error from task result, with fallbacks
								const errorMsg = taskResult.mergeError || taskResult.result?.error || "Task failed";
								// Build last attempt context for future retries
								const lastAttempt: LastAttemptContext = {
									model: taskResult.result?.model ?? modelTier,
									category: getErrorCategory(taskResult.result?.error, taskResult.result?.verification),
									error: errorMsg,
									filesModified: taskResult.modifiedFiles ?? [],
									attemptedAt: new Date(),
									attemptCount: taskResult.result?.attempts ?? 1,
								};
								markTaskFailed({ id: taskId, error: errorMsg, lastAttempt });
								output.taskFailed(taskId, `Task failed (${modelTier})`, errorMsg);
								completedCount++;
								updateGrindProgress(completedCount, totalToProcess);

								// Log failure event
								logTaskFailed({
									batchId,
									taskId,
									error: errorMsg,
									model: taskResult.result?.model ?? modelTier,
									attempts: taskResult.result?.attempts ?? 1,
									tokens: taskResult.result?.tokenUsage?.total ?? 0,
									durationMs: batchDurationMs,
								});

								// Record experiment result if variant was assigned
								const variantId = taskVariantMap.get(taskId);
								if (variantId && activeExperiment) {
									experimentManager.recordResult({
										taskId,
										variantId,
										success: false,
										durationMs: taskResult.result?.durationMs ?? batchDurationMs,
										tokensUsed: taskResult.result?.tokenUsage?.total ?? 0,
										attempts: taskResult.result?.attempts ?? 1,
										errorCategories: [errorMsg.substring(0, 50)],
									});
								}

								// Track result for structured output
								taskResults.push({
									task: taskResult.task,
									taskId,
									status: "failed",
									error: errorMsg,
								});

								// Record atomicity outcome for Ax training data (failure)
								const atomicityResult = atomicityResults.get(taskResult.task);
								if (atomicityResult) {
									recordAtomicityOutcome(taskResult.task, atomicityResult, false);
								}
							}
						}
					}

					totalSuccessful += result.successful;
					totalFailed += result.failed;
					totalMerged += result.merged;
					totalDecomposed += result.decomposed;
					totalDurationMs += result.durationMs;
				}
			} catch (tierError) {
				// Tier-level error - log and continue to next tier
				output.error(`Model tier ${modelTier} failed: ${tierError}`);

				// Mark all tasks in this tier as failed
				for (const task of tierTasks) {
					const taskId = objectiveToQuestId.get(task.objective);
					if (taskId) {
						const lastAttempt: LastAttemptContext = {
							model: modelTier,
							category: "tier_error",
							error: `Tier error: ${tierError}`,
							filesModified: [],
							attemptedAt: new Date(),
							attemptCount: 0,
						};
						markTaskFailed({ id: taskId, error: `Tier error: ${tierError}`, lastAttempt });
						completedCount++;
						updateGrindProgress(completedCount, totalToProcess);

						logTaskFailed({
							batchId,
							taskId,
							error: `Tier error: ${tierError}`,
							model: modelTier,
							attempts: 0,
							tokens: 0,
							durationMs: 0,
						});

						// Record experiment result if variant was assigned
						const variantId = taskVariantMap.get(taskId);
						if (variantId && activeExperiment) {
							experimentManager.recordResult({
								taskId,
								variantId,
								success: false,
								durationMs: 0,
								tokensUsed: 0,
								attempts: 1,
								errorCategories: [`Tier error: ${String(tierError).substring(0, 50)}`],
							});
						}

						// Track result for structured output
						taskResults.push({
							task: task.objective,
							taskId,
							status: "failed",
							error: `Tier error: ${tierError}`,
						});
					}
				}
				totalFailed += tierTasks.length;
			}
		}

		clearGrindProgress();

		// Clean up drain timer if still active
		if (drainTimer) {
			clearTimeout(drainTimer);
		}

		// End grind session logging
		endGrindSession({
			batchId,
			successful: totalSuccessful,
			failed: totalFailed,
			merged: totalMerged,
			durationMs: totalDurationMs,
		});

		const summaryItems = [
			{
				label: "Executed",
				value: totalSuccessful,
				status: totalSuccessful > 0 ? ("good" as const) : ("neutral" as const),
			},
			{ label: "Failed", value: totalFailed, status: totalFailed > 0 ? ("bad" as const) : ("neutral" as const) },
			{ label: "Merged", value: totalMerged },
		];
		if (totalDecomposed > 0) {
			summaryItems.push({ label: "Decomposed", value: totalDecomposed, status: "neutral" as const });
		}
		summaryItems.push(
			{ label: "Model distribution", value: modelCounts as unknown as number, status: "neutral" as const },
			{ label: "Duration", value: Math.round(totalDurationMs / 60000) as number, status: "neutral" as const },
		);

		output.summary("Grind Session Complete", summaryItems);

		// Output structured results for calling session to parse
		output.grindComplete({
			batchId,
			totalTasks: tasksWithModels.length + tasksProcessed,
			successful: totalSuccessful,
			failed: totalFailed,
			merged: totalMerged,
			decomposed: totalDecomposed,
			durationMs: totalDurationMs,
			tasks: taskResults,
		});

		// Show experiment metrics if active
		if (activeExperiment && taskVariantMap.size > 0) {
			const variantMetrics = experimentManager.getVariantMetrics();
			output.info(`Experiment "${activeExperiment.name}" results:`);
			for (const metrics of variantMetrics) {
				const variant = activeExperiment.variants.find((v) => v.id === metrics.variantId);
				if (variant && metrics.totalTasks > 0) {
					output.metrics(`  ${variant.name}`, {
						tasks: metrics.totalTasks,
						successRate: `${(metrics.successRate * 100).toFixed(0)}%`,
						avgDuration: `${Math.round(metrics.avgDurationMs / 1000)}s`,
						avgTokens: Math.round(metrics.avgTokensPerTask),
					});
				}
			}
		}

		// Run post-mortem if requested
		if (options.postmortem) {
			const { handlePostmortem } = await import("./analysis-handlers.js");
			await handlePostmortem({});
		}
	} catch (error) {
		clearGrindProgress();
		output.error(`Grind error: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
}

/**
 * Handle the limits command
 */
export async function handleLimits(): Promise<void> {
	const { loadLiveMetrics } = await import("../live-metrics.js");

	const metricsData = loadLiveMetrics();
	const persistence = new Persistence();
	const savedState = persistence.getRateLimitState();
	const tracker = new RateLimitTracker(savedState ?? undefined);

	// Calculate totals from byModel (more reliable than top-level tokens)
	const models = metricsData.byModel;
	const totalInput = models.opus.input + models.sonnet.input + models.haiku.input;
	const totalOutput = models.opus.output + models.sonnet.output + models.haiku.output;
	const totalTokens = totalInput + totalOutput;

	// Check if there's any data
	if (totalTokens === 0 && metricsData.queries.total === 0) {
		output.info("No usage data yet. Run 'undercity grind' to start processing tasks.");
		return;
	}

	// When was this data from?
	const ageMs = Date.now() - metricsData.updatedAt;
	const ageMinutes = Math.floor(ageMs / 60000);

	output.header("Undercity Usage", ageMinutes > 5 ? `Last updated ${ageMinutes}m ago` : undefined);

	// Check rate limit pause status
	if (tracker.isPaused()) {
		const pauseState = tracker.getPauseState();
		output.warning("Rate limit pause active", {
			reason: pauseState.reason || "Rate limit hit",
			remaining: tracker.formatRemainingTime(),
			resumeAt: pauseState.resumeAt?.toISOString() || "unknown",
		});
	}

	// Metrics output
	output.metrics("Usage summary", {
		queries: {
			successful: metricsData.queries.successful,
			total: metricsData.queries.total,
			rateLimited: metricsData.queries.rateLimited,
		},
		tokens: {
			input: totalInput,
			output: totalOutput,
			total: totalTokens,
		},
		byModel: {
			opus: { tokens: models.opus.input + models.opus.output, cost: models.opus.cost },
			sonnet: { tokens: models.sonnet.input + models.sonnet.output, cost: models.sonnet.cost },
			haiku: { tokens: models.haiku.input + models.haiku.output, cost: models.haiku.cost },
		},
		totalCost: metricsData.cost.total,
	});

	output.info("For live monitoring, run: undercity watch");
}

/**
 * Detect project tooling from package.json and config files
 */
function detectProjectTooling(): {
	packageManager: "npm" | "yarn" | "pnpm" | "bun";
	hasTypescript: boolean;
	testRunner: "vitest" | "jest" | "mocha" | "none";
	linter: "biome" | "eslint" | "none";
	buildTool: "tsc" | "vite" | "webpack" | "esbuild" | "none";
} {
	const result = {
		packageManager: "npm" as "npm" | "yarn" | "pnpm" | "bun",
		hasTypescript: false,
		testRunner: "none" as "vitest" | "jest" | "mocha" | "none",
		linter: "none" as "biome" | "eslint" | "none",
		buildTool: "none" as "tsc" | "vite" | "webpack" | "esbuild" | "none",
	};

	// Detect package manager from lock files
	if (existsSync("pnpm-lock.yaml")) {
		result.packageManager = "pnpm";
	} else if (existsSync("yarn.lock")) {
		result.packageManager = "yarn";
	} else if (existsSync("bun.lockb")) {
		result.packageManager = "bun";
	}

	// Read package.json if it exists
	if (existsSync("package.json")) {
		try {
			const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
			const deps = { ...pkg.dependencies, ...pkg.devDependencies };

			// TypeScript
			result.hasTypescript = "typescript" in deps || existsSync("tsconfig.json");

			// Test runner
			if ("vitest" in deps) {
				result.testRunner = "vitest";
			} else if ("jest" in deps) {
				result.testRunner = "jest";
			} else if ("mocha" in deps) {
				result.testRunner = "mocha";
			}

			// Linter
			if ("@biomejs/biome" in deps || existsSync("biome.json")) {
				result.linter = "biome";
			} else if ("eslint" in deps || existsSync(".eslintrc.js") || existsSync(".eslintrc.json")) {
				result.linter = "eslint";
			}

			// Build tool
			if ("vite" in deps) {
				result.buildTool = "vite";
			} else if ("webpack" in deps) {
				result.buildTool = "webpack";
			} else if ("esbuild" in deps) {
				result.buildTool = "esbuild";
			} else if (result.hasTypescript) {
				result.buildTool = "tsc";
			}
		} catch {
			// Ignore parsing errors
		}
	}

	return result;
}

/**
 * Generate verification commands based on detected tooling
 */
function generateCommands(
	pm: "npm" | "yarn" | "pnpm" | "bun",
	tooling: ReturnType<typeof detectProjectTooling>,
): { typecheck: string; test: string; lint: string; build: string } {
	const run = pm === "npm" ? "npm run" : pm;

	const typecheck = tooling.hasTypescript ? `${run} typecheck` : "echo 'No TypeScript'";

	let test = "echo 'No tests configured'";
	if (tooling.testRunner !== "none") {
		test = `${run} test`;
	}

	let lint = "echo 'No linter configured'";
	if (tooling.linter === "biome") {
		lint = `${run} check`;
	} else if (tooling.linter === "eslint") {
		lint = `${run} lint`;
	}

	let build = "echo 'No build configured'";
	if (tooling.buildTool !== "none") {
		build = `${run} build`;
	}

	return { typecheck, test, lint, build };
}

/**
 * Handle the init command
 */
export function handleInit(options: InitOptions): void {
	console.log(chalk.bold("Initializing Undercity"));

	// Initialize .undercity directory
	const persistence = new Persistence(options.directory);
	const undercityDir = options.directory || ".undercity";
	persistence.initializeUndercity(options.directory);
	console.log(chalk.green(`  Created ${undercityDir}/`));

	// Detect project tooling
	console.log(chalk.dim("  Detecting project tooling..."));
	const detected = detectProjectTooling();
	const commands = generateCommands(detected.packageManager, detected);

	// Create and save project profile
	const profile = {
		packageManager: detected.packageManager,
		commands,
		detected: {
			hasTypescript: detected.hasTypescript,
			testRunner: detected.testRunner,
			linter: detected.linter,
			buildTool: detected.buildTool,
		},
		createdAt: new Date(),
		updatedAt: new Date(),
	};

	if (persistence.hasProfile() && !options.force) {
		console.log(chalk.yellow("  Profile already exists (use --force to overwrite)"));
	} else {
		persistence.saveProfile(profile);
		console.log(chalk.green("  Created project profile"));
	}

	// Show detected tooling
	console.log(chalk.dim(`    Package manager: ${detected.packageManager}`));
	console.log(chalk.dim(`    TypeScript: ${detected.hasTypescript ? "yes" : "no"}`));
	console.log(chalk.dim(`    Test runner: ${detected.testRunner}`));
	console.log(chalk.dim(`    Linter: ${detected.linter}`));
	console.log(chalk.dim(`    Build tool: ${detected.buildTool}`));

	// Find the templates directory (relative to compiled output)
	const templatesDir = join(__dirname, "..", "..", "templates");
	const skillTemplatePath = join(templatesDir, "SKILL.md");

	// Install skill file if template exists
	if (existsSync(skillTemplatePath)) {
		// Create .claude/skills/undercity directory (SKILL.md format)
		const skillsDir = ".claude/skills/undercity";
		if (!existsSync(skillsDir)) {
			mkdirSync(skillsDir, { recursive: true });
			console.log(chalk.green(`  Created ${skillsDir}/`));
		}

		// Copy skill file
		const skillPath = join(skillsDir, "SKILL.md");
		if (existsSync(skillPath) && !options.force) {
			console.log(chalk.yellow(`  ${skillPath} already exists (use --force to overwrite)`));
		} else {
			copyFileSync(skillTemplatePath, skillPath);
			console.log(chalk.green(`  Installed ${skillPath}`));
		}
	} else {
		console.log(chalk.dim("  Skill template not found, skipping skill installation"));
	}

	// Add undercity state files to .gitignore (but NOT tasks.json - that should be tracked)
	const gitignorePath = ".gitignore";
	const gitignorePatterns = `
# Undercity state (local, not tracked)
# Note: .undercity/tasks.json is intentionally NOT ignored - track it for team visibility
.undercity/knowledge.json
.undercity/decisions.json
.undercity/task-file-patterns.json
.undercity/error-fix-patterns.json
.undercity/routing-profile.json
.undercity/parallel-recovery.json
.undercity/rate-limit-state.json
.undercity/live-metrics.json
.undercity/grind-events.jsonl
.undercity/worktree-state.json
.undercity/ast-index.json
.undercity/ax-training.json
.undercity/usage-cache.json
.undercity/daemon.json
.undercity/file-tracking.json
.undercity/grind-progress.json
.undercity/experiments.json
.undercity/profile.json
`;
	if (existsSync(gitignorePath)) {
		const gitignore = readFileSync(gitignorePath, "utf-8");
		if (!gitignore.includes(".undercity/knowledge.json")) {
			appendFileSync(gitignorePath, gitignorePatterns);
			console.log(chalk.green("  Added undercity state files to .gitignore"));
		}
	} else {
		writeFileSync(gitignorePath, `${gitignorePatterns.trim()}\n`);
		console.log(chalk.green("  Created .gitignore with undercity state patterns"));
	}

	// Check efficiency tools for fast-path optimization
	console.log(chalk.dim("  Checking efficiency tools..."));
	// Dynamic import for ESM compatibility
	import("../efficiency-tools.js")
		.then(({ getToolAvailability, getAvailableTools }) => {
			const availability = getToolAvailability();
			const available = getAvailableTools();
			const missing: string[] = [];

			// Check key tools and suggest installation
			const toolInstallHints: Record<string, string> = {
				"ast-grep": "cargo install ast-grep (or brew install ast-grep)",
				jq: "apt install jq (or brew install jq)",
				comby: "bash <(curl -sL get.comby.dev)",
				sd: "cargo install sd",
			};

			for (const [tool, hint] of Object.entries(toolInstallHints)) {
				if (!availability.get(tool)) {
					missing.push(`${tool}: ${hint}`);
				}
			}

			if (available.length > 0) {
				console.log(
					chalk.green(
						`  ${available.length} efficiency tools available: ${available.map((t: { name: string }) => t.name).join(", ")}`,
					),
				);
			}

			if (missing.length > 0) {
				console.log(chalk.yellow("  Optional tools for faster task execution:"));
				for (const m of missing) {
					console.log(chalk.dim(`    ${m}`));
				}
			}

			console.log();
			console.log(chalk.green.bold("Undercity initialized!"));
			console.log(chalk.dim("Run 'undercity tasks' to view the task board"));
			console.log(chalk.dim("Run 'undercity add <task>' to add tasks"));
			console.log(chalk.dim("Run 'undercity grind' to process tasks"));
		})
		.catch(() => {
			// If tools check fails, just continue without it
			console.log();
			console.log(chalk.green.bold("Undercity initialized!"));
			console.log(chalk.dim("Run 'undercity tasks' to view the task board"));
			console.log(chalk.dim("Run 'undercity add <task>' to add tasks"));
			console.log(chalk.dim("Run 'undercity grind' to process tasks"));
		});
}

/**
 * Handle the setup command
 */
export function handleSetup(): void {
	// Claude Max OAuth - no API key needed
	console.log(chalk.green("✓ Using Claude Max OAuth (via Agent SDK)"));
	console.log(chalk.dim("  Run 'undercity usage --login' for first-time auth"));

	const config = loadConfig();
	if (config) {
		console.log(chalk.green("✓ Configuration loaded"));
		const configSource = getConfigSource();
		if (configSource) {
			console.log(chalk.dim(`  Source: ${configSource}`));
		}
	} else {
		console.log(chalk.gray("○ No configuration file found (using defaults)"));
		console.log(chalk.dim("  Create .undercityrc to customize settings"));
	}
}

/**
 * Handle the oracle command
 */
export function handleOracle(situation: string | undefined, options: OracleOptions): void {
	const oracle = new UndercityOracle();

	if (options.allCategories) {
		console.log(chalk.bold("Oracle Categories"));
		console.log("Available categories for filtering:");
		console.log("  • questioning   - Cards that ask probing questions");
		console.log("  • action        - Cards that suggest specific actions");
		console.log("  • perspective   - Cards that shift viewpoint");
		console.log("  • disruption    - Cards that challenge assumptions");
		console.log("  • exploration   - Cards that encourage investigation");
		return;
	}

	const count = Math.min(5, Math.max(1, Number.parseInt(options.count || "1", 10)));

	if (situation) {
		console.log(chalk.bold(`Oracle Consultation: ${situation}`));
	} else {
		console.log(chalk.bold("Oracle Draw"));
	}
	console.log();

	try {
		const cards = oracle.drawSpread(count, options.category as OracleCard["category"]);

		for (let i = 0; i < cards.length; i++) {
			const card = cards[i];
			console.log(chalk.cyan(`Card ${i + 1}:`));
			console.log(`  ${card.text}`);
			console.log(chalk.dim(`  Category: ${card.category}`));
			if (i < cards.length - 1) console.log();
		}

		if (situation) {
			console.log();
			console.log(chalk.dim("Reflect on how these insights apply to your situation."));
		}
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
	}
}

/**
 * Handle the dspy-readiness command
 */
export function handleDspyReadiness(): void {
	console.log(chalk.bold("DSPy Integration Readiness Assessment"));
	console.log();
	console.log(chalk.yellow("⚠️ This feature requires enhanced metrics collection"));
	console.log(chalk.dim("Future implementation will analyze:"));
	console.log(chalk.dim("  • Prompt consistency across tasks"));
	console.log(chalk.dim("  • Model switching patterns"));
	console.log(chalk.dim("  • Output quality variance"));
	console.log(chalk.dim("  • Optimization opportunities"));
}

/**
 * Handle the config command
 */
export async function handleConfig(options: ConfigOptions): Promise<void> {
	if (options.init) {
		const sampleConfig = {
			stream: true,
			verbose: false,
			model: "sonnet",
			worker: "sonnet",
			autoCommit: false,
			typecheck: true,
			parallel: 3,
			maxRetries: 3,
		};

		const fs = await import("node:fs/promises");
		try {
			await fs.writeFile(".undercityrc", JSON.stringify(sampleConfig, null, 2));
			console.log(chalk.green("✓ Created .undercityrc with default settings"));
			console.log(chalk.dim("  Edit this file to customize your preferences"));
		} catch (error) {
			console.error(chalk.red("Failed to create .undercityrc:"), error);
		}
		return;
	}

	const config = loadConfig();
	const configSource = getConfigSource();

	console.log(chalk.bold("Current Configuration"));

	if (configSource) {
		console.log(chalk.green(`✓ Loaded from: ${configSource}`));
	} else {
		console.log(chalk.gray("○ Using built-in defaults"));
	}

	console.log();
	console.log("Settings:");
	if (config) {
		for (const [key, value] of Object.entries(config)) {
			console.log(`  ${key}: ${value}`);
		}
	} else {
		console.log(chalk.dim("  No custom configuration"));
	}

	console.log();
	console.log(chalk.dim("Create .undercityrc to override defaults"));
	console.log(chalk.dim("Use --init to create a sample configuration file"));
}

/**
 * Handle the watch command
 */
export async function handleWatch(): Promise<void> {
	try {
		const { launchDashboard } = await import("../dashboard.js");
		launchDashboard();
	} catch (error) {
		console.error(chalk.red("Dashboard failed to start:"), error);
		console.error(chalk.dim("Make sure blessed and blessed-contrib are installed"));
		process.exit(1);
	}
}

/**
 * Handle the serve command
 */
export async function handleServe(options: ServeOptions): Promise<void> {
	const { UndercityServer, isDaemonRunning, getDaemonState } = await import("../server.js");

	const port = Number.parseInt(options.port || "7331", 10);

	// Check if already running
	if (isDaemonRunning()) {
		const state = getDaemonState();
		console.log(chalk.yellow(`Daemon already running on port ${state?.port} (PID ${state?.pid})`));
		console.log(chalk.dim("Use 'undercity daemon stop' to stop it first"));
		process.exit(1);
	}

	const server = new UndercityServer({
		port,
		onStop: () => {
			console.log(chalk.dim("\nShutdown requested via API"));
		},
	});

	try {
		await server.start();
		console.log(chalk.cyan.bold("\n🌐 Undercity Daemon"));
		console.log(chalk.dim(`  Port: ${port}`));
		console.log(chalk.dim(`  PID: ${process.pid}`));
		console.log();
		console.log("Endpoints:");
		console.log(chalk.dim("  GET  /status   - Session, agents, tasks summary"));
		console.log(chalk.dim("  GET  /tasks    - Full task board"));
		console.log(chalk.dim("  POST /tasks    - Add task { objective, priority? }"));
		console.log(chalk.dim("  GET  /metrics  - Metrics summary"));
		console.log(chalk.dim("  POST /pause    - Pause grind"));
		console.log(chalk.dim("  POST /resume   - Resume grind"));
		console.log(chalk.dim("  POST /stop     - Stop daemon"));
		console.log();
		console.log("Examples:");
		console.log(chalk.dim(`  curl localhost:${port}/status`));
		console.log(chalk.dim(`  curl -X POST localhost:${port}/tasks -d '{"objective":"Fix bug"}'`));
		console.log();
		console.log(chalk.green("Daemon running. Press Ctrl+C to stop."));

		// If --grind flag, also start grind loop
		if (options.grind) {
			console.log(chalk.cyan("\nStarting grind loop..."));
			// TODO: Wire up grind loop with daemon pause/resume
		}

		// Handle graceful shutdown
		process.on("SIGINT", async () => {
			console.log(chalk.dim("\nShutting down..."));
			await server.stop();
			process.exit(0);
		});

		process.on("SIGTERM", async () => {
			await server.stop();
			process.exit(0);
		});
	} catch (error) {
		console.error(chalk.red(`Failed to start daemon: ${error}`));
		process.exit(1);
	}
}

/**
 * Handle the daemon command
 */
export async function handleDaemon(action?: string): Promise<void> {
	const { isDaemonRunning, queryDaemon } = await import("../server.js");

	if (!action || action === "status") {
		if (!isDaemonRunning()) {
			console.log(chalk.gray("Daemon not running"));
			console.log(chalk.dim("Start with: undercity serve"));
			return;
		}

		try {
			const status = (await queryDaemon("/status")) as Record<string, unknown>;
			const daemon = status.daemon as Record<string, unknown>;
			const session = status.session as Record<string, unknown> | null;
			const agents = status.agents as Array<Record<string, unknown>>;
			const tasks = status.tasks as Record<string, number>;

			console.log(chalk.green.bold("✓ Daemon Running"));
			console.log(chalk.dim(`  Port: ${daemon.port} | PID: ${daemon.pid}`));
			console.log(chalk.dim(`  Uptime: ${Math.round(daemon.uptime as number)}s`));
			console.log(chalk.dim(`  State: ${daemon.paused ? chalk.yellow("PAUSED") : chalk.green("active")}`));

			if (session) {
				console.log();
				console.log(chalk.bold("Session:"));
				console.log(chalk.dim(`  ${session.id}: ${session.goal}`));
			}

			if (agents && agents.length > 0) {
				console.log();
				console.log(chalk.bold(`Agents (${agents.length}):`));
				for (const a of agents) {
					console.log(chalk.dim(`  ${a.type}: ${a.status}`));
				}
			}

			console.log();
			console.log(chalk.bold("Tasks:"));
			console.log(chalk.dim(`  ${tasks.pending} pending, ${tasks.inProgress} in progress, ${tasks.complete} complete`));
		} catch (error) {
			console.error(chalk.red(`Failed to query daemon: ${error}`));
		}
	} else if (action === "stop") {
		if (!isDaemonRunning()) {
			console.log(chalk.gray("Daemon not running"));
			return;
		}

		try {
			await queryDaemon("/stop", "POST");
			console.log(chalk.green("Daemon stopping..."));
		} catch {
			// Expected - daemon shuts down
			console.log(chalk.green("Daemon stopped"));
		}
	} else if (action === "pause") {
		if (!isDaemonRunning()) {
			console.log(chalk.gray("Daemon not running"));
			return;
		}

		await queryDaemon("/pause", "POST");
		console.log(chalk.yellow("Grind paused"));
	} else if (action === "resume") {
		if (!isDaemonRunning()) {
			console.log(chalk.gray("Daemon not running"));
			return;
		}

		await queryDaemon("/resume", "POST");
		console.log(chalk.green("Grind resumed"));
	} else if (action === "drain") {
		if (!isDaemonRunning()) {
			console.log(chalk.gray("Daemon not running"));
			return;
		}

		await queryDaemon("/drain", "POST");
		console.log(chalk.yellow("Drain initiated - finishing current tasks, starting no more"));
	} else {
		console.log(chalk.red(`Unknown action: ${action}`));
		console.log(chalk.dim("Available: status, stop, pause, resume, drain"));
	}
}

/**
 * Handle drain command - signal grind to finish current tasks and stop
 */
export async function handleDrain(): Promise<void> {
	const { isDaemonRunning, queryDaemon } = await import("../server.js");

	if (!isDaemonRunning()) {
		console.log(chalk.gray("Daemon not running - nothing to drain"));
		console.log(chalk.dim("Drain is for gracefully stopping a running grind session"));
		return;
	}

	try {
		await queryDaemon("/drain", "POST");
		console.log(chalk.yellow("Drain initiated"));
		console.log(chalk.dim("Current tasks will complete, no new tasks will start"));
	} catch (error) {
		console.error(chalk.red(`Failed to drain: ${error}`));
	}
}

/**
 * Handle the status command
 */
export async function handleStatus(options: StatusOptions): Promise<void> {
	const { getCurrentGrindStatus, readRecentEvents } = await import("../grind-events.js");

	if (options.events) {
		const count = Number.parseInt(options.count || "20", 10);
		const events = readRecentEvents(count);

		if (options.human) {
			for (const event of events) {
				const time = new Date(event.ts).toLocaleTimeString();
				const taskPart = event.task ? ` [${event.task.slice(0, 12)}]` : "";
				// Construct message from event type and data
				let msg = "";
				if (event.type === "task_complete") {
					const e = event as { model: string; attempts: number; secs: number };
					msg = `${e.model} in ${e.attempts} attempts (${e.secs}s)`;
				} else if (event.type === "task_failed") {
					const e = event as { reason: string; model: string; error?: string };
					msg = `${e.reason} [${e.model}] ${e.error || ""}`;
				} else if (event.type === "grind_start") {
					const e = event as { tasks: number; parallelism: number };
					msg = `${e.tasks} tasks, parallelism ${e.parallelism}`;
				} else if (event.type === "grind_end") {
					const e = event as { ok: number; fail: number; mins: number };
					msg = `${e.ok} ok, ${e.fail} fail in ${e.mins}m`;
				}
				console.log(`${chalk.dim(time)}${taskPart} ${chalk.bold(event.type)} ${msg}`);
			}
		} else {
			console.log(JSON.stringify(events, null, 2));
		}
		return;
	}

	const status = getCurrentGrindStatus();

	if (!options.human) {
		console.log(JSON.stringify(status, null, 2));
		return;
	}

	if (!status.isRunning && status.tasksQueued === 0) {
		console.log(chalk.gray("No active or recent grind session"));
		return;
	}

	console.log(status.isRunning ? chalk.green.bold("⚡ Grind Running") : chalk.yellow.bold("○ Grind Complete"));
	console.log(chalk.dim(`  Batch: ${status.batchId || "unknown"}`));
	console.log();
	console.log(chalk.bold("Progress:"));
	console.log(
		`  Queued: ${status.tasksQueued} | Started: ${status.tasksStarted} | Complete: ${status.tasksComplete} | Failed: ${status.tasksFailed}`,
	);
}

/**
 * Index command options
 */
export interface IndexOptions {
	full?: boolean;
	stats?: boolean;
	summaries?: boolean;
}

/**
 * Handle the index command - build/update AST index
 */
export async function handleIndex(options: IndexOptions): Promise<void> {
	const { getASTIndex } = await import("../ast-index.js");

	const index = getASTIndex();
	await index.load();

	if (options.stats) {
		const stats = index.getStats();
		console.log(chalk.bold("AST Index Statistics"));
		console.log(`  Files indexed: ${stats.fileCount}`);
		console.log(`  Symbols tracked: ${stats.symbolCount}`);
		console.log(`  Last updated: ${stats.lastUpdated}`);
		return;
	}

	if (options.summaries) {
		const summaries = index.getAllSummaries();
		if (summaries.length === 0) {
			console.log(chalk.yellow("No summaries available. Run 'undercity index --full' first."));
			return;
		}
		console.log(chalk.bold(`File Summaries (${summaries.length} files)\n`));
		for (const { path, summary } of summaries) {
			console.log(chalk.cyan(path));
			console.log(`  ${summary}\n`);
		}
		return;
	}

	const startTime = Date.now();

	if (options.full) {
		console.log(chalk.blue("Rebuilding full AST index..."));
		await index.rebuildFull();
	} else {
		console.log(chalk.blue("Updating AST index incrementally..."));
		const updated = await index.updateIncremental();
		console.log(chalk.green(`Updated ${updated} files`));
	}

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
	console.log(chalk.dim(`Completed in ${elapsed}s`));
}

/**
 * Introspect command options
 */
export interface IntrospectOptions {
	json?: boolean;
	limit?: string;
	since?: string;
	patterns?: boolean;
}

/**
 * Handle the introspect command - analyze own metrics and performance
 */
export async function handleIntrospect(options: IntrospectOptions): Promise<void> {
	const { getMetricsAnalysis, formatAnalysisSummary, analyzeTaskPatterns, formatPatternSummary } = await import(
		"../feedback-metrics.js"
	);

	const loadOptions: { limit?: number; since?: Date } = {};

	if (options.limit) {
		loadOptions.limit = Number.parseInt(options.limit, 10);
	}

	if (options.since) {
		const date = new Date(options.since);
		if (!Number.isNaN(date.getTime())) {
			loadOptions.since = date;
		}
	}

	// Pattern analysis mode
	if (options.patterns) {
		const patterns = analyzeTaskPatterns(loadOptions);

		if (options.json) {
			console.log(JSON.stringify(patterns, null, 2));
			return;
		}

		console.log(chalk.bold.cyan("\n🧠 Task Pattern Analysis\n"));
		console.log(formatPatternSummary(patterns));
		return;
	}

	const analysis = getMetricsAnalysis(loadOptions);

	if (options.json) {
		console.log(JSON.stringify(analysis, null, 2));
		return;
	}

	// Human-readable output
	console.log(chalk.bold.cyan("\n🔍 Undercity Self-Analysis\n"));
	console.log(formatAnalysisSummary(analysis));

	// Add routing accuracy section if there's data
	if (analysis.totalTasks > 0) {
		console.log("");
		console.log(chalk.bold("Routing Accuracy:"));
		const { correctTier, needsEscalation } = analysis.routingAccuracy;
		const total = correctTier + needsEscalation;
		if (total > 0) {
			const accuracy = ((correctTier / total) * 100).toFixed(0);
			console.log(`  Correct tier on first try: ${accuracy}% (${correctTier}/${total})`);
		}
	}

	// Show escalation paths if any
	if (Object.keys(analysis.escalation.byPath).length > 0) {
		console.log("");
		console.log(chalk.bold("Escalation Paths:"));
		for (const [path, stats] of Object.entries(analysis.escalation.byPath)) {
			const successRate = stats.count > 0 ? ((stats.successCount / stats.count) * 100).toFixed(0) : "0";
			console.log(`  ${path}: ${stats.count} times (${successRate}% success)`);
		}
	}
}

/**
 * Handle the tuning command
 * View and manage the learned model routing profile
 */
export async function handleTuning(options: TuningOptions): Promise<void> {
	const { loadRoutingProfile, saveRoutingProfile, computeOptimalThresholds, formatProfileSummary } = await import(
		"../self-tuning.js"
	);
	const { unlinkSync } = await import("node:fs");

	const profilePath = join(process.cwd(), ".undercity/routing-profile.json");

	// Clear profile if requested
	if (options.clear) {
		try {
			unlinkSync(profilePath);
			console.log(chalk.green("Routing profile cleared. Defaults will be used."));
		} catch {
			console.log(chalk.yellow("No routing profile to clear."));
		}
		return;
	}

	// Rebuild profile if requested
	if (options.rebuild) {
		console.log(chalk.blue("Rebuilding routing profile from metrics..."));
		const profile = computeOptimalThresholds();

		if (profile.taskCount === 0) {
			console.log(chalk.yellow("No metrics found. Run some tasks first."));
			return;
		}

		saveRoutingProfile(profile);
		console.log(chalk.green(`Profile rebuilt from ${profile.taskCount} tasks.`));
		console.log("");
		console.log(formatProfileSummary(profile));
		return;
	}

	// Default: show current profile
	const profile = loadRoutingProfile();

	if (!profile) {
		console.log(chalk.yellow("No routing profile found."));
		console.log("");
		console.log("The routing profile is automatically created after completing tasks.");
		console.log("It learns optimal model thresholds from your task history.");
		console.log("");
		console.log("Use --rebuild to create from existing metrics, or run more tasks.");
		return;
	}

	console.log(formatProfileSummary(profile));
}

/**
 * Handle the usage command - fetch Claude Max usage from claude.ai
 */
export async function handleUsage(options: UsageOptions): Promise<void> {
	const { fetchClaudeUsage, loginToClaude, clearBrowserSession } = await import("../claude-usage.js");

	// Clear session if requested
	if (options.clear) {
		await clearBrowserSession();
		return;
	}

	// Interactive login mode
	if (options.login) {
		const result = await loginToClaude();
		if (result.success) {
			// Verify by fetching usage
			const usage = await fetchClaudeUsage();
			if (usage.success) {
				console.log(chalk.green("Verification successful!"));
				console.log(`  Session: ${usage.fiveHourPercent}% used`);
				console.log(`  Weekly:  ${usage.weeklyPercent}% used`);
			}
		}
		return;
	}

	// Normal headless fetch
	const usage = await fetchClaudeUsage();

	if (!options.human) {
		console.log(JSON.stringify(usage, null, 2));
		return;
	}

	if (usage.needsLogin) {
		console.log(chalk.yellow("Not logged in to Claude."));
		console.log(chalk.dim("Run 'undercity usage --login' to authenticate."));
		return;
	}

	if (!usage.success) {
		console.log(chalk.red("Failed to fetch usage:"), usage.error);
		return;
	}

	console.log(chalk.bold.cyan("\n📊 Claude Max Usage\n"));

	const fiveHrColor =
		usage.fiveHourPercent >= 80 ? chalk.red : usage.fiveHourPercent >= 50 ? chalk.yellow : chalk.green;
	const weeklyColor = usage.weeklyPercent >= 80 ? chalk.red : usage.weeklyPercent >= 50 ? chalk.yellow : chalk.green;

	console.log(`  5-hour session: ${fiveHrColor(`${usage.fiveHourPercent}%`)}`);
	console.log(`  Weekly:         ${weeklyColor(`${usage.weeklyPercent}%`)}`);
	console.log(chalk.dim(`\n  Fetched: ${new Date(usage.fetchedAt).toLocaleTimeString()}`));
}

/**
 * Decision data for JSON output
 */
interface DecideData {
	pending: Array<{
		id: string;
		taskId: string;
		question: string;
		options?: string[];
		context: string;
		category: string;
		capturedAt: string;
	}>;
	stats: {
		pendingCount: number;
		humanRequired: number;
		pmDecidable: number;
		autoHandle: number;
	};
}

/**
 * Handle the decide command - view and resolve pending decisions
 *
 * Decisions are captured during task execution when agents need guidance.
 * This command lets Claude Code review and resolve them.
 */
export async function handleDecide(options: DecideOptions): Promise<void> {
	const { getPendingDecisions, getDecisionsByCategory, resolveDecision, getDecisionStats } = await import(
		"../decision-tracker.js"
	);

	// Resolve a specific decision
	if (options.resolve) {
		if (!options.decision) {
			console.log(chalk.red("Error: --decision is required when using --resolve"));
			console.log(chalk.dim("Usage: undercity decide --resolve <id> --decision '<your decision>'"));
			return;
		}

		const success = resolveDecision(options.resolve, {
			resolvedBy: "human",
			decision: options.decision,
			reasoning: options.reasoning,
		});

		if (success) {
			if (!options.human) {
				console.log(JSON.stringify({ success: true, decisionId: options.resolve }));
			} else {
				console.log(chalk.green(`✓ Decision ${options.resolve} resolved`));
			}
		} else {
			if (!options.human) {
				console.log(JSON.stringify({ success: false, error: "Decision not found" }));
			} else {
				console.log(chalk.red(`✗ Decision ${options.resolve} not found`));
			}
		}
		return;
	}

	// Get pending decisions
	const allPending = getPendingDecisions();
	const humanRequired = getDecisionsByCategory("human_required");
	const pmDecidable = getDecisionsByCategory("pm_decidable");
	const autoHandle = getDecisionsByCategory("auto_handle");
	const stats = getDecisionStats();

	const decideData: DecideData = {
		pending: allPending.map((d) => ({
			id: d.id,
			taskId: d.taskId,
			question: d.question,
			options: d.options,
			context: d.context,
			category: d.category,
			capturedAt: d.capturedAt,
		})),
		stats: {
			pendingCount: allPending.length,
			humanRequired: humanRequired.length,
			pmDecidable: pmDecidable.length,
			autoHandle: autoHandle.length,
		},
	};

	// JSON output (default)
	if (!options.human) {
		console.log(JSON.stringify(decideData, null, 2));
		return;
	}

	// Human-readable output
	console.log(chalk.bold.cyan("\n⚖️  Pending Decisions\n"));

	if (allPending.length === 0) {
		console.log(chalk.dim("No pending decisions."));
		console.log(chalk.dim(`Total resolved: ${stats.resolved}`));
		return;
	}

	console.log(
		chalk.bold(
			`${allPending.length} pending: ${humanRequired.length} human-required, ${pmDecidable.length} PM-decidable, ${autoHandle.length} auto-handle`,
		),
	);
	console.log();

	// Show human-required first (most important)
	if (humanRequired.length > 0) {
		console.log(chalk.red.bold("🚨 Human Required:"));
		for (const d of humanRequired.slice(0, 5)) {
			console.log(chalk.red(`  [${d.id}] ${d.question}`));
			console.log(chalk.dim(`    Task: ${d.taskId}`));
			if (d.options?.length) {
				console.log(chalk.dim(`    Options: ${d.options.join(" | ")}`));
			}
			console.log(chalk.dim(`    Context: ${d.context.substring(0, 100)}...`));
			console.log();
		}
		if (humanRequired.length > 5) {
			console.log(chalk.dim(`  ... and ${humanRequired.length - 5} more`));
		}
	}

	// Show PM-decidable
	if (pmDecidable.length > 0) {
		console.log(chalk.yellow.bold("🤔 PM Decidable:"));
		for (const d of pmDecidable.slice(0, 3)) {
			console.log(chalk.yellow(`  [${d.id}] ${d.question}`));
			console.log(chalk.dim(`    Task: ${d.taskId}`));
		}
		if (pmDecidable.length > 3) {
			console.log(chalk.dim(`  ... and ${pmDecidable.length - 3} more`));
		}
		console.log();
	}

	// Show how to resolve
	console.log(chalk.bold("To resolve a decision:"));
	console.log(chalk.dim("  undercity decide --resolve <id> --decision '<your decision>' [--reasoning '<why>']"));
}

/**
 * Handle the knowledge command - search or list accumulated learnings
 */
export async function handleKnowledge(query: string | undefined, options: KnowledgeOptions): Promise<void> {
	const { findRelevantLearnings, getKnowledgeStats, loadKnowledge } = await import("../knowledge.js");

	// Stats mode - show knowledge base statistics
	if (options.stats) {
		const stats = getKnowledgeStats();
		if (options.human) {
			console.log(chalk.bold("\n📚 Knowledge Base Stats\n"));
			console.log(`  Total learnings: ${chalk.cyan(stats.totalLearnings)}`);
			console.log(`  Average confidence: ${chalk.cyan(`${(stats.avgConfidence * 100).toFixed(1)}%`)}`);
			console.log();
			console.log(chalk.bold("  By category:"));
			console.log(`    Patterns: ${stats.byCategory.pattern}`);
			console.log(`    Gotchas: ${stats.byCategory.gotcha}`);
			console.log(`    Preferences: ${stats.byCategory.preference}`);
			console.log(`    Facts: ${stats.byCategory.fact}`);
			if (stats.mostUsed.length > 0) {
				console.log();
				console.log(chalk.bold("  Most used:"));
				for (const item of stats.mostUsed) {
					console.log(`    - ${item.content} (${item.usedCount} uses)`);
				}
			}
		} else {
			console.log(JSON.stringify(stats, null, 2));
		}
		return;
	}

	// List all mode
	if (options.all) {
		const kb = loadKnowledge();
		const limit = options.limit ? Number.parseInt(options.limit, 10) : 50;
		const learnings = kb.learnings.slice(0, limit);

		if (options.human) {
			console.log(chalk.bold(`\n📚 All Learnings (${learnings.length}/${kb.learnings.length})\n`));
			for (const learning of learnings) {
				const confidenceColor =
					learning.confidence >= 0.7 ? chalk.green : learning.confidence >= 0.4 ? chalk.yellow : chalk.red;
				console.log(`  ${chalk.cyan(`[${learning.category}]`)} ${learning.content}`);
				console.log(
					chalk.dim(
						`    ID: ${learning.id} | Confidence: ${confidenceColor(`${(learning.confidence * 100).toFixed(0)}%`)} | Used: ${learning.usedCount}x`,
					),
				);
				console.log();
			}
			if (kb.learnings.length > limit) {
				console.log(chalk.dim(`  ... and ${kb.learnings.length - limit} more (use --limit to see more)`));
			}
		} else {
			console.log(JSON.stringify({ learnings, total: kb.learnings.length }, null, 2));
		}
		return;
	}

	// Search mode - requires query
	if (!query) {
		if (options.human) {
			console.log(chalk.yellow("Usage: undercity knowledge <search query>"));
			console.log(chalk.dim("       undercity knowledge --stats"));
			console.log(chalk.dim("       undercity knowledge --all"));
		} else {
			console.log(JSON.stringify({ error: "Query required for search. Use --stats or --all for other modes." }));
		}
		return;
	}

	const limit = options.limit ? Number.parseInt(options.limit, 10) : 10;
	const relevant = findRelevantLearnings(query, limit);

	if (options.human) {
		console.log(chalk.bold(`\n🔍 Learnings matching "${query}"\n`));
		if (relevant.length === 0) {
			console.log(chalk.dim("  No relevant learnings found."));
		} else {
			for (const learning of relevant) {
				const confidenceColor =
					learning.confidence >= 0.7 ? chalk.green : learning.confidence >= 0.4 ? chalk.yellow : chalk.red;
				console.log(`  ${chalk.cyan(`[${learning.category}]`)} ${learning.content}`);
				console.log(
					chalk.dim(
						`    Confidence: ${confidenceColor(`${(learning.confidence * 100).toFixed(0)}%`)} | Keywords: ${learning.keywords.slice(0, 5).join(", ")}`,
					),
				);
				console.log();
			}
		}
	} else {
		console.log(JSON.stringify({ query, results: relevant }, null, 2));
	}
}

/**
 * PM command handler - proactive product management
 */
export async function handlePM(topic: string | undefined, options: PMOptions): Promise<void> {
	// Lazy import to avoid circular dependencies
	const { pmResearch, pmPropose, pmIdeate } = await import("../automated-pm.js");
	const { addGoal } = await import("../task.js");
	type TaskProposal = Awaited<ReturnType<typeof pmPropose>>[number];

	const cwd = process.cwd();
	const isHuman = output.isHumanMode();

	// Default to ideate if no specific option chosen
	const mode = options.research ? "research" : options.propose ? "propose" : "ideate";

	if (mode === "ideate" || mode === "research") {
		if (!topic) {
			if (isHuman) {
				console.log(chalk.yellow("Usage: undercity pm <topic> [--research|--propose|--ideate]"));
				console.log(chalk.dim("Examples:"));
				console.log(chalk.dim("  undercity pm 'testing best practices' --research"));
				console.log(chalk.dim("  undercity pm 'code quality improvements' --propose"));
				console.log(chalk.dim("  undercity pm 'error handling patterns' --ideate"));
			} else {
				console.log(JSON.stringify({ error: "Topic required for research or ideate mode" }));
			}
			return;
		}
	}

	try {
		let proposals: TaskProposal[] = [];

		if (mode === "research") {
			if (isHuman) {
				console.log(chalk.cyan(`\n🔬 PM researching: ${topic}\n`));
			}
			const result = await pmResearch(topic!, cwd);
			proposals = result.taskProposals;

			if (isHuman) {
				console.log(chalk.bold("Findings:"));
				for (const finding of result.findings) {
					console.log(`  • ${finding}`);
				}
				console.log();
				console.log(chalk.bold("Recommendations:"));
				for (const rec of result.recommendations) {
					console.log(`  → ${rec}`);
				}
				console.log();
				console.log(chalk.bold("Sources:"));
				for (const source of result.sources) {
					console.log(chalk.dim(`  ${source}`));
				}
			} else {
				console.log(JSON.stringify(result, null, 2));
			}
		} else if (mode === "propose") {
			if (isHuman) {
				console.log(chalk.cyan(`\n💡 PM analyzing codebase${topic ? ` for: ${topic}` : ""}...\n`));
			}
			proposals = await pmPropose(topic, cwd);

			if (isHuman && proposals.length === 0) {
				console.log(chalk.dim("  No proposals generated."));
			}
		} else {
			// ideate mode - full session
			if (isHuman) {
				console.log(chalk.cyan(`\n🧠 PM ideation session: ${topic}\n`));
			}
			const result = await pmIdeate(topic!, cwd);
			proposals = result.proposals;

			if (isHuman) {
				console.log(chalk.bold("Research Findings:"));
				for (const finding of result.research.findings) {
					console.log(`  • ${finding}`);
				}
				console.log();
			} else {
				console.log(JSON.stringify(result, null, 2));
			}
		}

		// Show proposals
		if (proposals.length > 0 && isHuman) {
			console.log(chalk.bold(`\nTask Proposals (${proposals.length}):\n`));
			for (let i = 0; i < proposals.length; i++) {
				const p = proposals[i];
				const priorityColor =
					p.suggestedPriority >= 800 ? chalk.red : p.suggestedPriority >= 600 ? chalk.yellow : chalk.white;
				console.log(`  ${i + 1}. ${p.objective}`);
				console.log(chalk.dim(`     ${p.rationale}`));
				console.log(chalk.dim(`     Priority: ${priorityColor(String(p.suggestedPriority))} | Source: ${p.source}`));
				console.log();
			}
		}

		// Add to board if requested
		if (options.add && proposals.length > 0) {
			if (isHuman) {
				console.log(chalk.yellow("\n⚠️  Adding proposals to task board...\n"));
			}
			for (const p of proposals) {
				const task = addGoal(p.objective, p.suggestedPriority);
				if (isHuman) {
					console.log(chalk.green(`  ✓ Added: ${task.id} - ${p.objective.substring(0, 50)}...`));
				}
			}
			if (!isHuman) {
				console.log(JSON.stringify({ added: proposals.length, taskIds: proposals.map((_, i) => `task-${i}`) }));
			}
		} else if (proposals.length > 0 && isHuman && !options.add) {
			console.log(chalk.dim("Use --add to add these proposals to the task board"));
		}
	} catch (error) {
		if (isHuman) {
			console.log(chalk.red(`\n✗ PM operation failed: ${error}`));
		} else {
			console.log(JSON.stringify({ error: String(error) }));
		}
	}
}
