/**
 * Integration Test Fixtures
 *
 * Factory functions for creating test environments with proper cleanup.
 * These fixtures handle real file system operations, git repositories,
 * and Undercity project structures in isolated temp directories.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Represents a temporary git repository for testing
 */
export interface GitRepoFixture {
	/** Absolute path to the repo root */
	path: string;
	/** Default branch name (main or master) */
	defaultBranch: string;
	/** Cleanup function to remove the repo */
	cleanup: () => void;
}

/**
 * Represents a complete Undercity project structure for testing
 */
export interface UndercityProjectFixture {
	/** Absolute path to the project root */
	path: string;
	/** Default git branch name */
	defaultBranch: string;
	/** Path to .undercity directory */
	undercityDir: string;
	/** Path to tasks.json */
	tasksFile: string;
	/** Cleanup function to remove the project */
	cleanup: () => void;
}

/**
 * Options for creating a git repository
 */
export interface GitRepoOptions {
	/** Branch name (default: "main") */
	branch?: string;
	/** Initial commit message (default: "Initial commit") */
	initialCommit?: string;
	/** Prefix for temp directory name (default: "test-repo-") */
	prefix?: string;
}

/**
 * Options for creating an Undercity project
 */
export interface UndercityProjectOptions extends GitRepoOptions {
	/** Initial tasks to add to board (default: []) */
	initialTasks?: Array<{
		objective: string;
		priority?: number;
		status?: string;
	}>;
	/** Create additional state files (default: false) */
	includeStateFiles?: boolean;
}

/**
 * Create a temporary git repository with initial commit.
 * Automatically cleaned up by calling cleanup() function.
 *
 * @example
 * const repo = createTempGitRepo();
 * // Use repo.path for git operations
 * repo.cleanup(); // Remove when done
 */
export function createTempGitRepo(options: GitRepoOptions = {}): GitRepoFixture {
	const { branch = "main", initialCommit = "Initial commit", prefix = "test-repo-" } = options;

	// Create temp directory
	const repoPath = mkdtempSync(join(tmpdir(), prefix));

	try {
		// Initialize git repo with explicit branch
		execSync(`git init -b ${branch}`, {
			cwd: repoPath,
			stdio: "pipe",
		});

		// Configure git user (required for commits)
		execSync('git config user.email "test@test.com"', {
			cwd: repoPath,
			stdio: "pipe",
		});
		execSync('git config user.name "Test User"', {
			cwd: repoPath,
			stdio: "pipe",
		});

		// Create initial commit (required for worktrees)
		writeFileSync(join(repoPath, "README.md"), "# Test Repository");
		execSync("git add README.md", { cwd: repoPath, stdio: "pipe" });
		execSync(`git commit -m "${initialCommit}"`, {
			cwd: repoPath,
			stdio: "pipe",
		});

		// Get actual branch name (may differ on older git versions)
		const actualBranch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: repoPath,
			encoding: "utf-8",
		}).trim();

		return {
			path: repoPath,
			defaultBranch: actualBranch,
			cleanup: () => {
				if (existsSync(repoPath)) {
					// Prune worktrees first to avoid git complaints
					try {
						execSync("git worktree prune", {
							cwd: repoPath,
							stdio: "pipe",
						});
					} catch {
						// Ignore errors
					}
					rmSync(repoPath, { recursive: true, force: true });
				}
			},
		};
	} catch (error) {
		// Cleanup on error
		if (existsSync(repoPath)) {
			rmSync(repoPath, { recursive: true, force: true });
		}
		throw error;
	}
}

/**
 * Create a minimal Undercity project structure with git repo and task board.
 * Includes .undercity directory and empty tasks.json by default.
 *
 * @example
 * const project = createMinimalUndercityProject({
 *   initialTasks: [{ objective: "Test task" }]
 * });
 * // Use project.path for CLI operations
 * project.cleanup(); // Remove when done
 */
export function createMinimalUndercityProject(options: UndercityProjectOptions = {}): UndercityProjectFixture {
	const {
		branch = "main",
		initialCommit = "Initial commit",
		prefix = "undercity-test-",
		initialTasks = [],
		includeStateFiles = false,
	} = options;

	// Create base git repo
	const repo = createTempGitRepo({ branch, initialCommit, prefix });

	try {
		// Create .undercity directory
		const undercityDir = join(repo.path, ".undercity");
		mkdirSync(undercityDir, { recursive: true });

		// Create tasks.json with optional initial tasks
		const tasksFile = join(undercityDir, "tasks.json");
		const tasks = initialTasks.map((task, index) => ({
			id: `task-${Date.now()}-${index}`,
			objective: task.objective,
			priority: task.priority ?? 0,
			status: task.status ?? "pending",
			createdAt: new Date().toISOString(),
		}));

		writeFileSync(tasksFile, JSON.stringify({ tasks }, null, 2));

		// Create additional state files if requested
		if (includeStateFiles) {
			// Empty knowledge base
			writeFileSync(join(undercityDir, "knowledge.json"), JSON.stringify({ learnings: [], version: "1.0" }, null, 2));

			// Empty decisions
			writeFileSync(join(undercityDir, "decisions.json"), JSON.stringify({ decisions: [] }, null, 2));

			// Empty patterns
			writeFileSync(join(undercityDir, "task-file-patterns.json"), JSON.stringify({ patterns: {} }, null, 2));
		}

		return {
			path: repo.path,
			defaultBranch: repo.defaultBranch,
			undercityDir,
			tasksFile,
			cleanup: repo.cleanup,
		};
	} catch (error) {
		// Cleanup on error
		repo.cleanup();
		throw error;
	}
}

/**
 * Create a file system fixture for testing file operations.
 * Returns a temp directory with cleanup function.
 *
 * @example
 * const fs = createMockFileSystem();
 * writeFileSync(join(fs.path, "test.txt"), "content");
 * fs.cleanup(); // Remove when done
 */
export function createMockFileSystem(prefix = "fs-test-"): {
	path: string;
	cleanup: () => void;
} {
	const path = mkdtempSync(join(tmpdir(), prefix));

	return {
		path,
		cleanup: () => {
			if (existsSync(path)) {
				rmSync(path, { recursive: true, force: true });
			}
		},
	};
}

/**
 * Create a git repo with multiple commits for testing history-based features.
 *
 * @example
 * const repo = createGitRepoWithHistory({
 *   commits: [
 *     { message: "Add feature", files: { "src/feature.ts": "code" } },
 *     { message: "Fix bug", files: { "src/feature.ts": "fixed code" } }
 *   ]
 * });
 */
export function createGitRepoWithHistory(options: {
	branch?: string;
	commits: Array<{
		message: string;
		files: Record<string, string>;
	}>;
}): GitRepoFixture {
	const { branch = "main", commits } = options;

	// Create base repo
	const repo = createTempGitRepo({ branch });

	try {
		// Add commits
		for (const commit of commits) {
			// Write files
			for (const [filePath, content] of Object.entries(commit.files)) {
				const fullPath = join(repo.path, filePath);
				const dir = join(fullPath, "..");
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				writeFileSync(fullPath, content);
			}

			// Stage and commit
			execSync("git add .", { cwd: repo.path, stdio: "pipe" });
			execSync(`git commit -m "${commit.message}"`, {
				cwd: repo.path,
				stdio: "pipe",
			});
		}

		return repo;
	} catch (error) {
		repo.cleanup();
		throw error;
	}
}

/**
 * Create a fixture with Undercity worktrees directory structure.
 * Used for testing worktree isolation.
 */
export function createWorktreeTestFixture(): UndercityProjectFixture & {
	worktreesDir: string;
} {
	const project = createMinimalUndercityProject();
	const repoHash = Buffer.from(project.path).toString("base64url").slice(0, 12);
	const worktreesDir = `/tmp/undercity-worktrees/${repoHash}`;

	// Create worktrees directory
	mkdirSync(worktreesDir, { recursive: true });

	const originalCleanup = project.cleanup;
	return {
		...project,
		worktreesDir,
		cleanup: () => {
			// Clean up worktrees directory
			if (existsSync(worktreesDir)) {
				rmSync(worktreesDir, { recursive: true, force: true });
			}
			// Clean up project
			originalCleanup();
		},
	};
}
