/**
 * Worker Knowledge Patterns
 *
 * Real-world usage patterns for workers integrating with the knowledge system.
 * These patterns are extracted from actual worker implementations and demonstrate
 * best practices for querying, injecting, and tracking knowledge.
 *
 * Run with: npx tsx examples/worker-knowledge-patterns.ts
 *
 * NOTE: Uses temporary directory to avoid modifying actual knowledge base.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addLearning,
	findRelevantLearnings,
	formatLearningsForPrompt,
	getKnowledgeStats,
	loadKnowledge,
	type Learning,
	type LearningCategory,
	markLearningsUsed,
} from "../src/knowledge.js";

// =============================================================================
// Setup
// =============================================================================

const tempDir = mkdtempSync(join(tmpdir(), "worker-patterns-"));
console.log(`Using temporary state directory: ${tempDir}\n`);

process.on("exit", () => {
	rmSync(tempDir, { recursive: true, force: true });
});

// Seed some learnings for examples
function seedKnowledge(): void {
	addLearning(
		{
			taskId: "seed-1",
			category: "pattern",
			content: "This project uses Zod schemas for all API validation",
			keywords: ["zod", "schema", "validation", "api"],
		},
		tempDir,
	);

	addLearning(
		{
			taskId: "seed-2",
			category: "gotcha",
			content: "ESM imports require .js extension even for TypeScript files",
			keywords: ["esm", "import", "extension", "typescript", "module"],
		},
		tempDir,
	);

	addLearning(
		{
			taskId: "seed-3",
			category: "gotcha",
			content: "Use execFileSync instead of execSync for git commands with variables to prevent shell injection",
			keywords: ["git", "exec", "security", "shell", "injection"],
		},
		tempDir,
	);

	addLearning(
		{
			taskId: "seed-4",
			category: "fact",
			content: "The cache invalidates automatically after 5 minutes of inactivity",
			keywords: ["cache", "invalidation", "timeout", "minutes"],
		},
		tempDir,
	);

	addLearning(
		{
			taskId: "seed-5",
			category: "preference",
			content: "Always add null checks before accessing nested object properties",
			keywords: ["null", "check", "optional", "chaining", "safety"],
		},
		tempDir,
	);

	addLearning(
		{
			taskId: "seed-6",
			category: "pattern",
			content: "Use atomic file operations (temp file + rename) for crash safety",
			keywords: ["atomic", "file", "write", "crash", "safety", "rename"],
		},
		tempDir,
	);

	console.log("Seeded 6 learnings for examples\n");
}

seedKnowledge();

// =============================================================================
// Pattern 1: Basic Context Preparation
// =============================================================================

console.log("=== Pattern 1: Basic Context Preparation ===\n");

/**
 * Simplest pattern: query and format learnings for prompt injection.
 * Use this when you just need to add relevant knowledge to an agent prompt.
 */
function prepareBasicContext(task: string, stateDir: string): string {
	const learnings = findRelevantLearnings(task, 5, stateDir);

	if (learnings.length === 0) {
		return ""; // No relevant learnings found
	}

	return formatLearningsForPrompt(learnings);
}

const basicContext = prepareBasicContext("Add Zod validation to the API endpoint", tempDir);
console.log("Basic context for 'Add Zod validation to the API endpoint':");
console.log(basicContext || "(no relevant learnings)");
console.log("\n");

// =============================================================================
// Pattern 2: Full Worker Integration
// =============================================================================

console.log("=== Pattern 2: Full Worker Integration ===\n");

/**
 * Complete worker pattern with knowledge tracking throughout the task lifecycle.
 * Tracks which learnings were injected and updates their stats based on outcome.
 */
class KnowledgeAwareWorker {
	private injectedLearningIds: string[] = [];
	private stateDir: string;

	constructor(stateDir: string) {
		this.stateDir = stateDir;
	}

	/**
	 * Phase 1: Prepare context with relevant learnings
	 */
	prepareContext(task: string): { context: string; learningCount: number } {
		const learnings = findRelevantLearnings(task, 5, this.stateDir);

		// Track IDs for later marking
		this.injectedLearningIds = learnings.map((l) => l.id);

		const context = formatLearningsForPrompt(learnings);
		return { context, learningCount: learnings.length };
	}

	/**
	 * Phase 2: Execute task (simulated)
	 */
	async executeTask(task: string, context: string): Promise<boolean> {
		// Simulated task execution
		console.log(`  Executing task with ${this.injectedLearningIds.length} learnings injected`);
		return Math.random() > 0.3; // 70% success rate for demo
	}

	/**
	 * Phase 3a: Record successful outcome
	 */
	recordSuccess(): void {
		if (this.injectedLearningIds.length > 0) {
			markLearningsUsed(this.injectedLearningIds, true, this.stateDir);
			console.log(`  Marked ${this.injectedLearningIds.length} learnings as successful`);
		}
	}

	/**
	 * Phase 3b: Record failed outcome
	 */
	recordFailure(): void {
		if (this.injectedLearningIds.length > 0) {
			markLearningsUsed(this.injectedLearningIds, false, this.stateDir);
			console.log(`  Marked ${this.injectedLearningIds.length} learnings as unsuccessful`);
		}
	}

	/**
	 * Full lifecycle
	 */
	async run(task: string): Promise<boolean> {
		const { context, learningCount } = this.prepareContext(task);
		console.log(`  Prepared context with ${learningCount} learnings`);

		const success = await this.executeTask(task, context);

		if (success) {
			this.recordSuccess();
		} else {
			this.recordFailure();
		}

		return success;
	}
}

// Demo the worker
const worker = new KnowledgeAwareWorker(tempDir);
console.log("Running worker for 'Fix ESM import error in module':");
await worker.run("Fix ESM import error in module");
console.log("\n");

// =============================================================================
// Pattern 3: Category-Specific Filtering
// =============================================================================

console.log("=== Pattern 3: Category-Specific Filtering ===\n");

/**
 * Filter learnings by category for targeted injection.
 * Use this when you want only gotchas for bug fixes, only patterns for features, etc.
 */
function findByCategory(objective: string, category: LearningCategory, maxResults = 5, stateDir: string): Learning[] {
	const kb = loadKnowledge(stateDir);

	// Extract keywords from objective
	const keywords = objective
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2);

	return kb.learnings
		.filter((l) => l.category === category)
		.map((l) => {
			const overlap = keywords.filter((kw) => l.keywords.includes(kw)).length;
			const score = (overlap / Math.max(keywords.length, 1)) * 0.7 + l.confidence * 0.3;
			return { learning: l, score };
		})
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, maxResults)
		.map((item) => item.learning);
}

// Find only gotchas for a bug fix task
const gotchas = findByCategory("Fix shell command injection vulnerability", "gotcha", 5, tempDir);
console.log("Gotchas for 'Fix shell command injection vulnerability':");
for (const g of gotchas) {
	console.log(`  - ${g.content}`);
}
console.log();

// Find only patterns for a feature task
const patterns = findByCategory("Add file write functionality", "pattern", 5, tempDir);
console.log("Patterns for 'Add file write functionality':");
for (const p of patterns) {
	console.log(`  - ${p.content}`);
}
console.log("\n");

// =============================================================================
// Pattern 4: Confidence-Based Filtering
// =============================================================================

console.log("=== Pattern 4: Confidence-Based Filtering ===\n");

/**
 * Filter learnings by confidence threshold.
 * Use higher thresholds for critical tasks, lower for exploratory work.
 */
function findHighConfidenceLearnings(
	objective: string,
	minConfidence: number,
	maxResults = 5,
	stateDir: string,
): Learning[] {
	// Query more than needed, then filter by confidence
	const candidates = findRelevantLearnings(objective, maxResults * 2, stateDir);
	return candidates.filter((l) => l.confidence >= minConfidence).slice(0, maxResults);
}

// First, boost some learnings' confidence by marking as successful
markLearningsUsed([loadKnowledge(tempDir).learnings[0].id], true, tempDir);
markLearningsUsed([loadKnowledge(tempDir).learnings[0].id], true, tempDir);

// Now find high-confidence learnings
const highConf = findHighConfidenceLearnings("Add API validation", 0.55, 5, tempDir);
console.log("High-confidence learnings (>=0.55) for 'Add API validation':");
for (const l of highConf) {
	console.log(`  - [${(l.confidence * 100).toFixed(0)}%] ${l.content}`);
}
console.log("\n");

// =============================================================================
// Pattern 5: Worktree-Safe Queries
// =============================================================================

console.log("=== Pattern 5: Worktree-Safe Queries ===\n");

/**
 * Pattern for workers running in isolated git worktrees.
 * Knowledge is stored in main repo, not the worktree.
 */
class WorktreeWorker {
	private mainRepoStateDir: string;
	private worktreePath: string;
	private injectedLearningIds: string[] = [];

	constructor(mainRepoRoot: string, worktreePath: string) {
		// Knowledge lives in main repo, not worktree
		this.mainRepoStateDir = join(mainRepoRoot, ".undercity");
		this.worktreePath = worktreePath;
	}

	/**
	 * Query knowledge from main repo (shared across all workers)
	 */
	queryKnowledge(task: string): Learning[] {
		// NOTE: Uses mainRepoStateDir, not worktree path
		return findRelevantLearnings(task, 5, this.mainRepoStateDir);
	}

	/**
	 * Mark learnings in main repo (persists after worktree cleanup)
	 */
	markOutcome(success: boolean): void {
		if (this.injectedLearningIds.length > 0) {
			markLearningsUsed(this.injectedLearningIds, success, this.mainRepoStateDir);
		}
	}
}

// Demo (using tempDir as "main repo" for illustration)
const worktreeWorker = new WorktreeWorker(tempDir, "/tmp/worktree-task-123");
const worktreeLearnings = worktreeWorker.queryKnowledge("Add validation");
console.log(`Worktree worker queried ${worktreeLearnings.length} learnings from main repo`);
console.log("\n");

// =============================================================================
// Pattern 6: Safe Error Handling
// =============================================================================

console.log("=== Pattern 6: Safe Error Handling ===\n");

/**
 * Knowledge operations should never fail the task.
 * Wrap calls in try/catch and continue on errors.
 */
async function safeKnowledgeIntegration(task: string, stateDir: string): Promise<{ context: string; ids: string[] }> {
	let context = "";
	let ids: string[] = [];

	try {
		const learnings = findRelevantLearnings(task, 5, stateDir);
		context = formatLearningsForPrompt(learnings);
		ids = learnings.map((l) => l.id);
	} catch (error) {
		console.warn("Knowledge query failed, continuing without learnings:", error);
		// Return empty - task can still proceed
	}

	return { context, ids };
}

function safeMarkUsed(ids: string[], success: boolean, stateDir: string): void {
	try {
		markLearningsUsed(ids, success, stateDir);
	} catch (error) {
		console.warn("Failed to mark learnings, continuing:", error);
		// Non-critical - task already completed
	}
}

// Demo safe handling
const safeResult = await safeKnowledgeIntegration("Add validation", tempDir);
console.log(`Safe query returned ${safeResult.ids.length} learning IDs`);
safeMarkUsed(safeResult.ids, true, tempDir);
console.log("Safe mark completed\n");

// =============================================================================
// Pattern 7: Diagnostic Queries
// =============================================================================

console.log("=== Pattern 7: Diagnostic Queries ===\n");

/**
 * Debug helpers for understanding knowledge base state.
 * Use these when troubleshooting empty or unexpected query results.
 */
function diagnoseKnowledgeBase(stateDir: string): void {
	const kb = loadKnowledge(stateDir);
	const stats = getKnowledgeStats(stateDir);

	console.log("Knowledge Base Diagnosis:");
	console.log(`  Total learnings: ${stats.totalLearnings}`);
	console.log(`  By category:`);
	for (const [cat, count] of Object.entries(stats.byCategory)) {
		console.log(`    - ${cat}: ${count}`);
	}
	console.log(`  Average confidence: ${(stats.avgConfidence * 100).toFixed(1)}%`);

	// Find low-confidence learnings
	const lowConf = kb.learnings.filter((l) => l.confidence < 0.4);
	if (lowConf.length > 0) {
		console.log(`  Low-confidence learnings (<40%): ${lowConf.length}`);
	}

	// Find unused learnings
	const unused = kb.learnings.filter((l) => l.usedCount === 0);
	if (unused.length > 0) {
		console.log(`  Never-used learnings: ${unused.length}`);
	}
}

function diagnoseQueryResult(task: string, stateDir: string): void {
	const learnings = findRelevantLearnings(task, 10, stateDir);

	console.log(`\nQuery diagnosis for: "${task}"`);
	console.log(`  Results: ${learnings.length}`);

	if (learnings.length === 0) {
		console.log("  No results - check if keywords match stored learnings");
	} else {
		for (const l of learnings) {
			console.log(`  - [${l.category}] ${l.content.substring(0, 50)}...`);
			console.log(`    Keywords: ${l.keywords.slice(0, 5).join(", ")}`);
		}
	}
}

diagnoseKnowledgeBase(tempDir);
diagnoseQueryResult("Add API validation", tempDir);
diagnoseQueryResult("Deploy to Kubernetes", tempDir); // Should have no results
console.log("\n");

// =============================================================================
// Pattern 8: Batch Processing
// =============================================================================

console.log("=== Pattern 8: Batch Processing ===\n");

/**
 * Process multiple tasks efficiently with shared knowledge queries.
 * Cache common patterns to avoid repeated queries.
 */
class BatchProcessor {
	private stateDir: string;
	private queryCache = new Map<string, Learning[]>();

	constructor(stateDir: string) {
		this.stateDir = stateDir;
	}

	/**
	 * Get cached or fresh query results
	 */
	private getCachedLearnings(task: string): Learning[] {
		// Simple cache key based on task prefix
		const cacheKey = task.toLowerCase().split(" ").slice(0, 3).join(" ");

		if (this.queryCache.has(cacheKey)) {
			return this.queryCache.get(cacheKey)!;
		}

		const results = findRelevantLearnings(task, 5, this.stateDir);
		this.queryCache.set(cacheKey, results);
		return results;
	}

	/**
	 * Process batch of tasks
	 */
	async processBatch(tasks: string[]): Promise<void> {
		console.log(`Processing ${tasks.length} tasks with cached queries...`);

		for (const task of tasks) {
			const learnings = this.getCachedLearnings(task);
			console.log(`  "${task.substring(0, 30)}..." -> ${learnings.length} learnings`);
		}

		console.log(`Cache size: ${this.queryCache.size} entries`);
	}
}

const batchProcessor = new BatchProcessor(tempDir);
await batchProcessor.processBatch([
	"Add validation to user API",
	"Add validation to product API",
	"Fix import error in utils",
	"Fix import error in handlers",
	"Add cache invalidation logic",
]);
console.log("\n");

// =============================================================================
// Pattern 9: Learning Quality Assessment
// =============================================================================

console.log("=== Pattern 9: Learning Quality Assessment ===\n");

/**
 * Assess learning quality before injection.
 * Useful for filtering out potentially misleading learnings.
 */
interface LearningQuality {
	learning: Learning;
	successRate: number;
	isProven: boolean;
	recommendation: "inject" | "skip" | "monitor";
}

function assessLearningQuality(learning: Learning): LearningQuality {
	const successRate = learning.usedCount > 0 ? learning.successCount / learning.usedCount : 0.5;
	const isProven = learning.usedCount >= 3 && successRate >= 0.7;

	let recommendation: "inject" | "skip" | "monitor";
	if (isProven) {
		recommendation = "inject";
	} else if (learning.usedCount > 5 && successRate < 0.4) {
		recommendation = "skip";
	} else {
		recommendation = "monitor";
	}

	return { learning, successRate, isProven, recommendation };
}

function getQualityFilteredLearnings(task: string, stateDir: string): Learning[] {
	const learnings = findRelevantLearnings(task, 10, stateDir);
	const assessed = learnings.map(assessLearningQuality);

	// Only inject proven or monitor-worthy learnings
	return assessed.filter((a) => a.recommendation !== "skip").map((a) => a.learning);
}

const qualityFiltered = getQualityFilteredLearnings("Add API validation", tempDir);
console.log(`Quality-filtered learnings: ${qualityFiltered.length}`);
for (const l of qualityFiltered) {
	const quality = assessLearningQuality(l);
	console.log(`  [${quality.recommendation}] ${l.content.substring(0, 50)}...`);
}
console.log("\n");

// =============================================================================
// Summary
// =============================================================================

console.log("=== Summary: When to Use Each Pattern ===\n");

console.log("Pattern 1 (Basic): Simple prompt enhancement, one-off tasks");
console.log("Pattern 2 (Full Integration): Standard worker implementation");
console.log("Pattern 3 (Category Filtering): Bug fixes (gotchas), features (patterns)");
console.log("Pattern 4 (Confidence Filtering): Critical vs exploratory tasks");
console.log("Pattern 5 (Worktree-Safe): Parallel execution in isolated worktrees");
console.log("Pattern 6 (Error Handling): Production-ready, fault-tolerant code");
console.log("Pattern 7 (Diagnostics): Debugging empty or unexpected results");
console.log("Pattern 8 (Batch Processing): Multiple similar tasks");
console.log("Pattern 9 (Quality Assessment): Filtering low-quality learnings\n");

console.log("=== Examples Complete ===\n");
