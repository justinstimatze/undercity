/**
 * Knowledge System Query Examples
 *
 * Demonstrates how workers query and interact with the knowledge system.
 * Run with: npx tsx examples/knowledge-queries.ts
 *
 * NOTE: These examples use a temporary directory to avoid modifying
 * your actual knowledge base. For real usage, omit the stateDir parameter
 * or use ".undercity" as the default.
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
	pruneUnusedLearnings,
} from "../src/knowledge.js";

// Create a temporary directory for examples
const tempDir = mkdtempSync(join(tmpdir(), "knowledge-example-"));
console.log(`Using temporary state directory: ${tempDir}\n`);

// Cleanup on exit
process.on("exit", () => {
	rmSync(tempDir, { recursive: true, force: true });
});

// =============================================================================
// Example 1: Adding Learnings
// =============================================================================

console.log("=== Example 1: Adding Learnings ===\n");

// Add a pattern learning (codebase convention)
const patternLearning = addLearning(
	{
		taskId: "task-001",
		category: "pattern",
		content: "This project uses Zod schemas for all API validation",
		keywords: ["zod", "schema", "validation", "api"],
		structured: {
			file: "src/schemas/",
			pattern: "z.object({ ... })",
		},
	},
	tempDir,
);
console.log("Added pattern learning:", patternLearning.id);

// Add a gotcha learning (pitfall/fix)
const gotchaLearning = addLearning(
	{
		taskId: "task-002",
		category: "gotcha",
		content: "ESM imports require .js extension even for TypeScript files",
		keywords: ["esm", "import", "extension", "typescript", "module"],
	},
	tempDir,
);
console.log("Added gotcha learning:", gotchaLearning.id);

// Add a fact learning (discovery)
const factLearning = addLearning(
	{
		taskId: "task-003",
		category: "fact",
		content: "The cache invalidates automatically after 5 minutes of inactivity",
		keywords: ["cache", "invalidation", "timeout", "minutes"],
		structured: {
			file: "src/cache.ts",
		},
	},
	tempDir,
);
console.log("Added fact learning:", factLearning.id);

// Add a preference learning (user/project preference)
const preferenceLearning = addLearning(
	{
		taskId: "task-004",
		category: "preference",
		content: "Always use execFileSync over execSync for git commands with variables",
		keywords: ["git", "exec", "execfilesync", "security", "command"],
	},
	tempDir,
);
console.log("Added preference learning:", preferenceLearning.id);

console.log("\n");

// =============================================================================
// Example 2: Querying Relevant Learnings
// =============================================================================

console.log("=== Example 2: Querying Relevant Learnings ===\n");

// Query for API-related tasks
const apiLearnings = findRelevantLearnings("Add validation to the REST API endpoint", 5, tempDir);
console.log("Learnings for 'Add validation to the REST API endpoint':");
for (const learning of apiLearnings) {
	console.log(`  - [${learning.category}] ${learning.content}`);
}
console.log();

// Query for import-related tasks
const importLearnings = findRelevantLearnings("Fix module import errors in TypeScript", 5, tempDir);
console.log("Learnings for 'Fix module import errors in TypeScript':");
for (const learning of importLearnings) {
	console.log(`  - [${learning.category}] ${learning.content}`);
}
console.log();

// Query with no matches
const noMatches = findRelevantLearnings("Deploy to Kubernetes cluster", 5, tempDir);
console.log(`Learnings for 'Deploy to Kubernetes cluster': ${noMatches.length} results`);
console.log("\n");

// =============================================================================
// Example 3: Formatting Learnings for Prompts
// =============================================================================

console.log("=== Example 3: Formatting Learnings for Prompts ===\n");

const relevantLearnings = findRelevantLearnings("Implement API validation", 5, tempDir);
const promptSection = formatLearningsForPrompt(relevantLearnings);

console.log("Formatted prompt section:");
console.log("---");
console.log(promptSection);
console.log("---\n");

// =============================================================================
// Example 4: Tracking Learning Usage
// =============================================================================

console.log("=== Example 4: Tracking Learning Usage ===\n");

// Simulate using learnings in a task
const usedLearningIds = [patternLearning.id, gotchaLearning.id];

// Before marking
let kb = loadKnowledge(tempDir);
const beforePattern = kb.learnings.find((l) => l.id === patternLearning.id);
console.log(`Before use - Pattern learning confidence: ${beforePattern?.confidence}`);
console.log(`Before use - Pattern learning usedCount: ${beforePattern?.usedCount}`);

// Mark as successfully used
markLearningsUsed(usedLearningIds, true, tempDir);

// After marking success
kb = loadKnowledge(tempDir);
const afterSuccess = kb.learnings.find((l) => l.id === patternLearning.id);
console.log(`After success - Pattern learning confidence: ${afterSuccess?.confidence}`);
console.log(`After success - Pattern learning usedCount: ${afterSuccess?.usedCount}`);

// Mark as failed use
markLearningsUsed([gotchaLearning.id], false, tempDir);

// After marking failure
kb = loadKnowledge(tempDir);
const afterFailure = kb.learnings.find((l) => l.id === gotchaLearning.id);
console.log(`After failure - Gotcha learning confidence: ${afterFailure?.confidence}`);
console.log("\n");

// =============================================================================
// Example 5: Knowledge Statistics
// =============================================================================

console.log("=== Example 5: Knowledge Statistics ===\n");

const stats = getKnowledgeStats(tempDir);

console.log("Knowledge Base Statistics:");
console.log(`  Total learnings: ${stats.totalLearnings}`);
console.log("  By category:");
for (const [category, count] of Object.entries(stats.byCategory)) {
	console.log(`    - ${category}: ${count}`);
}
console.log(`  Average confidence: ${(stats.avgConfidence * 100).toFixed(1)}%`);
console.log("  Most used learnings:");
for (const { content, usedCount } of stats.mostUsed) {
	console.log(`    - ${content} (used ${usedCount}x)`);
}
console.log("\n");

// =============================================================================
// Example 6: Filtering by Category
// =============================================================================

console.log("=== Example 6: Filtering by Category ===\n");

function findByCategory(objective: string, category: LearningCategory, maxResults: number = 5): Learning[] {
	const allLearnings = loadKnowledge(tempDir).learnings;

	// Extract keywords from objective
	const objectiveKeywords = objective
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2);

	return allLearnings
		.filter((l) => l.category === category)
		.map((l) => {
			const overlap = objectiveKeywords.filter((kw) => l.keywords.includes(kw)).length;
			const score = (overlap / Math.max(objectiveKeywords.length, 1)) * 0.7 + l.confidence * 0.3;
			return { learning: l, score };
		})
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, maxResults)
		.map((item) => item.learning);
}

const gotchas = findByCategory("module import issues", "gotcha");
console.log("Gotchas for 'module import issues':");
for (const learning of gotchas) {
	console.log(`  - ${learning.content}`);
}

const patterns = findByCategory("API validation", "pattern");
console.log("\nPatterns for 'API validation':");
for (const learning of patterns) {
	console.log(`  - ${learning.content}`);
}
console.log("\n");

// =============================================================================
// Example 7: Worker Integration Pattern
// =============================================================================

console.log("=== Example 7: Worker Integration Pattern ===\n");

class ExampleWorker {
	private injectedLearningIds: string[] = [];
	private stateDir: string;
	private lastAgentOutput: string = "";

	constructor(stateDir: string) {
		this.stateDir = stateDir;
	}

	async prepareContext(task: string): Promise<string> {
		let context = "";

		// Query relevant learnings
		const learnings = findRelevantLearnings(task, 5, this.stateDir);

		if (learnings.length > 0) {
			// Format and add to context
			context += formatLearningsForPrompt(learnings);
			context += "\n\n---\n\n";

			// Track for later marking
			this.injectedLearningIds = learnings.map((l) => l.id);
			console.log(`Injected ${learnings.length} learnings into context`);
		} else {
			this.injectedLearningIds = [];
			console.log("No relevant learnings found");
		}

		return context;
	}

	async onTaskSuccess(taskId: string): Promise<void> {
		// Mark used learnings as successful
		if (this.injectedLearningIds.length > 0) {
			markLearningsUsed(this.injectedLearningIds, true, this.stateDir);
			console.log(`Marked ${this.injectedLearningIds.length} learnings as successful`);
		}
	}

	async onTaskFailure(): Promise<void> {
		// Mark used learnings as unsuccessful
		if (this.injectedLearningIds.length > 0) {
			markLearningsUsed(this.injectedLearningIds, false, this.stateDir);
			console.log(`Marked ${this.injectedLearningIds.length} learnings as unsuccessful`);
		}
	}
}

// Simulate worker lifecycle
async function demonstrateWorker(): Promise<void> {
	const worker = new ExampleWorker(tempDir);

	console.log("Worker preparing context for: 'Add Zod validation to API'");
	await worker.prepareContext("Add Zod validation to API");

	console.log("\nSimulating task success...");
	await worker.onTaskSuccess("task-example");
}

demonstrateWorker().catch(console.error);

console.log("\n");

// =============================================================================
// Example 8: Pruning Unused Learnings
// =============================================================================

console.log("=== Example 8: Pruning Unused Learnings ===\n");

// Add some learnings that will be pruned (never used, low confidence)
for (let i = 0; i < 3; i++) {
	addLearning(
		{
			taskId: `prune-task-${i}`,
			category: "fact",
			content: `Test learning ${i} that will be pruned due to no usage`,
			keywords: ["test", "prune", "unused"],
		},
		tempDir,
	);
}

const beforePrune = loadKnowledge(tempDir).learnings.length;
console.log(`Learnings before prune: ${beforePrune}`);

// Prune with a very short max age (0ms means all unused learnings)
const pruned = pruneUnusedLearnings(0, tempDir);
console.log(`Pruned ${pruned} unused learnings`);

const afterPrune = loadKnowledge(tempDir).learnings.length;
console.log(`Learnings after prune: ${afterPrune}`);

console.log("\n");

// =============================================================================
// Example 9: Inspecting the Knowledge Base
// =============================================================================

console.log("=== Example 9: Inspecting the Knowledge Base ===\n");

kb = loadKnowledge(tempDir);

console.log(`Knowledge base version: ${kb.version}`);
console.log(`Last updated: ${kb.lastUpdated}`);
console.log(`Total learnings: ${kb.learnings.length}`);
console.log("\nAll learnings:");

for (const learning of kb.learnings) {
	console.log(`\n  ID: ${learning.id}`);
	console.log(`  Category: ${learning.category}`);
	console.log(`  Content: ${learning.content}`);
	console.log(`  Keywords: ${learning.keywords.join(", ")}`);
	console.log(`  Confidence: ${(learning.confidence * 100).toFixed(0)}%`);
	console.log(`  Used: ${learning.usedCount}x (${learning.successCount} successful)`);
}

console.log("\n=== Examples Complete ===\n");
