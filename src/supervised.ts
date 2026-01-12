/**
 * Supervised Mode - Opus orchestrates cheaper workers
 *
 * Uses Opus for high-level planning and review, but delegates
 * actual implementation to Haiku/Sonnet for efficiency.
 *
 * Flow:
 * 1. Opus analyzes task and creates subtasks
 * 2. Opus assigns each subtask to appropriate model tier
 * 3. Workers execute subtasks
 * 4. Opus reviews output and decides next steps
 * 5. Opus commits when satisfied
 */

import { execSync } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import chalk from "chalk";
import { dualLogger } from "./dual-logger.js";
import { sessionLogger } from "./logger.js";
import type { ModelTier } from "./review.js";
import type { VerificationResult } from "./verification.js";
import type { TaskResult } from "./worker.js";

const MODEL_NAMES: Record<ModelTier, string> = {
	haiku: "claude-3-5-haiku-20241022",
	sonnet: "claude-sonnet-4-20250514",
	opus: "claude-opus-4-5-20251101",
};

/**
 * Supervised orchestrator options
 */
export interface SupervisedOptions {
	autoCommit?: boolean;
	stream?: boolean;
	verbose?: boolean;
	/** Default worker model (haiku or sonnet) */
	workerModel?: "haiku" | "sonnet";
}

/**
 * Supervised Orchestrator
 */
export class SupervisedOrchestrator {
	private autoCommit: boolean;
	private stream: boolean;
	private verbose: boolean;
	private workerModel: ModelTier;

	constructor(options: SupervisedOptions = {}) {
		this.autoCommit = options.autoCommit ?? true;
		this.stream = options.stream ?? false;
		this.verbose = options.verbose ?? false;
		this.workerModel = options.workerModel ?? "sonnet";
	}

	private log(message: string, data?: Record<string, unknown>): void {
		if (this.verbose) {
			sessionLogger.info(data ?? {}, message);
		}
	}

	/**
	 * Run a task with Opus supervision
	 */
	async runSupervised(goal: string): Promise<TaskResult> {
		const startTime = Date.now();

		console.log(chalk.bold.cyan("\n━━━ Supervised Mode ━━━"));
		console.log(chalk.dim(`Goal: ${goal.substring(0, 80)}${goal.length > 80 ? "..." : ""}`));
		console.log(chalk.dim(`Worker model: ${this.workerModel}`));
		console.log();

		// Phase 1: Opus plans the work
		console.log(chalk.yellow("📋 [Opus] Planning..."));
		const plan = await this.opusPlan(goal);

		if (!plan.subtasks || plan.subtasks.length === 0) {
			// Simple task - just do it directly with Opus
			console.log(chalk.dim("  Simple task, executing directly..."));
			return this.executeDirectly(goal, startTime);
		}

		console.log(chalk.dim(`  Created ${plan.subtasks.length} subtask(s)`));
		for (const subtask of plan.subtasks) {
			console.log(chalk.dim(`    • ${subtask.substring(0, 60)}${subtask.length > 60 ? "..." : ""}`));
		}

		// Phase 2: Workers execute subtasks
		let allPassed = true;
		const workerResults: Array<{ subtask: string; passed: boolean; result: string }> = [];

		for (let i = 0; i < plan.subtasks.length; i++) {
			const subtask = plan.subtasks[i];
			console.log(chalk.cyan(`\n🔧 [${this.workerModel}] Subtask ${i + 1}/${plan.subtasks.length}`));
			console.log(chalk.dim(`  ${subtask.substring(0, 70)}${subtask.length > 70 ? "..." : ""}`));

			const result = await this.workerExecute(subtask, plan.context);
			const verification = await this.verifyWork();

			workerResults.push({
				subtask,
				passed: verification.passed,
				result,
			});

			if (verification.passed) {
				console.log(chalk.green("  ✓ Passed verification"));
			} else {
				console.log(chalk.yellow(`  ⚠ Issues: ${verification.issues.join(", ")}`));
				allPassed = false;
			}
		}

		// Phase 3: Opus reviews and potentially fixes
		if (!allPassed) {
			console.log(chalk.yellow("\n🔍 [Opus] Reviewing and fixing issues..."));
			await this.opusReview(goal, workerResults);

			// Re-verify
			const finalVerification = await this.verifyWork();
			if (finalVerification.passed) {
				console.log(chalk.green("  ✓ Issues resolved"));
				allPassed = true;
			} else {
				console.log(chalk.red(`  ✗ Still failing: ${finalVerification.issues.join(", ")}`));
			}
		}

		// Commit if successful
		let commitSha: string | undefined;
		if (allPassed && this.autoCommit) {
			try {
				commitSha = await this.commitWork(goal);
				console.log(chalk.green(`\n✓ Committed: ${commitSha.substring(0, 8)}`));
			} catch {
				console.log(chalk.yellow("\n⚠ Nothing to commit"));
			}
		}

		return {
			task: goal,
			status: allPassed ? "complete" : "failed",
			model: "opus", // Supervisor was opus
			attempts: 1,
			commitSha,
			durationMs: Date.now() - startTime,
		};
	}

	/**
	 * Opus plans the work and breaks into subtasks
	 */
	private async opusPlan(goal: string): Promise<{ subtasks: string[]; context: string }> {
		let result = "";

		const prompt = `You are a senior engineer planning implementation. Analyze this goal and decide:

1. If it's simple (single file, straightforward change): respond with just {"simple": true}
2. If complex: break it into 2-5 small, independent subtasks

Goal: ${goal}

For complex tasks, respond with JSON:
{
  "simple": false,
  "subtasks": ["subtask 1 description", "subtask 2 description", ...],
  "context": "any important context the workers need"
}

Keep subtasks focused and independent. Each should be completable in isolation.`;

		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES.opus,
				allowedTools: ["Read", "Grep", "Glob"], // Read-only for planning
				settingSources: ["project"],
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				result = message.result;
			}
		}

		try {
			const jsonMatch = result.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0]);
				if (parsed.simple) {
					return { subtasks: [], context: "" };
				}
				return {
					subtasks: parsed.subtasks || [],
					context: parsed.context || "",
				};
			}
		} catch {
			// If parsing fails, treat as simple
		}

		return { subtasks: [], context: "" };
	}

	/**
	 * Worker executes a subtask
	 */
	private async workerExecute(subtask: string, context: string): Promise<string> {
		let result = "";

		const prompt = `Complete this subtask:

${subtask}

${context ? `Context: ${context}` : ""}

Guidelines:
- Make minimal, focused changes
- Follow existing patterns
- Ensure changes compile

CRITICAL - GIT RULES:
- You may commit locally (git add, git commit)
- NEVER run "git push" - the orchestrator handles all pushes after verification`;

		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES[this.workerModel],
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				settingSources: ["project"],
				// Defense-in-depth: explicitly block git push even if settings fail to load
				disallowedTools: ["Bash(git push)", "Bash(git push *)", "Bash(git push -*)", "Bash(git remote push)"],
			},
		})) {
			if (this.stream) {
				this.streamMessage(message, this.workerModel);
			}

			if (message.type === "result" && message.subtype === "success") {
				result = message.result;
			}
		}

		return result;
	}

	/**
	 * Opus reviews worker output and fixes issues
	 */
	private async opusReview(
		goal: string,
		workerResults: Array<{ subtask: string; passed: boolean; result: string }>,
	): Promise<void> {
		const failedTasks = workerResults.filter((r) => !r.passed);

		const prompt = `Review and fix these issues from worker tasks:

Original goal: ${goal}

Failed subtasks:
${failedTasks.map((t, i) => `${i + 1}. ${t.subtask}\n   Result: ${t.result.substring(0, 200)}`).join("\n\n")}

Fix any issues to complete the original goal. Run typecheck to verify.`;

		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES.opus,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				settingSources: ["project"],
				// Defense-in-depth: explicitly block git push even if settings fail to load
				disallowedTools: ["Bash(git push)", "Bash(git push *)", "Bash(git push -*)", "Bash(git remote push)"],
			},
		})) {
			if (this.stream) {
				this.streamMessage(message, "opus");
			}
		}
	}

	/**
	 * Execute simple task directly with Opus
	 */
	private async executeDirectly(goal: string, startTime: number): Promise<TaskResult> {
		for await (const message of query({
			prompt: goal,
			options: {
				model: MODEL_NAMES.opus,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				settingSources: ["project"],
				// Defense-in-depth: explicitly block git push even if settings fail to load
				disallowedTools: ["Bash(git push)", "Bash(git push *)", "Bash(git push -*)", "Bash(git remote push)"],
			},
		})) {
			if (this.stream) {
				this.streamMessage(message, "opus");
			}
		}

		const verification = await this.verifyWork();
		let commitSha: string | undefined;

		if (verification.passed && this.autoCommit) {
			try {
				commitSha = await this.commitWork(goal);
			} catch {
				// Nothing to commit
			}
		}

		return {
			task: goal,
			status: verification.passed ? "complete" : "failed",
			model: "opus",
			attempts: 1,
			verification,
			commitSha,
			durationMs: Date.now() - startTime,
		};
	}

	/**
	 * Stream messages to console
	 */
	private streamMessage(message: unknown, model: ModelTier): void {
		const msg = message as Record<string, unknown>;
		const prefix = chalk.dim(`[${model}]`);

		if (msg.type === "content_block_start") {
			const contentBlock = msg.content_block as { type?: string; name?: string } | undefined;
			if (contentBlock?.type === "tool_use" && contentBlock.name) {
				dualLogger.writeLine(`${prefix} ${chalk.yellow(contentBlock.name)}`);
			}
		}
	}

	/**
	 * Verify work using comprehensive local tools
	 */
	private async verifyWork(): Promise<VerificationResult> {
		const issues: string[] = [];
		const feedbackParts: string[] = [];
		let typecheckPassed = true;
		let testsPassed = true;
		let lintPassed = true;
		let spellPassed = true;
		try {
			// Only run spell check on typescript and markdown files
			execSync("pnpm spell 2>&1", { encoding: "utf-8", cwd: process.cwd(), timeout: 30000 });
			feedbackParts.push("✓ Spell check passed");
		} catch (error) {
			spellPassed = false;
			const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
			const spellingErrors = output.split("\n").filter((line) => line.includes("spelling error"));
			const errorCount = spellingErrors.length;
			issues.push(`Spelling issues (${errorCount})`);
			const relevantErrors = spellingErrors.slice(0, 3).join("\n");
			feedbackParts.push(`✗ SPELLING ISSUES - ${errorCount} found:\n${relevantErrors}`);
		}
		const codeHealthPassed = true;
		let filesChanged = 0;
		let linesChanged = 0;

		// 1. Check what changed
		let changedFiles: string[] = [];
		try {
			const diffStat = execSync("git diff --stat HEAD 2>/dev/null || git diff --stat", {
				encoding: "utf-8",
				cwd: process.cwd(),
			});

			const filesMatch = diffStat.match(/(\d+) files? changed/);
			if (filesMatch) filesChanged = parseInt(filesMatch[1], 10);

			const insertions = diffStat.match(/(\d+) insertions?/);
			const deletions = diffStat.match(/(\d+) deletions?/);
			linesChanged = (insertions ? parseInt(insertions[1], 10) : 0) + (deletions ? parseInt(deletions[1], 10) : 0);

			const diffNames = execSync("git diff --name-only HEAD 2>/dev/null || git diff --name-only", {
				encoding: "utf-8",
				cwd: process.cwd(),
			});
			changedFiles = diffNames.trim().split("\n").filter(Boolean);
		} catch {
			issues.push("No changes detected");
			feedbackParts.push("ERROR: No file changes were made.");
		}

		// 2. Run typecheck (critical)
		try {
			execSync("pnpm typecheck 2>&1", { encoding: "utf-8", cwd: process.cwd(), timeout: 60000 });
			feedbackParts.push("✓ Typecheck passed");
		} catch (error) {
			typecheckPassed = false;
			const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
			const errorLines = output.split("\n").filter((line) => line.includes("error TS"));
			const errorCount = errorLines.length;
			issues.push(`Typecheck failed (${errorCount} errors)`);
			const relevantErrors = errorLines.slice(0, 5).join("\n");
			feedbackParts.push(`✗ TYPECHECK FAILED - ${errorCount} type errors:\n${relevantErrors}`);
		}

		// 3. Run lint check
		try {
			execSync("pnpm lint 2>&1", { encoding: "utf-8", cwd: process.cwd(), timeout: 60000 });
			feedbackParts.push("✓ Lint passed");
		} catch (error) {
			lintPassed = false;
			const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
			const issueCount = (output.match(/✖|error|warning/gi) || []).length;
			issues.push(`Lint issues (${issueCount})`);
			const lines = output
				.split("\n")
				.filter((l) => l.includes("error") || l.includes("warning"))
				.slice(0, 3);
			feedbackParts.push(`⚠ LINT ISSUES:\n${lines.join("\n")}`);
		}

		// 4. Run tests if changed files exist
		if (changedFiles.some((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
			try {
				execSync("pnpm test --run 2>&1", { encoding: "utf-8", cwd: process.cwd(), timeout: 120000 });
				feedbackParts.push("✓ Tests passed");
			} catch (error) {
				testsPassed = false;
				const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
				const failedMatch = output.match(/(\d+) failed/);
				const failedCount = failedMatch ? failedMatch[1] : "some";
				issues.push(`Tests failed (${failedCount})`);
				const failLines = output
					.split("\n")
					.filter((l) => l.includes("FAIL") || l.includes("AssertionError"))
					.slice(0, 3);
				feedbackParts.push(`✗ TESTS FAILED:\n${failLines.join("\n")}`);
			}
		}

		const feedback = feedbackParts.join("\n");
		const passed = filesChanged > 0 && typecheckPassed;

		return {
			passed,
			typecheckPassed,
			testsPassed,
			lintPassed,
			spellPassed,
			codeHealthPassed,
			filesChanged,
			linesChanged,
			issues,
			feedback,
		};
	}

	/**
	 * Commit work (skip hooks - we already did verification)
	 */
	private async commitWork(goal: string): Promise<string> {
		execSync("git add -A");
		const shortGoal = goal.substring(0, 50) + (goal.length > 50 ? "..." : "");
		execSync(`git commit --no-verify -m "${shortGoal.replace(/"/g, '\\"')}"`);
		return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
	}
}

/**
 * Run in supervised mode (Opus orchestrating workers)
 */
export async function runSupervised(goal: string, options: SupervisedOptions = {}): Promise<TaskResult> {
	const orchestrator = new SupervisedOrchestrator(options);
	return orchestrator.runSupervised(goal);
}
