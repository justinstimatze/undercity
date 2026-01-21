/**
 * Knowledge Command Helpers
 *
 * Extracted display functions for the knowledge command to reduce complexity
 * and improve testability.
 */

import chalk from "chalk";

/**
 * Knowledge stats from the knowledge base
 */
export interface KnowledgeStats {
	totalLearnings: number;
	avgConfidence: number;
	byCategory: {
		pattern: number;
		gotcha: number;
		preference: number;
		fact: number;
	};
	mostUsed: Array<{ content: string; usedCount: number }>;
}

/**
 * A learning entry from the knowledge base
 */
export interface LearningEntry {
	id: string;
	content: string;
	category: string;
	confidence: number;
	keywords: string[];
	usedCount: number;
}

/**
 * Format confidence with color coding
 */
function formatConfidence(confidence: number): string {
	const percent = `${(confidence * 100).toFixed(0)}%`;
	if (confidence >= 0.7) return chalk.green(percent);
	if (confidence >= 0.4) return chalk.yellow(percent);
	return chalk.red(percent);
}

/**
 * Display knowledge base statistics
 */
export function displayKnowledgeStats(stats: KnowledgeStats, isHuman: boolean): void {
	if (!isHuman) {
		console.log(JSON.stringify(stats, null, 2));
		return;
	}

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
}

/**
 * Display all learnings from the knowledge base
 */
export function displayAllLearnings(learnings: LearningEntry[], total: number, isHuman: boolean, limit: number): void {
	if (!isHuman) {
		console.log(JSON.stringify({ learnings, total }, null, 2));
		return;
	}

	console.log(chalk.bold(`\n📚 All Learnings (${learnings.length}/${total})\n`));

	for (const learning of learnings) {
		console.log(`  ${chalk.cyan(`[${learning.category}]`)} ${learning.content}`);
		console.log(
			chalk.dim(
				`    ID: ${learning.id} | Confidence: ${formatConfidence(learning.confidence)} | Used: ${learning.usedCount}x`,
			),
		);
		console.log();
	}

	if (total > limit) {
		console.log(chalk.dim(`  ... and ${total - limit} more (use --limit to see more)`));
	}
}

/**
 * Display search results
 */
export function displaySearchResults(query: string, results: LearningEntry[], isHuman: boolean): void {
	if (!isHuman) {
		console.log(JSON.stringify({ query, results }, null, 2));
		return;
	}

	console.log(chalk.bold(`\n🔍 Learnings matching "${query}"\n`));

	if (results.length === 0) {
		console.log(chalk.dim("  No relevant learnings found."));
		return;
	}

	for (const learning of results) {
		console.log(`  ${chalk.cyan(`[${learning.category}]`)} ${learning.content}`);
		console.log(
			chalk.dim(
				`    Confidence: ${formatConfidence(learning.confidence)} | Keywords: ${learning.keywords.slice(0, 5).join(", ")}`,
			),
		);
		console.log();
	}
}

/**
 * Display usage instructions when query is missing
 */
export function displayKnowledgeUsage(isHuman: boolean): void {
	if (!isHuman) {
		console.log(JSON.stringify({ error: "Query required for search. Use --stats or --all for other modes." }));
		return;
	}

	console.log(chalk.yellow("Usage: undercity knowledge <search query>"));
	console.log(chalk.dim("       undercity knowledge --stats"));
	console.log(chalk.dim("       undercity knowledge --all"));
}
