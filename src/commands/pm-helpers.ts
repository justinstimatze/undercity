/**
 * PM Command Helpers
 *
 * Extracted helper functions for the PM command to reduce complexity.
 */

import chalk from "chalk";
import type { TaskProposal } from "../automated-pm.js";
import { validateTaskObjective } from "../task-security.js";

// Re-export TaskProposal for backwards compatibility
export type { TaskProposal };

/**
 * Research result structure
 */
export interface ResearchResult {
	findings: string[];
	recommendations: string[];
	sources: string[];
	taskProposals: TaskProposal[];
}

/**
 * Ideation result structure
 */
export interface IdeationResult {
	research: {
		findings: string[];
	};
	proposals: TaskProposal[];
}

/**
 * Display research results in human or JSON format
 */
export function displayResearchResults(result: ResearchResult, isHuman: boolean): void {
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
}

/**
 * Display ideation research findings in human format
 */
export function displayIdeationFindings(findings: string[]): void {
	console.log(chalk.bold("Research Findings:"));
	for (const finding of findings) {
		console.log(`  • ${finding}`);
	}
	console.log();
}

/**
 * Display task proposals in human-readable format
 */
export function displayProposals(proposals: TaskProposal[]): void {
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

/**
 * Add proposals to the task board
 * Validates proposals for security before adding
 */
export async function addProposalsToBoard(
	proposals: TaskProposal[],
	isHuman: boolean,
): Promise<{ added: number; taskIds: string[]; rejected: number }> {
	const { addTask } = await import("../task.js");
	const { proposalToTaskOptions } = await import("../automated-pm.js");
	const taskIds: string[] = [];
	let rejected = 0;

	if (isHuman) {
		console.log(chalk.yellow("\n⚠️  Adding proposals to task board...\n"));
	}

	for (const p of proposals) {
		// Validate proposal objective before adding
		const validation = validateTaskObjective(p.objective);
		if (!validation.isSafe) {
			rejected++;
			if (isHuman) {
				console.log(chalk.red(`  ✗ Rejected: ${p.objective.substring(0, 50)}...`));
				console.log(chalk.dim(`    Reason: ${validation.rejectionReasons.join(", ")}`));
			}
			continue;
		}

		// Log warnings for suspicious but allowed proposals
		if (validation.warnings.length > 0 && isHuman) {
			console.log(chalk.yellow(`  ⚠ Warning for: ${p.objective.substring(0, 50)}...`));
			console.log(chalk.dim(`    ${validation.warnings.join("; ")}`));
		}

		// Use proposalToTaskOptions to preserve rich context as ticket content
		const task = addTask(p.objective, proposalToTaskOptions(p));
		taskIds.push(task.id);
		if (isHuman) {
			console.log(chalk.green(`  ✓ Added: ${task.id} - ${p.objective.substring(0, 50)}...`));
		}
	}

	if (!isHuman) {
		console.log(JSON.stringify({ added: taskIds.length, taskIds, rejected }));
	} else if (rejected > 0) {
		console.log(chalk.yellow(`\n${rejected} proposal(s) rejected for security reasons.`));
	}

	return { added: taskIds.length, taskIds, rejected };
}

/**
 * Display missing topic error
 */
export function displayTopicRequired(isHuman: boolean): void {
	if (isHuman) {
		console.log(chalk.yellow("Usage: undercity pm <topic> [--research|--propose|--ideate]"));
		console.log(chalk.dim("Examples:"));
		console.log(chalk.dim("  undercity pm 'testing best practices' --research"));
		console.log(chalk.dim("  undercity pm 'code quality improvements' --propose"));
		console.log(chalk.dim("  undercity pm 'error handling patterns' --ideate"));
	} else {
		console.log(JSON.stringify({ error: "Topic required for research or ideate mode" }));
	}
}

/**
 * Display PM error
 */
export function displayPMError(error: unknown, isHuman: boolean): void {
	if (isHuman) {
		console.log(chalk.red(`\n✗ PM operation failed: ${error}`));
	} else {
		console.log(JSON.stringify({ error: String(error) }));
	}
}
