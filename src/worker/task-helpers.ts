/**
 * Worker Task Helpers
 *
 * Extracted helper functions for task execution to reduce worker.ts complexity.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logFastPathComplete, logFastPathFailed } from "../grind-events.js";
import { sessionLogger } from "../logger.js";
import * as output from "../output.js";
import { verifyWork } from "../verification.js";

/**
 * Few-shot example patterns for common task types
 */
interface FewShotPattern {
	keywords: string[];
	example: string;
}

const FEW_SHOT_PATTERNS: FewShotPattern[] = [
	{
		keywords: ["typo", "comment", "spelling"],
		example: `Task: "Fix typo in src/utils.ts"
Action: Read the file, find the typo, use Edit tool to fix it
Result: Changed "recieve" to "receive" on line 45`,
	},
	{
		keywords: ["add", "create"],
		example: `Task: "Add validateEmail function to src/utils.ts"
Action: Read file to understand patterns, then Edit to add new function
Result: Added function following existing code style, exported it`,
	},
	{
		keywords: ["fix"],
		example: `Task: "Fix null error in src/auth.ts:45"
Action: Read file, understand the code path, add null check
Result: Added optional chaining (?.) to prevent null access`,
	},
	{
		keywords: ["update", "change", "modify"],
		example: `Task: "Update timeout value in config.ts to 30000"
Action: Read file, find the timeout setting, Edit to change value
Result: Changed timeout from 10000 to 30000`,
	},
	{
		keywords: ["rename"],
		example: `Task: "Rename getUserData to fetchUserProfile in src/api.ts"
Action: Read file, use Edit with replace_all to rename all occurrences
Result: Renamed function and all call sites`,
	},
	{
		keywords: ["test"],
		example: `Task: "Add tests for validateEmail in src/__tests__/utils.test.ts"
Action: Read the function to understand behavior, then write test cases
Result: Added 3 test cases: valid email, invalid email, empty string`,
	},
];

/**
 * Get a few-shot example for common task patterns using data-driven lookup
 */
export function getFewShotExample(task: string): string | undefined {
	const taskLower = task.toLowerCase();

	// Special handling for add/create + function combo
	if ((taskLower.includes("add") || taskLower.includes("create")) && taskLower.includes("function")) {
		return FEW_SHOT_PATTERNS.find((p) => p.keywords.includes("add"))?.example;
	}

	// Special handling for fix + bug/error combo
	if (taskLower.includes("fix") && (taskLower.includes("bug") || taskLower.includes("error"))) {
		return FEW_SHOT_PATTERNS.find((p) => p.keywords.includes("fix"))?.example;
	}

	// Special handling for test + add/write combo
	if (taskLower.includes("test") && (taskLower.includes("add") || taskLower.includes("write"))) {
		return FEW_SHOT_PATTERNS.find((p) => p.keywords.includes("test"))?.example;
	}

	// General keyword matching
	for (const pattern of FEW_SHOT_PATTERNS) {
		if (pattern.keywords.some((kw) => taskLower.includes(kw))) {
			return pattern.example;
		}
	}

	return undefined;
}

/**
 * Configuration for fast-path execution
 */
export interface FastPathConfig {
	taskId: string;
	sessionId: string;
	task: string;
	baseCommit: string | undefined;
	workingDirectory: string;
	autoCommit: boolean;
	runTypecheck: boolean;
	runTests: boolean;
	skipOptionalVerification: boolean;
}

/**
 * Result from fast-path attempt
 */
export interface FastPathAttemptResult {
	handled: boolean;
	success?: boolean;
	filesChanged?: string[];
	error?: string;
}

/**
 * Result from fast-path verification
 */
export interface FastPathVerificationResult {
	success: boolean;
	durationMs?: number;
}

/**
 * Handle successful fast-path with verification
 * Returns verification result - caller constructs TaskResult if needed
 */
export async function handleFastPathSuccess(
	fastResult: FastPathAttemptResult,
	config: FastPathConfig,
	startTime: number,
): Promise<FastPathVerificationResult> {
	const {
		taskId,
		sessionId,
		task,
		baseCommit,
		workingDirectory,
		autoCommit,
		runTypecheck,
		runTests,
		skipOptionalVerification,
	} = config;

	output.success(`Fast-path completed: ${fastResult.filesChanged?.join(", ")}`, { taskId });

	const verification = await verifyWork({
		runTypecheck,
		runTests,
		workingDirectory,
		baseCommit,
		skipOptionalChecks: skipOptionalVerification,
	});

	if (verification.passed) {
		if (autoCommit && fastResult.filesChanged?.length) {
			commitFastPathChanges(fastResult.filesChanged, task, workingDirectory, taskId);
		}

		const durationMs = Date.now() - startTime;
		output.info(`Fast-path completed in ${durationMs}ms (vs ~60s with LLM)`, { taskId, durationMs });
		logFastPathComplete({
			batchId: sessionId,
			taskId,
			objective: task,
			durationMs,
			modifiedFiles: fastResult.filesChanged,
			tool: "ast-grep",
		});

		return { success: true, durationMs };
	}

	// Verification failed - revert and fall back to LLM
	output.warning("Fast-path changes failed verification, falling back to LLM", { taskId });
	logFastPathFailed({
		batchId: sessionId,
		taskId,
		objective: task,
		error: "Verification failed after fast-path changes",
		tool: "ast-grep",
	});
	execSync("git checkout -- .", { cwd: workingDirectory, stdio: "pipe" });

	return { success: false };
}

/**
 * Commit fast-path changes
 */
function commitFastPathChanges(files: string[], task: string, workingDirectory: string, taskId: string): void {
	try {
		for (const file of files) {
			execFileSync("git", ["add", file], { cwd: workingDirectory, stdio: "pipe" });
		}
		execFileSync("git", ["commit", "-m", task.substring(0, 50)], {
			cwd: workingDirectory,
			stdio: "pipe",
		});
		output.success("Fast-path changes committed", { taskId });
	} catch (e) {
		output.warning("Fast-path commit failed, changes staged", { taskId, error: String(e) });
	}
}

/**
 * Handle fast-path failure
 */
export function handleFastPathFailure(fastResult: FastPathAttemptResult, config: FastPathConfig): void {
	const { taskId, sessionId, task } = config;
	output.debug(`Fast-path attempted but failed: ${fastResult.error}`, { taskId });
	logFastPathFailed({
		batchId: sessionId,
		taskId,
		objective: task,
		error: fastResult.error || "Unknown error",
		tool: "ast-grep",
	});
}

/**
 * Configuration for PM research task
 */
interface PMResearchConfig {
	taskId: string;
	task: string;
	workingDirectory: string;
	autoCommit: boolean;
}

/**
 * Write PM research output to file
 */
export function writePMResearchOutput(topic: string, designDoc: string, config: PMResearchConfig): string {
	const { taskId, workingDirectory } = config;

	// Generate filename from topic
	const slug = topic
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	const timestamp = new Date().toISOString().split("T")[0];
	const outputPath = join(workingDirectory, ".undercity", "research", `${timestamp}-${slug}.md`);

	// Ensure research directory exists
	const researchDir = join(workingDirectory, ".undercity", "research");
	if (!existsSync(researchDir)) {
		mkdirSync(researchDir, { recursive: true });
	}

	writeFileSync(outputPath, designDoc);
	sessionLogger.info({ taskId, outputPath }, "PM research design doc written");

	return outputPath;
}

/**
 * Commit research output and return commit SHA
 */
export function commitResearchOutput(outputPath: string, topic: string, workingDirectory: string): string | undefined {
	try {
		execFileSync("git", ["add", outputPath], { cwd: workingDirectory });
		const commitMsg = `[research] ${topic.slice(0, 50)}`;
		execFileSync("git", ["commit", "-m", commitMsg], { cwd: workingDirectory });
		return execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: workingDirectory,
			encoding: "utf-8",
		}).trim();
	} catch {
		// Commit may fail if no changes - that's ok
		return undefined;
	}
}
