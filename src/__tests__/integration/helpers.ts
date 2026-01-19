/**
 * Integration Test Helpers
 *
 * Utility functions for integration tests including CLI execution,
 * git operations, and common test patterns.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Path to the CLI entry point
 */
export const CLI_PATH = join(process.cwd(), "bin/undercity.js");

/**
 * Options for CLI execution
 */
export interface CliExecutionOptions {
	/** Working directory (default: process.cwd()) */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Expect command to fail (default: false) */
	shouldFail?: boolean;
	/** Timeout in milliseconds (default: 30000) */
	timeout?: number;
}

/**
 * Result of CLI execution
 */
export interface CliExecutionResult {
	/** Standard output */
	stdout: string;
	/** Standard error */
	stderr: string;
	/** Exit code */
	exitCode: number;
	/** Whether command succeeded (exitCode === 0) */
	success: boolean;
}

/**
 * Execute Undercity CLI command safely without shell interpolation.
 * Uses execFileSync to prevent command injection.
 *
 * @example
 * const result = executeCli(["add", "Test task"], { cwd: testDir });
 * expect(result.success).toBe(true);
 * expect(result.stdout).toContain("Added task");
 */
export function executeCli(args: string[], options: CliExecutionOptions = {}): CliExecutionResult {
	const { cwd = process.cwd(), env = {}, shouldFail = false, timeout = 30000 } = options;

	try {
		const stdout = execFileSync("node", [CLI_PATH, ...args], {
			cwd,
			env: { ...process.env, ...env },
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout,
		});

		return {
			stdout,
			stderr: "",
			exitCode: 0,
			success: true,
		};
	} catch (error: unknown) {
		const execError = error as {
			stdout?: Buffer | string;
			stderr?: Buffer | string;
			status?: number;
		};

		const stdout = execError.stdout?.toString() ?? "";
		const stderr = execError.stderr?.toString() ?? "";
		const exitCode = execError.status ?? 1;

		if (!shouldFail) {
			// Re-throw if we expected success
			throw new Error(
				`CLI command failed unexpectedly:\nArgs: ${args.join(" ")}\nExit code: ${exitCode}\nStdout: ${stdout}\nStderr: ${stderr}`,
			);
		}

		return {
			stdout,
			stderr,
			exitCode,
			success: false,
		};
	}
}

/**
 * Execute git command in a directory.
 * Throws on failure by default.
 *
 * @example
 * const branch = executeGit(["rev-parse", "--abbrev-ref", "HEAD"], testDir);
 * expect(branch.trim()).toBe("main");
 */
export function executeGit(args: string[], cwd: string, options: { silent?: boolean } = {}): string {
	const { silent = true } = options;

	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: silent ? "pipe" : "inherit",
	});
}

/**
 * Create a git commit in a repository.
 * Stages all changes and commits with the given message.
 *
 * @example
 * writeFileSync(join(repoPath, "file.txt"), "content");
 * createGitCommit(repoPath, "Add file");
 */
export function createGitCommit(repoPath: string, message: string): void {
	executeGit(["add", "."], repoPath);
	executeGit(["commit", "-m", message], repoPath);
}

/**
 * Create a git branch and optionally check it out.
 *
 * @example
 * createGitBranch(repoPath, "feature-branch", true);
 * const branch = getCurrentGitBranch(repoPath);
 * expect(branch).toBe("feature-branch");
 */
export function createGitBranch(repoPath: string, branchName: string, checkout = false): void {
	executeGit(["branch", branchName], repoPath);
	if (checkout) {
		executeGit(["checkout", branchName], repoPath);
	}
}

/**
 * Get current git branch name.
 *
 * @example
 * const branch = getCurrentGitBranch(repoPath);
 * expect(branch).toBe("main");
 */
export function getCurrentGitBranch(repoPath: string): string {
	return executeGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath).trim();
}

/**
 * Get list of branches in a git repository.
 *
 * @example
 * const branches = getGitBranches(repoPath);
 * expect(branches).toContain("main");
 */
export function getGitBranches(repoPath: string): string[] {
	const output = executeGit(["branch", "--list"], repoPath);
	return output
		.split("\n")
		.map((line) => line.trim().replace(/^\*\s+/, ""))
		.filter(Boolean);
}

/**
 * Check if a file exists in a git repository.
 */
export function fileExistsInRepo(repoPath: string, filePath: string): boolean {
	return existsSync(join(repoPath, filePath));
}

/**
 * Read file content from a git repository.
 */
export function readFileFromRepo(repoPath: string, filePath: string): string {
	return readFileSync(join(repoPath, filePath), "utf-8");
}

/**
 * Write file to a git repository.
 */
export function writeFileToRepo(repoPath: string, filePath: string, content: string): void {
	writeFileSync(join(repoPath, filePath), content);
}

/**
 * Read tasks from tasks.json in an Undercity project.
 *
 * @example
 * const tasks = readTaskBoard(projectPath);
 * expect(tasks).toHaveLength(1);
 * expect(tasks[0].objective).toBe("Test task");
 */
export function readTaskBoard(projectPath: string): Array<{
	id: string;
	objective: string;
	status: string;
	priority: number;
}> {
	const tasksFile = join(projectPath, ".undercity", "tasks.json");
	const content = readFileSync(tasksFile, "utf-8");
	const data = JSON.parse(content);
	return data.tasks ?? [];
}

/**
 * Write tasks to tasks.json in an Undercity project.
 */
export function writeTaskBoard(
	projectPath: string,
	tasks: Array<{
		id: string;
		objective: string;
		status: string;
		priority: number;
	}>,
): void {
	const tasksFile = join(projectPath, ".undercity", "tasks.json");
	writeFileSync(tasksFile, JSON.stringify({ tasks }, null, 2));
}

/**
 * Add a task to an Undercity project via CLI.
 *
 * @example
 * const taskId = addTaskViaCli(projectPath, "Test task");
 * const tasks = readTaskBoard(projectPath);
 * expect(tasks.find(t => t.id === taskId)).toBeDefined();
 */
export function addTaskViaCli(projectPath: string, objective: string, options: { priority?: number } = {}): string {
	const args = ["add", objective];
	if (options.priority !== undefined) {
		args.push("--priority", String(options.priority));
	}

	executeCli(args, { cwd: projectPath });

	// Read board to get the task ID
	const tasks = readTaskBoard(projectPath);
	const task = tasks.find((t) => t.objective === objective);

	if (!task) {
		throw new Error(`Task not found after adding: ${objective}`);
	}

	return task.id;
}

/**
 * Wait for a condition to be true with timeout.
 * Useful for async operations in integration tests.
 *
 * @example
 * await waitFor(() => fileExistsInRepo(repoPath, "output.txt"), {
 *   timeout: 5000,
 *   interval: 100,
 * });
 */
export async function waitFor(
	condition: () => boolean | Promise<boolean>,
	options: { timeout?: number; interval?: number } = {},
): Promise<void> {
	const { timeout = 5000, interval = 100 } = options;
	const startTime = Date.now();

	while (Date.now() - startTime < timeout) {
		if (await condition()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, interval));
	}

	throw new Error(`Condition not met within ${timeout}ms`);
}

/**
 * Sleep for specified milliseconds.
 * Useful for rate limiting or waiting between operations.
 *
 * @example
 * await sleep(1000); // Wait 1 second
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if running in coverage mode.
 * Integration tests may skip certain operations in coverage mode.
 */
export function isCoverageMode(): boolean {
	return process.env.npm_lifecycle_event?.includes("coverage") ?? false;
}

/**
 * Check if running in verification mode.
 * Used by pre-commit hooks to skip expensive tests.
 */
export function isVerificationMode(): boolean {
	return process.env.UNDERCITY_VERIFICATION === "true";
}

/**
 * Get git commit SHA for a branch.
 */
export function getCommitSha(repoPath: string, ref = "HEAD"): string {
	return executeGit(["rev-parse", ref], repoPath).trim();
}

/**
 * Get git log entries.
 */
export function getGitLog(repoPath: string, options: { limit?: number; format?: string } = {}): string[] {
	const { limit = 10, format = "%H %s" } = options;
	const args = ["log", `--format=${format}`, `-${limit}`];
	const output = executeGit(args, repoPath);
	return output.split("\n").filter(Boolean);
}

/**
 * Check if git working directory is clean (no uncommitted changes).
 */
export function isGitWorkingDirClean(repoPath: string): boolean {
	try {
		const output = executeGit(["status", "--porcelain"], repoPath);
		return output.trim().length === 0;
	} catch {
		return false;
	}
}

/**
 * Create a test setup with beforeAll/afterAll cleanup pattern.
 * Returns a context object that gets populated during setup.
 *
 * @example
 * const ctx = createTestContext<{ repo: GitRepoFixture }>();
 *
 * beforeAll(() => {
 *   ctx.value.repo = createTempGitRepo();
 * });
 *
 * afterAll(() => {
 *   ctx.value.repo?.cleanup();
 * });
 *
 * it("test", () => {
 *   expect(ctx.value.repo).toBeDefined();
 * });
 */
export function createTestContext<T extends Record<string, unknown>>(): {
	value: T;
} {
	return { value: {} as T };
}
