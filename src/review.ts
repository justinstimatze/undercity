/**
 * Review module - Escalating code review with multi-tier reviewers
 *
 * Provides:
 * - Escalating review passes (haiku → sonnet → opus)
 * - Multi-lens review (focused review perspectives)
 * - Ticket generation for unresolved issues
 */

import { execSync } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import chalk from "chalk";
import { sessionLogger } from "./logger.js";
import { MODEL_NAMES, type ModelTier } from "./types.js";
import { verifyWork } from "./verification.js";

// Re-export ModelTier for backwards compatibility
export type { ModelTier } from "./types.js";

/**
 * Review pass result
 */
export interface ReviewResult {
	model: ModelTier;
	foundIssues: boolean;
	issues: string[];
	suggestion?: string; // Deprecated - review now fixes directly
	/** True if this pass found no issues (clean pass) */
	passedClean: boolean;
	/** True if the review agent made changes to fix issues */
	madeChanges?: boolean;
	/** Full response text for knowledge extraction */
	responseText?: string;
}

/**
 * Ticket for unresolved issues that review couldn't fix.
 * These get queued as child tasks for the builder to handle.
 */
export interface UnresolvedTicket {
	/** Short title for the ticket */
	title: string;
	/** Detailed description with context */
	description: string;
	/** What was tried and why it failed */
	context: string;
	/** Priority based on issue severity */
	priority: "high" | "medium" | "low";
	/** Files involved */
	files?: string[];
}

/**
 * Run escalating review passes: haiku → sonnet → opus
 * Each tier reviews until it converges (finds nothing), then escalates.
 *
 * Review escalation is capped by maxReviewTier to save tokens on simple tasks.
 * For trivial/simple/standard tasks, we cap at sonnet - opus review is overkill.
 *
 * @param task - The task being reviewed
 * @param useMultiLens - Whether to use multi-lens focused review at opus tier
 * @param maxReviewTier - Maximum tier to escalate to (default: opus)
 * @param maxReviewPassesPerTier - Max passes per tier before escalating
 * @param maxOpusReviewPasses - Max passes at opus tier (no escalation path)
 * @param workingDirectory - Working directory for git operations
 * @param runTypecheck - Whether to run typecheck during verification
 * @param runTests - Whether to run tests during verification
 * @param verbose - Whether to log debug information
 */
export async function runEscalatingReview(
	task: string,
	options: {
		useMultiLens?: boolean;
		maxReviewTier?: ModelTier;
		maxReviewPassesPerTier?: number;
		maxOpusReviewPasses?: number;
		workingDirectory?: string;
		runTypecheck?: boolean;
		runTests?: boolean;
		verbose?: boolean;
	} = {},
): Promise<{
	converged: boolean;
	issuesFound: string[];
	reviewPasses: number;
	finalTier: ModelTier;
	multiLensInsights?: string[];
	/** Tickets for issues that couldn't be fixed - queue these as child tasks */
	unresolvedTickets?: UnresolvedTicket[];
	/** Combined review responses for knowledge extraction */
	reviewOutput?: string;
}> {
	const {
		useMultiLens = false,
		maxReviewTier = "opus",
		maxReviewPassesPerTier = 2,
		maxOpusReviewPasses = maxReviewPassesPerTier * 3,
		workingDirectory = process.cwd(),
		runTypecheck = true,
		runTests = true,
		verbose = false,
	} = options;

	const log = (message: string, data?: Record<string, unknown>): void => {
		if (verbose) {
			sessionLogger.info(data ?? {}, message);
		}
	};

	// INVARIANT: Review tier capped by task complexity. Simple tasks max at sonnet
	// to save tokens; complex/critical tasks can escalate to opus.
	// See: .claude/adrs/0006-review-tier-capping.md
	const allTiers: ModelTier[] = ["sonnet", "sonnet", "opus"];
	const maxTierIndex = allTiers.indexOf(maxReviewTier);
	const tiers = allTiers.slice(0, maxTierIndex + 1);

	const allIssuesFound: string[] = [];
	let totalPasses = 0;
	const multiLensInsights: string[] = [];
	const reviewResponses: string[] = []; // Collect responses for knowledge extraction

	const cappedNote = maxReviewTier !== "opus" ? ` (capped at ${maxReviewTier})` : "";
	console.log(chalk.cyan(`\n  ━━━ Review Passes${cappedNote} ━━━`));

	for (const tier of tiers) {
		// At opus tier, optionally use focused review (advisory mode)
		// Focused review uses Sonnet with deterministic lenses for systematic coverage
		if (tier === "opus" && useMultiLens) {
			console.log(chalk.magenta("  [opus] Focused review (4 lenses × sonnet)"));
			const insights = await runFocusedReview(task, workingDirectory, log, "sonnet");
			multiLensInsights.push(...insights);

			// Still do a final convergence check with standard review
			const finalReview = await runSingleReview(task, "opus", workingDirectory, log);
			totalPasses++;
			if (finalReview.responseText) reviewResponses.push(finalReview.responseText);

			if (finalReview.passedClean) {
				console.log(chalk.green("  [opus] Final check: Converged ✓"));
			} else if (finalReview.madeChanges) {
				console.log(chalk.cyan("  [opus] Final check: Fixed issues"));
				for (const issue of finalReview.issues) {
					console.log(chalk.dim(`    - ${issue.slice(0, 80)}`));
					allIssuesFound.push(issue);
				}
				const verification = await verifyWork(runTypecheck, runTests, workingDirectory);
				if (!verification.passed) {
					return {
						converged: false,
						issuesFound: allIssuesFound,
						reviewPasses: totalPasses,
						finalTier: "opus",
						multiLensInsights,
						reviewOutput: reviewResponses.join("\n\n---\n\n"),
					};
				}
			} else if (finalReview.foundIssues) {
				console.log(chalk.yellow("  [opus] Final check: Found issues (no fix applied)"));
				for (const issue of finalReview.issues) {
					console.log(chalk.dim(`    - ${issue.slice(0, 80)}`));
					allIssuesFound.push(issue);
				}
			}
			continue;
		}

		// Standard tier review loop
		// Final tier gets more passes since there's nowhere to escalate
		const isFinalTier = tier === tiers[tiers.length - 1];
		const maxPasses = isFinalTier ? maxOpusReviewPasses : maxReviewPassesPerTier;
		let tierPasses = 0;
		let tierFoundIssues = false;

		let tierMadeChanges = false;
		while (tierPasses < maxPasses) {
			tierPasses++;
			totalPasses++;

			const review = await runSingleReview(task, tier, workingDirectory, log);
			if (review.responseText) reviewResponses.push(review.responseText);

			if (review.passedClean) {
				// No issues found - tier is clean
				console.log(chalk.green(`  [${tier}] Pass ${tierPasses}/${maxPasses}: No issues found ✓`));
				break;
			}

			if (review.madeChanges) {
				// Review found and fixed issues
				tierFoundIssues = true;
				tierMadeChanges = true;
				console.log(chalk.cyan(`  [${tier}] Pass ${tierPasses}/${maxPasses}: Fixed issues`));
				for (const issue of review.issues) {
					console.log(chalk.dim(`    - ${issue.slice(0, 80)}`));
					allIssuesFound.push(issue);
				}
				// Don't verify after each fix - batch verify at end of tier
			} else if (review.foundIssues) {
				// Found issues but didn't fix - just log and continue
				tierFoundIssues = true;
				console.log(chalk.yellow(`  [${tier}] Pass ${tierPasses}/${maxPasses}: Found issues (no fix applied)`));
				for (const issue of review.issues) {
					console.log(chalk.dim(`    - ${issue.slice(0, 80)}`));
					allIssuesFound.push(issue);
				}
			}
		}

		// Verify once at end of tier if any changes were made
		if (tierMadeChanges) {
			const verification = await verifyWork(runTypecheck, runTests, workingDirectory);
			if (!verification.passed) {
				console.log(chalk.red(`  [${tier}] Verification failed after fixes`));
				return {
					converged: false,
					issuesFound: allIssuesFound,
					reviewPasses: totalPasses,
					finalTier: tier,
					reviewOutput: reviewResponses.join("\n\n---\n\n"),
				};
			}
		}

		// Check if we exhausted all passes without getting a clean review
		const reachedMaxPasses = tierPasses >= maxPasses;
		const lastPassHadIssues = tierFoundIssues && tierPasses >= maxPasses;
		const isLastTier = tier === tiers[tiers.length - 1];

		if (lastPassHadIssues) {
			if (isLastTier) {
				// At final tier (could be opus, sonnet, or haiku depending on cap)
				// No further escalation possible - generate tickets for unresolved issues
				console.log(
					chalk.yellow(`  [${tier}] Exhausted ${maxPasses} passes - generating tickets for unresolved issues`),
				);
				const tickets = generateTicketsFromIssues(task, allIssuesFound, workingDirectory);
				if (tickets.length > 0) {
					console.log(chalk.cyan(`  Generated ${tickets.length} ticket(s) for unresolved issues:`));
					for (const ticket of tickets) {
						console.log(chalk.dim(`    - [${ticket.priority}] ${ticket.title}`));
					}
				}
				return {
					converged: false,
					issuesFound: allIssuesFound,
					reviewPasses: totalPasses,
					finalTier: tier,
					multiLensInsights: multiLensInsights.length > 0 ? multiLensInsights : undefined,
					unresolvedTickets: tickets.length > 0 ? tickets : undefined,
					reviewOutput: reviewResponses.join("\n\n---\n\n"),
				};
			}
			console.log(chalk.yellow(`  [${tier}] Exhausted ${maxPasses} passes, escalating...`));
		} else if (!reachedMaxPasses) {
			// Tier finished cleanly (found no issues on last pass)
			if (tierFoundIssues) {
				console.log(chalk.green(`  [${tier}] Issues fixed, tier complete`));
			}
		}
	}

	// All tiers converged - use the highest tier we actually used
	const highestTierUsed = tiers[tiers.length - 1];
	console.log(chalk.green(`  Review complete: all tiers converged (${totalPasses} passes)`));
	return {
		converged: true,
		issuesFound: allIssuesFound,
		reviewPasses: totalPasses,
		finalTier: highestTierUsed,
		multiLensInsights: multiLensInsights.length > 0 ? multiLensInsights : undefined,
		reviewOutput: reviewResponses.length > 0 ? reviewResponses.join("\n\n---\n\n") : undefined,
	};
}

/**
 * Generate structured tickets from unresolved issues.
 * These tickets provide enough context for the builder to fix them.
 */
function generateTicketsFromIssues(
	originalTask: string,
	issues: string[],
	workingDirectory: string,
): UnresolvedTicket[] {
	if (issues.length === 0) return [];

	// Get current diff for context
	let diffOutput = "";
	let changedFiles: string[] = [];
	try {
		diffOutput = execSync("git diff HEAD --name-only", {
			encoding: "utf-8",
			cwd: workingDirectory,
		});
		changedFiles = diffOutput.trim().split("\n").filter(Boolean);
	} catch {
		// ignore
	}

	// Group similar issues and create tickets
	const tickets: UnresolvedTicket[] = [];

	// Deduplicate and prioritize issues
	const uniqueIssues = [...new Set(issues)].filter((i) => i.length > 10);

	for (const issue of uniqueIssues) {
		// Determine priority based on keywords
		let priority: "high" | "medium" | "low" = "medium";
		const lowerIssue = issue.toLowerCase();
		if (
			lowerIssue.includes("security") ||
			lowerIssue.includes("critical") ||
			lowerIssue.includes("crash") ||
			lowerIssue.includes("data loss")
		) {
			priority = "high";
		} else if (lowerIssue.includes("style") || lowerIssue.includes("naming") || lowerIssue.includes("comment")) {
			priority = "low";
		}

		// Create a concise title from the issue
		const title = issue.length > 80 ? `${issue.slice(0, 77)}...` : issue;

		tickets.push({
			title,
			description: `Fix issue found during review of: ${originalTask}\n\nIssue: ${issue}`,
			context:
				"Review attempted to fix this but couldn't resolve it after multiple passes. The builder should address this specific issue.",
			priority,
			files: changedFiles.length > 0 ? changedFiles : undefined,
		});
	}

	// Sort by priority (high first)
	tickets.sort((a, b) => {
		const order = { high: 0, medium: 1, low: 2 };
		return order[a.priority] - order[b.priority];
	});

	return tickets;
}

/**
 * Run focused review - deterministic multi-lens advisory review
 *
 * Uses evidence-based review lenses that ensure consistent coverage of
 * critical review dimensions: security, error handling, correctness, edge cases.
 *
 * Uses Sonnet for cost efficiency - 4 Sonnet passes (critical + high priority lenses)
 * cost ~80% of 1 Opus pass while providing systematic coverage.
 *
 * @param task - The task being reviewed
 * @param workingDirectory - Working directory for git operations
 * @param log - Logging function
 * @param reviewModel - Model to use for review (default: sonnet)
 */
async function runFocusedReview(
	task: string,
	workingDirectory: string,
	log: (message: string, data?: Record<string, unknown>) => void,
	reviewModel: ModelTier = "sonnet",
): Promise<string[]> {
	const { getQuickReviewLenses, formatLens } = await import("./review-lenses.js");
	const lenses = getQuickReviewLenses(); // Critical + High priority lenses
	const insights: string[] = [];

	let diffOutput = "";
	try {
		diffOutput = execSync("git diff HEAD", {
			encoding: "utf-8",
			cwd: workingDirectory,
			maxBuffer: 1024 * 1024,
		});
	} catch {
		diffOutput = "Unable to get diff";
	}

	if (!diffOutput || diffOutput.trim() === "") {
		log("No diff to review", {});
		return insights;
	}

	for (const lens of lenses) {
		console.log(chalk.dim(`    ${formatLens(lens)}`));

		const reviewPrompt = `You are reviewing code changes. Be specific and actionable.

Task: ${task}

Review Focus (${lens.name}):
${lens.prompt}

Changes:
\`\`\`diff
${diffOutput.slice(0, reviewModel === "opus" ? 24000 : 6000)}
\`\`\`

If you find issues, describe them specifically (file, line if possible, what's wrong).
If nothing notable for this lens, respond with exactly: "Nothing notable."`;

		try {
			let response = "";
			for await (const message of query({
				prompt: reviewPrompt,
				options: {
					maxTurns: 1,
					model: MODEL_NAMES[reviewModel],
					permissionMode: "bypassPermissions",
					allowDangerouslySkipPermissions: true,
					settingSources: ["project"],
				},
			})) {
				if (message.type === "result" && message.subtype === "success") {
					response = message.result;
				}
			}

			if (response && !response.toLowerCase().includes("nothing notable")) {
				insights.push(`[${lens.name}] ${response.trim()}`);
				console.log(chalk.cyan(`      → ${response.trim().slice(0, 80)}...`));
			}
		} catch (error) {
			log("Focused review lens failed", { lens: lens.name, error: String(error) });
		}
	}

	if (insights.length > 0) {
		console.log(chalk.magenta(`    ${insights.length} issue(s) found across ${lenses.length} lenses`));
	} else {
		console.log(chalk.green(`    No issues found across ${lenses.length} lenses`));
	}

	return insights;
}

/**
 * Run a review pass that can directly fix issues.
 *
 * Unlike the old approach (read-only review → parse text → maybe fix),
 * this gives the review agent edit tools to fix issues directly.
 * Much more robust - no fragile text parsing.
 */
async function runSingleReview(
	task: string,
	model: ModelTier,
	workingDirectory: string,
	log: (message: string, data?: Record<string, unknown>) => void,
): Promise<ReviewResult> {
	const modelId = MODEL_NAMES[model];

	let diffOutput = "";
	let filesChangedBefore = 0;
	try {
		diffOutput = execSync("git diff HEAD", {
			encoding: "utf-8",
			cwd: workingDirectory,
			maxBuffer: 1024 * 1024,
		});
		// Count files changed before review
		const statusOutput = execSync("git status --porcelain", {
			encoding: "utf-8",
			cwd: workingDirectory,
		});
		filesChangedBefore = statusOutput.trim().split("\n").filter(Boolean).length;
	} catch {
		diffOutput = "Unable to get diff";
	}

	// Review prompt that encourages fixing, not just finding
	const reviewPrompt = `You are reviewing code changes. Your job is to FIND AND FIX issues.

Task that was implemented: ${task}

Current changes:
\`\`\`diff
${diffOutput.slice(0, model === "opus" ? 24000 : 8000)}
\`\`\`

Review for: bugs, edge cases, security issues, incomplete implementation, task mismatches.

IMPORTANT: If you find issues, FIX THEM directly using the Edit tool. Don't just describe what's wrong.

After reviewing:
- If you fixed issues, end with: ISSUES FIXED: [brief summary]
- If no issues found, end with: LGTM - Ready to commit`;

	try {
		let response = "";
		let madeChanges = false;

		for await (const message of query({
			prompt: reviewPrompt,
			options: {
				maxTurns: 5, // Give it enough turns to review AND fix
				model: modelId,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				settingSources: ["project"],
				// CRITICAL: Use workingDirectory so review edits the correct location (worktree)
				cwd: workingDirectory,
				// Defense-in-depth: explicitly block git push even if settings fail to load
				disallowedTools: ["Bash(git push)", "Bash(git push *)", "Bash(git push -*)", "Bash(git remote push)"],
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				response = message.result;
			}
			// Track if agent used edit tools
			if (message.type === "assistant" && message.message?.content) {
				const content = message.message.content;
				if (Array.isArray(content)) {
					for (const block of content) {
						if (block.type === "tool_use" && (block.name === "Edit" || block.name === "Write")) {
							madeChanges = true;
						}
					}
				}
			}
		}

		// Check if files changed during review (more reliable than tracking tool calls)
		let filesChangedAfter = 0;
		try {
			const statusOutput = execSync("git status --porcelain", {
				encoding: "utf-8",
				cwd: workingDirectory,
			});
			filesChangedAfter = statusOutput.trim().split("\n").filter(Boolean).length;
		} catch {
			// ignore
		}
		const reviewMadeChanges = madeChanges || filesChangedAfter !== filesChangedBefore;

		// Parse response for status
		const lgtm = response.includes("LGTM") || response.includes("Ready to commit");
		const fixedIssues = response.includes("ISSUES FIXED");

		// Extract what was fixed if mentioned
		const issues: string[] = [];
		if (fixedIssues) {
			const fixedMatch = response.match(/ISSUES FIXED:(.+?)(?:\n|$)/i);
			if (fixedMatch) {
				issues.push(fixedMatch[1].trim());
			}
		}

		// foundIssues = reviewer found something to fix
		// passedClean = nothing wrong, ready to commit
		const foundIssues = !lgtm || fixedIssues || reviewMadeChanges;
		const passedClean = lgtm && !reviewMadeChanges;

		return {
			model,
			foundIssues,
			issues,
			suggestion: undefined, // No longer used - fixes applied directly
			passedClean,
			madeChanges: reviewMadeChanges,
			responseText: response, // Capture for knowledge extraction
		};
	} catch (error) {
		log("Review failed", { error: String(error), model });
		return { model, foundIssues: false, issues: [], passedClean: true, responseText: "" };
	}
}
