/**
 * Smart Task Router
 *
 * Routes tasks to the optimal execution path:
 * 1. Local tools only (FREE) - linting, formatting, simple refactors
 * 2. Local LLM (FREE) - trivial tasks, summarization
 * 3. Haiku (CHEAP) - simple code tasks, exploration
 * 4. Sonnet (MODERATE) - standard implementation
 * 5. Opus (EXPENSIVE) - complex architecture, critical review
 *
 * Goal: Maximum throughput under plan limits
 */

import { execSync } from "node:child_process";
import { getCache } from "./cache.js";
import { assessComplexityFast, type ComplexityLevel } from "./complexity.js";
import { canHandleLocally, isOllamaAvailable } from "./local-llm.js";
import { raidLogger } from "./logger.js";

/**
 * Execution tier from cheapest to most expensive
 */
export type ExecutionTier = "local-tools" | "local-llm" | "haiku" | "sonnet" | "opus";

/**
 * Task routing decision
 */
export interface RoutingDecision {
	tier: ExecutionTier;
	reason: string;
	confidence: number;
	estimatedTokens: number;
	canParallelize: boolean;
	suggestedBatchSize?: number;
}

/**
 * Patterns that can be handled by local tools alone (no LLM)
 */
const LOCAL_TOOL_PATTERNS: Array<{ pattern: RegExp; tool: string }> = [
	{ pattern: /^(run\s+)?(format|prettier|biome\s+format)/i, tool: "pnpm format" },
	{ pattern: /^(run\s+)?(lint|biome\s+lint)/i, tool: "pnpm lint:fix" },
	{ pattern: /^(run\s+)?typecheck/i, tool: "pnpm typecheck" },
	{ pattern: /^(run\s+)?test/i, tool: "pnpm test" },
	{ pattern: /^(run\s+)?build/i, tool: "pnpm build" },
	{ pattern: /^organize\s+imports/i, tool: "pnpm check:fix" },
	{ pattern: /^sort\s+imports/i, tool: "pnpm check:fix" },
];

/**
 * Patterns that suggest trivial tasks (local LLM can handle)
 */
const TRIVIAL_PATTERNS = [
	/^fix\s+(the\s+)?typo/i,
	/^update\s+(the\s+)?comment/i,
	/^add\s+(a\s+)?comment/i,
	/^remove\s+unused/i,
	/^delete\s+unused/i,
	/^rename\s+\w+\s+to\s+\w+$/i,
	/^change\s+\w+\s+to\s+\w+$/i,
	/^update\s+version/i,
	/^bump\s+version/i,
];

/**
 * Patterns that require Opus (expensive but necessary)
 */
const OPUS_REQUIRED_PATTERNS = [
	/security/i,
	/authentication/i,
	/authorization/i,
	/payment/i,
	/encrypt/i,
	/credential/i,
	/password/i,
	/secret/i,
	/migrate\s+database/i,
	/breaking\s+change/i,
	/refactor.*architecture/i,
	/redesign/i,
];

/**
 * Route a task to optimal execution tier
 */
export async function routeTask(task: string): Promise<RoutingDecision> {
	// 1. Check if local tools can handle it (FREE)
	const localTool = canHandleWithLocalTools(task);
	if (localTool) {
		return {
			tier: "local-tools",
			reason: `Can run: ${localTool}`,
			confidence: 1.0,
			estimatedTokens: 0,
			canParallelize: true,
			suggestedBatchSize: 10,
		};
	}

	// 2. Check for trivial patterns (local LLM)
	if (isTrivialTask(task)) {
		const hasOllama = isOllamaAvailable();
		if (hasOllama) {
			const canHandle = await canHandleLocally(task);
			if (canHandle) {
				return {
					tier: "local-llm",
					reason: "Trivial task, local LLM can handle",
					confidence: 0.8,
					estimatedTokens: 0,
					canParallelize: true,
					suggestedBatchSize: 5,
				};
			}
		}
		// Fall through to haiku if no local LLM
		return {
			tier: "haiku",
			reason: "Trivial task, using cheapest cloud model",
			confidence: 0.9,
			estimatedTokens: 500,
			canParallelize: true,
			suggestedBatchSize: 5,
		};
	}

	// 3. Check if Opus is required (security, breaking changes)
	if (requiresOpus(task)) {
		return {
			tier: "opus",
			reason: "Security/critical task requires best model",
			confidence: 0.95,
			estimatedTokens: 5000,
			canParallelize: false,
		};
	}

	// 4. Use complexity assessment for remaining tasks
	const assessment = assessComplexityFast(task);
	return routeByComplexity(assessment.level, task);
}

/**
 * Check if task can be handled by local tools alone
 */
function canHandleWithLocalTools(task: string): string | null {
	for (const { pattern, tool } of LOCAL_TOOL_PATTERNS) {
		if (pattern.test(task)) {
			return tool;
		}
	}
	return null;
}

/**
 * Check if task is trivial
 */
function isTrivialTask(task: string): boolean {
	return TRIVIAL_PATTERNS.some((p) => p.test(task));
}

/**
 * Check if task requires Opus
 */
function requiresOpus(task: string): boolean {
	return OPUS_REQUIRED_PATTERNS.some((p) => p.test(task));
}

/**
 * Route by complexity level
 */
function routeByComplexity(level: ComplexityLevel, task: string): RoutingDecision {
	switch (level) {
		case "trivial":
			return {
				tier: "haiku",
				reason: "Trivial complexity",
				confidence: 0.85,
				estimatedTokens: 300,
				canParallelize: true,
				suggestedBatchSize: 5,
			};

		case "simple":
			return {
				tier: "haiku",
				reason: "Simple task, haiku should handle",
				confidence: 0.8,
				estimatedTokens: 800,
				canParallelize: true,
				suggestedBatchSize: 3,
			};

		case "standard":
			return {
				tier: "sonnet",
				reason: "Standard complexity, sonnet optimal",
				confidence: 0.85,
				estimatedTokens: 2000,
				canParallelize: true,
				suggestedBatchSize: 2,
			};

		case "complex":
			return {
				tier: "sonnet",
				reason: "Complex but sonnet can handle with escalation",
				confidence: 0.7,
				estimatedTokens: 4000,
				canParallelize: false,
			};

		case "critical":
			return {
				tier: "opus",
				reason: "Critical task needs best judgment",
				confidence: 0.9,
				estimatedTokens: 6000,
				canParallelize: false,
			};

		default:
			return {
				tier: "sonnet",
				reason: "Default to sonnet",
				confidence: 0.5,
				estimatedTokens: 2000,
				canParallelize: true,
			};
	}
}

/**
 * Execute a task with local tools only
 */
export async function executeWithLocalTools(task: string): Promise<{
	success: boolean;
	output: string;
}> {
	const tool = canHandleWithLocalTools(task);
	if (!tool) {
		return { success: false, output: "No matching local tool" };
	}

	try {
		const output = execSync(tool, {
			encoding: "utf-8",
			cwd: process.cwd(),
			timeout: 120000,
		});
		return { success: true, output };
	} catch (error) {
		const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
		return { success: false, output };
	}
}

/**
 * Batch similar tasks for efficiency
 */
export async function batchTasks(tasks: string[]): Promise<Map<ExecutionTier, string[]>> {
	const batches = new Map<ExecutionTier, string[]>();

	for (const task of tasks) {
		const decision = await routeTask(task);
		const existing = batches.get(decision.tier) || [];
		existing.push(task);
		batches.set(decision.tier, existing);
	}

	return batches;
}

/**
 * Estimate total tokens for a batch of tasks
 */
export async function estimateBatchTokens(tasks: string[]): Promise<{
	total: number;
	byTier: Map<ExecutionTier, number>;
}> {
	const byTier = new Map<ExecutionTier, number>();
	let total = 0;

	for (const task of tasks) {
		const decision = await routeTask(task);
		const current = byTier.get(decision.tier) || 0;
		byTier.set(decision.tier, current + decision.estimatedTokens);
		total += decision.estimatedTokens;
	}

	return { total, byTier };
}

/**
 * Optimize task order for throughput
 * - Run local tools first (instant)
 * - Batch cheap tasks together
 * - Run expensive tasks last
 */
export async function optimizeTaskOrder(tasks: string[]): Promise<string[]> {
	const withDecisions = await Promise.all(
		tasks.map(async (task) => ({
			task,
			decision: await routeTask(task),
		})),
	);

	// Sort by tier (cheapest first)
	const tierOrder: ExecutionTier[] = ["local-tools", "local-llm", "haiku", "sonnet", "opus"];

	withDecisions.sort((a, b) => {
		const aIndex = tierOrder.indexOf(a.decision.tier);
		const bIndex = tierOrder.indexOf(b.decision.tier);
		return aIndex - bIndex;
	});

	return withDecisions.map((w) => w.task);
}

/**
 * Check if we should use cached result
 */
export function checkCache(task: string): string | null {
	const cache = getCache();

	// Check for similar previous fixes
	const fixes = cache.findSimilarFixes(task);
	if (fixes.length > 0 && fixes[0].success) {
		raidLogger.debug({ task, cachedFix: fixes[0].fix }, "Found cached fix");
		return fixes[0].fix;
	}

	return null;
}

/**
 * Log routing statistics
 */
export function logRoutingStats(decisions: RoutingDecision[]): void {
	const stats = {
		total: decisions.length,
		byTier: {} as Record<ExecutionTier, number>,
		totalTokens: 0,
		parallelizable: 0,
	};

	for (const d of decisions) {
		stats.byTier[d.tier] = (stats.byTier[d.tier] || 0) + 1;
		stats.totalTokens += d.estimatedTokens;
		if (d.canParallelize) stats.parallelizable++;
	}

	raidLogger.info(stats, "Task routing statistics");
}
