import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { getConfigSource, loadConfig } from "../config.js";
import { type OracleCard, UndercityOracle } from "../oracle.js";
import * as output from "../output.js";
import { Persistence } from "../persistence.js";
import { RateLimitTracker } from "../rate-limit.js";
import { analyzeTasksInPeriod, buildBlockers, buildRecommendations, type LiveUsage } from "./brief-helpers.js";
import {
	addProposalsToBoard,
	displayIdeationFindings,
	displayPMError,
	displayProposals,
	displayResearchResults,
	displayTopicRequired,
	type TaskProposal,
} from "./pm-helpers.js";
import { buildActiveWorkersList, buildAttentionItems, calculatePacing } from "./pulse-helpers.js";

// Re-export grind module
export { type GrindOptions, handleGrind } from "../grind/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Note: GrindOptions and handleGrind are re-exported from ../grind/index.js above

// Type definitions for command options
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
function _getErrorCategory(
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
	const config = tracker.getState().config;
	const pendingCount = summary.pending + summary.inProgress;
	const pacing = calculatePacing(liveUsage, usage, config, pendingCount);

	// Build active workers list with elapsed time
	const activeList = buildActiveWorkersList(activeWorktrees, allTasks);

	// Build attention items
	const recentFailures = allTasks.filter(
		(t) => t.status === "failed" && t.completedAt && new Date(t.completedAt) >= oneHourAgo,
	);
	const attention = buildAttentionItems(humanRequiredDecisions, pendingDecisions, tracker, usage, recentFailures);

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
		pacing,
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
	console.log(`  Budget: ${(pacing.tokenBudget / 1000000).toFixed(1)}M tokens/5hr window`);
	console.log(`  Used: ${(pacing.tokensUsed / 1000).toFixed(0)}K (${pacing.percentUsed}%)`);
	console.log(`  Sustainable pace: ~${pacing.sustainablePaceTasksPerHour} tasks/hour to last 5 hours`);
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

	// Auto-fetch Claude Max usage from claude.ai
	let liveUsage: LiveUsage | null = null;
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
	const pendingCount = summary.pending + summary.inProgress;

	// Analyze tasks using helper
	const analysis = analyzeTasksInPeriod(allTasks, periodStart, hours, pendingCount);
	const { completedInPeriod, failedInPeriod, inProgressTasks, velocity, trend, estimatedClearTime } = analysis;

	// Build blockers and recommendations using helpers
	const blockers = buildBlockers(tracker, pendingDecisions, liveUsage);
	const recommendations = buildRecommendations(analysis, pendingDecisions, liveUsage, usage, pendingCount, hours);

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
 * Emergency mode options
 */
export interface EmergencyOptions {
	status?: boolean;
	clear?: boolean;
	check?: boolean;
	human?: boolean;
}

/**
 * Handle emergency mode commands
 */
export async function handleEmergency(options: EmergencyOptions): Promise<void> {
	const {
		checkMainBranchHealth,
		deactivateEmergencyMode,
		getEmergencyModeStatus,
		isEmergencyModeActive,
		loadEmergencyState,
	} = await import("../emergency-mode.js");

	if (options.clear) {
		if (!isEmergencyModeActive()) {
			console.log(chalk.gray("Emergency mode is not active"));
			return;
		}
		deactivateEmergencyMode();
		console.log(chalk.green("Emergency mode cleared"));
		return;
	}

	if (options.check) {
		console.log(chalk.cyan("Checking main branch health..."));
		const result = await checkMainBranchHealth();
		if (result.healthy) {
			console.log(chalk.green("Main branch is healthy"));
			if (isEmergencyModeActive()) {
				console.log(chalk.yellow("Emergency mode is still active - use --clear to reset"));
			}
		} else {
			console.log(chalk.red(`Main branch is unhealthy: ${result.error || "verification failed"}`));
		}
		return;
	}

	// Default: show status
	const status = getEmergencyModeStatus();
	const state = loadEmergencyState();

	if (!options.human) {
		console.log(JSON.stringify({ ...status, lastError: state.lastError, activatedAt: state.activatedAt }, null, 2));
		return;
	}

	if (!status.active) {
		console.log(chalk.green("Emergency mode: INACTIVE"));
		console.log(chalk.dim("Main branch is healthy, merges can proceed"));
		return;
	}

	console.log(chalk.red("Emergency mode: ACTIVE"));
	console.log();
	console.log(`  Reason: ${chalk.yellow(status.reason || "Unknown")}`);
	if (state.lastError) {
		console.log(`  Error: ${chalk.dim(state.lastError)}`);
	}
	if (status.duration !== undefined) {
		console.log(`  Duration: ${status.duration} minutes`);
	}
	console.log(`  Fix attempts: ${status.fixAttempts}`);
	console.log(`  Fix worker active: ${status.fixWorkerActive ? chalk.cyan("Yes") : chalk.dim("No")}`);
	console.log();
	console.log(chalk.dim("Commands:"));
	console.log(chalk.dim("  undercity emergency --check   # Re-check main branch health"));
	console.log(chalk.dim("  undercity emergency --clear   # Manually clear emergency mode"));
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

	// Check for tasks needing human input
	try {
		const { getTasksNeedingInput, getHumanGuidance } = await import("../human-input-tracking.js");
		const tasksNeedingInput = getTasksNeedingInput();
		if (tasksNeedingInput.length > 0) {
			const withGuidance = tasksNeedingInput.filter((t) => getHumanGuidance(t.errorSignature) !== null).length;
			console.log();
			console.log(chalk.bold("Human Input:"));
			if (withGuidance > 0) {
				console.log(`  ${chalk.cyan(`${withGuidance} task(s) ready to retry`)} (run: undercity human-input --retry)`);
			}
			if (withGuidance < tasksNeedingInput.length) {
				console.log(
					`  ${chalk.yellow(`${tasksNeedingInput.length - withGuidance} task(s) need guidance`)} (run: undercity human-input)`,
				);
			}
		}
	} catch {
		// Non-critical
	}
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

	const cwd = process.cwd();
	const isHuman = output.isHumanMode();

	// Default to ideate if no specific option chosen
	const mode = options.research ? "research" : options.propose ? "propose" : "ideate";

	if ((mode === "ideate" || mode === "research") && !topic) {
		displayTopicRequired(isHuman);
		return;
	}

	try {
		let proposals: TaskProposal[] = [];

		if (mode === "research") {
			if (isHuman) {
				console.log(chalk.cyan(`\n🔬 PM researching: ${topic}\n`));
			}
			const result = await pmResearch(topic!, cwd);
			proposals = result.taskProposals;
			displayResearchResults(result, isHuman);
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
				displayIdeationFindings(result.research.findings);
			} else {
				console.log(JSON.stringify(result, null, 2));
			}
		}

		// Show proposals
		if (proposals.length > 0 && isHuman) {
			displayProposals(proposals);
		}

		// Add to board if requested
		if (options.add && proposals.length > 0) {
			await addProposalsToBoard(proposals, isHuman);
		} else if (proposals.length > 0 && isHuman && !options.add) {
			console.log(chalk.dim("Use --add to add these proposals to the task board"));
		}
	} catch (error) {
		displayPMError(error, isHuman);
	}
}

// =============================================================================
// Human Input Command
// =============================================================================

export interface HumanInputOptions {
	list?: boolean;
	provide?: string;
	guidance?: string;
	retry?: boolean;
	stats?: boolean;
	human?: boolean;
}

/**
 * Handle human-input command - manage human guidance for recurring failures
 */
export async function handleHumanInput(options: HumanInputOptions): Promise<void> {
	const { getTasksNeedingInput, saveHumanGuidance, clearNeedsHumanInput, getHumanInputStats, getHumanGuidance } =
		await import("../human-input-tracking.js");

	const isHuman = options.human ?? output.isHumanMode();

	// Default to --list if no option specified
	const showList = options.list || (!options.provide && !options.stats && !options.retry);

	if (options.retry) {
		// Re-queue tasks that have guidance available
		const { addTask } = await import("../task.js");
		const tasksNeedingInput = getTasksNeedingInput();

		// Filter to tasks that have guidance available
		const retryableTasks = tasksNeedingInput.filter((task) => {
			const guidance = getHumanGuidance(task.errorSignature);
			return guidance !== null;
		});

		if (retryableTasks.length === 0) {
			if (isHuman) {
				const total = tasksNeedingInput.length;
				if (total === 0) {
					console.log(chalk.green("\n✓ No tasks need human input"));
				} else {
					console.log(chalk.yellow(`\n⚠ ${total} task(s) need human input but none have guidance yet`));
					console.log(
						chalk.dim("Provide guidance first with: undercity human-input --provide <signature> --guidance '...'"),
					);
				}
			} else {
				console.log(JSON.stringify({ retried: 0, message: "No tasks with guidance to retry" }));
			}
			return;
		}

		// Re-queue each task with a hint about the guidance
		const requeued: string[] = [];
		for (const task of retryableTasks) {
			const guidance = getHumanGuidance(task.errorSignature);
			if (!guidance) continue;

			// Add task back to board with guidance context
			const newTask = addTask(task.objective, {
				priority: 50, // Higher priority for retries
				handoffContext: {
					isRetry: true,
					humanGuidance: guidance.guidance,
					previousError: task.sampleMessage,
					previousAttempts: task.failedAttempts,
				},
			});

			// Clear from needs_human_input table
			clearNeedsHumanInput(task.taskId);
			requeued.push(newTask.id);
		}

		if (isHuman) {
			console.log(chalk.green(`\n✓ Re-queued ${requeued.length} task(s) with human guidance`));
			console.log(chalk.dim("Run 'undercity grind' to process them"));
		} else {
			console.log(JSON.stringify({ retried: requeued.length, taskIds: requeued }));
		}
		return;
	}

	if (options.stats) {
		// Show stats about human input tracking
		const stats = getHumanInputStats();

		if (isHuman) {
			console.log(chalk.bold("\n📊 Human Input Statistics\n"));
			console.log(`Guidance entries: ${stats.guidanceCount}`);
			console.log(`Successful guidance: ${stats.successfulGuidance}`);
			console.log(`Tasks needing input: ${stats.tasksNeedingInput}`);

			if (stats.topPatterns.length > 0) {
				console.log(chalk.dim("\nTop patterns with guidance:"));
				for (const pattern of stats.topPatterns) {
					const status = pattern.successful ? chalk.green("✓") : chalk.yellow("○");
					console.log(`  ${status} ${pattern.signature.substring(0, 60)}... (used ${pattern.timesUsed}x)`);
				}
			}
		} else {
			console.log(JSON.stringify(stats));
		}
		return;
	}

	if (options.provide) {
		// Provide guidance for a specific error signature
		if (!options.guidance) {
			if (isHuman) {
				console.log(chalk.red("Error: --guidance is required when using --provide"));
				console.log(chalk.dim("Usage: undercity human-input --provide <signature> --guidance 'Your guidance here'"));
			} else {
				console.log(JSON.stringify({ error: "--guidance is required when using --provide" }));
			}
			process.exitCode = 1;
			return;
		}

		const id = saveHumanGuidance(options.provide, options.guidance);

		// Count tasks that match this signature
		const tasksNeedingInput = getTasksNeedingInput();
		const matchingTasks = tasksNeedingInput.filter((task) => task.errorSignature === options.provide);

		if (isHuman) {
			console.log(chalk.green(`\n✓ Guidance saved (${id})`));
			if (matchingTasks.length > 0) {
				console.log(chalk.cyan(`\n${matchingTasks.length} task(s) can now be retried with this guidance.`));
				console.log(chalk.dim("Run: undercity human-input --retry"));
			} else {
				console.log(chalk.dim("This guidance will be applied to future tasks with matching errors."));
			}
		} else {
			console.log(JSON.stringify({ success: true, id, matchingTasks: matchingTasks.length }));
		}
		return;
	}

	if (showList) {
		// List tasks needing human input
		const tasks = getTasksNeedingInput();

		if (tasks.length === 0) {
			if (isHuman) {
				console.log(chalk.green("\n✓ No tasks currently need human input"));
			} else {
				console.log(JSON.stringify({ tasks: [] }));
			}
			return;
		}

		if (isHuman) {
			console.log(chalk.bold(`\n🧑 ${tasks.length} Task(s) Need Human Input\n`));

			// Check which tasks have guidance available
			let withGuidance = 0;
			for (const task of tasks) {
				const guidance = getHumanGuidance(task.errorSignature);
				const hasGuidance = guidance !== null;
				if (hasGuidance) withGuidance++;

				const statusIcon = hasGuidance ? chalk.green("✓") : chalk.yellow("○");
				console.log(`${statusIcon} ${chalk.yellow(`Task: ${task.taskId}`)}`);
				console.log(`  Objective: ${task.objective.substring(0, 80)}${task.objective.length > 80 ? "..." : ""}`);
				console.log(`  Category: ${task.category}`);
				console.log(`  Error: ${task.sampleMessage.substring(0, 100)}${task.sampleMessage.length > 100 ? "..." : ""}`);
				console.log(`  Failed attempts: ${task.failedAttempts} (last model: ${task.modelUsed})`);
				console.log(`  Signature: ${task.errorSignature.substring(0, 60)}...`);
				if (hasGuidance) {
					console.log(chalk.green(`  Has guidance: "${guidance.guidance.substring(0, 50)}..."`));
				} else if (task.previousGuidance) {
					console.log(chalk.dim(`  Previous guidance was tried but didn't help`));
				}
				console.log("");
			}

			// Show next steps
			if (withGuidance > 0) {
				console.log(chalk.cyan(`${withGuidance} task(s) have guidance and can be retried:`));
				console.log(chalk.dim("  undercity human-input --retry"));
				console.log("");
			}
			if (withGuidance < tasks.length) {
				console.log(chalk.dim("To provide guidance for remaining tasks:"));
				console.log(chalk.dim(`  undercity human-input --provide "<signature>" --guidance "Your guidance here"`));
			}
		} else {
			// Include guidance status in JSON output
			const tasksWithStatus = tasks.map((task) => ({
				...task,
				hasGuidance: getHumanGuidance(task.errorSignature) !== null,
			}));
			console.log(JSON.stringify({ tasks: tasksWithStatus }));
		}
	}
}
