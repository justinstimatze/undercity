/**
 * WorktreeManager Integration Tests
 *
 * Tests real git worktree operations in isolated temp directories.
 * Verifies worktree creation, cleanup, and branch management.
 *
 * Note: These tests are skipped in coverage mode to prevent interference
 * with other tests due to git operations affecting process state.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WorktreeError, WorktreeManager } from "../../worktree-manager.js";

// Skip git operation tests in coverage mode or during verification
const isCoverage = process.env.npm_lifecycle_event?.includes("coverage");
const isVerification = process.env.UNDERCITY_VERIFICATION === "true";
const describeGit = isCoverage || isVerification ? describe.skip : describe.sequential;

// Use describe.sequential to prevent parallel execution issues with git operations
describeGit("WorktreeManager Integration Tests", () => {
	let testDir: string;
	let manager: WorktreeManager;
	let defaultBranch: string;

	beforeAll(() => {
		// Create a real git repo in temp directory
		testDir = mkdtempSync(join(tmpdir(), "worktree-test-"));

		// Initialize git repo with explicit branch name
		execSync("git init -b main", { cwd: testDir, stdio: "pipe" });
		execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: "pipe" });
		execSync('git config user.name "Test"', { cwd: testDir, stdio: "pipe" });

		// Create initial commit (required for worktrees)
		writeFileSync(join(testDir, "README.md"), "# Test Repo");
		execSync("git add README.md", { cwd: testDir, stdio: "pipe" });
		execSync('git commit -m "Initial commit"', { cwd: testDir, stdio: "pipe" });

		// Get actual branch name (git init may create main or master)
		defaultBranch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: testDir,
			encoding: "utf-8",
		}).trim();

		// Create .undercity directory
		mkdirSync(join(testDir, ".undercity"), { recursive: true });
	});

	afterAll(() => {
		// Cleanup test directory
		if (existsSync(testDir)) {
			// First prune worktrees to avoid git complaints
			try {
				execSync("git worktree prune", { cwd: testDir, stdio: "pipe" });
			} catch {
				// Ignore
			}
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	afterEach(() => {
		// Clean up any worktrees created by tests
		if (manager) {
			const worktrees = manager.getActiveSessionWorktrees();
			for (const worktree of worktrees) {
				try {
					manager.removeWorktree(worktree.sessionId, true);
				} catch {
					// Ignore cleanup errors
				}
			}
		}
	});

	describe("Constructor and Initialization", () => {
		it("should initialize with repo root", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			expect(manager.getMainRepoPath()).toBe(testDir);
		});

		it("should detect main branch", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			expect(manager.getMainBranch()).toBe(defaultBranch);
		});

		it("should allow override of default branch", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch: "develop" });
			expect(manager.getMainBranch()).toBe("develop");
		});

		it("should create worktrees directory if not exists", () => {
			const newTestDir = mkdtempSync(join(tmpdir(), "worktree-init-"));
			execSync("git init -b main", { cwd: newTestDir, stdio: "pipe" });
			execSync('git config user.email "test@test.com"', { cwd: newTestDir, stdio: "pipe" });
			execSync('git config user.name "Test"', { cwd: newTestDir, stdio: "pipe" });
			writeFileSync(join(newTestDir, "README.md"), "# Test");
			execSync("git add . && git commit -m 'init'", { cwd: newTestDir, stdio: "pipe" });

			new WorktreeManager({ repoRoot: newTestDir, defaultBranch: "main" });
			const worktreesPath = join(newTestDir, ".undercity", "worktrees");

			expect(existsSync(worktreesPath)).toBe(true);

			// Cleanup
			rmSync(newTestDir, { recursive: true, force: true });
		});
	});

	describe("isGitRepo", () => {
		it("should return true for git repository", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			expect(manager.isGitRepo()).toBe(true);
		});

		it("should check for .git directory in repo root", () => {
			// This test verifies one of the fallback checks - .git directory existence
			const gitDir = join(testDir, ".git");
			expect(existsSync(gitDir)).toBe(true);
		});
	});

	describe("Worktree Path and Branch Generation", () => {
		it("should generate correct worktree path", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			const sessionId = "test-session-123";
			const expected = join(testDir, ".undercity", "worktrees", sessionId);
			expect(manager.getWorktreePath(sessionId)).toBe(expected);
		});

		it("should generate correct branch name", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			const sessionId = "test-session-123";
			expect(manager.getWorktreeBranchName(sessionId)).toBe("undercity/test-session-123/worktree");
		});
	});

	describe("createWorktree", () => {
		it("should create a new worktree", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			const sessionId = `session-${Date.now()}`;

			const info = manager.createWorktree(sessionId);

			expect(info.sessionId).toBe(sessionId);
			expect(info.path).toBe(manager.getWorktreePath(sessionId));
			expect(info.branch).toBe(manager.getWorktreeBranchName(sessionId));
			expect(info.isActive).toBe(true);
			expect(info.createdAt).toBeInstanceOf(Date);

			// Verify worktree exists on disk
			expect(existsSync(info.path)).toBe(true);

			// Verify branch is active in the worktree
			const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
				cwd: info.path,
				encoding: "utf-8",
			}).trim();
			expect(currentBranch).toBe(info.branch);
		});

		it("should throw error if worktree already exists", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			const sessionId = `session-dup-${Date.now()}`;

			// Create first worktree
			manager.createWorktree(sessionId);

			// Try to create again
			expect(() => manager.createWorktree(sessionId)).toThrow(WorktreeError);
		});

		it("should create worktree with files from main branch", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			const sessionId = `session-files-${Date.now()}`;

			const info = manager.createWorktree(sessionId);

			// Verify README.md exists in worktree
			expect(existsSync(join(info.path, "README.md"))).toBe(true);
		});
	});

	describe("removeWorktree", () => {
		it("should remove an existing worktree", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			const sessionId = `session-remove-${Date.now()}`;

			// Create worktree
			const info = manager.createWorktree(sessionId);
			expect(existsSync(info.path)).toBe(true);

			// Remove worktree
			manager.removeWorktree(sessionId);

			// Verify removed
			expect(existsSync(info.path)).toBe(false);
		});

		it("should delete the branch when removing worktree", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			const sessionId = `session-branch-${Date.now()}`;

			// Create worktree
			const info = manager.createWorktree(sessionId);
			const branchName = info.branch;

			// Remove worktree
			manager.removeWorktree(sessionId);

			// Verify branch deleted
			const branches = execSync("git branch --list", { cwd: testDir, encoding: "utf-8" });
			expect(branches).not.toContain(branchName);
		});

		it("should handle force removal", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			const sessionId = `session-force-${Date.now()}`;

			// Create worktree
			const info = manager.createWorktree(sessionId);

			// Make changes in worktree (uncommitted)
			writeFileSync(join(info.path, "uncommitted.txt"), "test");

			// Force remove should work
			expect(() => manager.removeWorktree(sessionId, true)).not.toThrow();
			expect(existsSync(info.path)).toBe(false);
		});
	});

	describe("listWorktrees", () => {
		it("should list all worktrees including main", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });

			const worktrees = manager.listWorktrees();

			// Should at least have the main worktree
			expect(worktrees.length).toBeGreaterThanOrEqual(1);
			// Check if main worktree is present (path may vary depending on git version)
			const mainWorktree = worktrees.find((w) => w.branch === defaultBranch || w.path.includes(testDir));
			expect(mainWorktree).toBeDefined();
		});

		it("should include created worktrees", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			const sessionId = `session-list-${Date.now()}`;

			manager.createWorktree(sessionId);

			const worktrees = manager.listWorktrees();
			const sessionWorktree = worktrees.find((w) => w.path.includes(sessionId));

			expect(sessionWorktree).toBeDefined();
			expect(sessionWorktree?.branch).toBe(manager.getWorktreeBranchName(sessionId));
		});
	});

	describe("getActiveSessionWorktrees", () => {
		it("should return only managed session worktrees", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			const sessionId = `session-active-${Date.now()}`;

			// Create a session worktree
			manager.createWorktree(sessionId);

			const sessionWorktrees = manager.getActiveSessionWorktrees();

			// Should find our session
			const found = sessionWorktrees.find((w) => w.sessionId === sessionId);
			expect(found).toBeDefined();
			expect(found?.isActive).toBe(true);

			// Should not include main worktree
			expect(sessionWorktrees.find((w) => w.path === testDir)).toBeUndefined();
		});

		it("should return empty array when no session worktrees exist", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });

			// Clean up any existing worktrees first
			const existing = manager.getActiveSessionWorktrees();
			for (const wt of existing) {
				manager.removeWorktree(wt.sessionId, true);
			}

			const sessionWorktrees = manager.getActiveSessionWorktrees();
			expect(sessionWorktrees).toEqual([]);
		});
	});

	describe("hasWorktree", () => {
		it("should return true for existing worktree", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			const sessionId = `session-has-${Date.now()}`;

			manager.createWorktree(sessionId);

			expect(manager.hasWorktree(sessionId)).toBe(true);
		});

		it("should return false for non-existing worktree", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			expect(manager.hasWorktree("non-existent-session")).toBe(false);
		});
	});

	describe("getWorktreeInfo", () => {
		it("should return info for existing worktree", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			const sessionId = `session-info-${Date.now()}`;

			manager.createWorktree(sessionId);

			const info = manager.getWorktreeInfo(sessionId);
			expect(info).not.toBeNull();
			expect(info?.sessionId).toBe(sessionId);
			expect(info?.path).toBe(manager.getWorktreePath(sessionId));
			expect(info?.branch).toBe(manager.getWorktreeBranchName(sessionId));
		});

		it("should return null for non-existing worktree", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			expect(manager.getWorktreeInfo("non-existent")).toBeNull();
		});
	});

	describe("cleanupOrphanedWorktrees", () => {
		it("should remove worktrees not in active session list", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });

			// Create two worktrees
			const activeSessionId = `session-active-${Date.now()}`;
			const orphanSessionId = `session-orphan-${Date.now()}`;

			manager.createWorktree(activeSessionId);
			manager.createWorktree(orphanSessionId);

			// Cleanup with only active session
			manager.cleanupOrphanedWorktrees([activeSessionId]);

			// Orphan should be removed
			expect(manager.hasWorktree(orphanSessionId)).toBe(false);

			// Active should remain
			expect(manager.hasWorktree(activeSessionId)).toBe(true);
		});
	});

	describe("emergencyCleanup", () => {
		it("should remove all session worktrees", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });

			// Create multiple worktrees
			const sessions = [`session-em1-${Date.now()}`, `session-em2-${Date.now()}`];

			for (const sessionId of sessions) {
				manager.createWorktree(sessionId);
			}

			// Verify they exist
			expect(manager.getActiveSessionWorktrees().length).toBe(2);

			// Emergency cleanup
			manager.emergencyCleanup();

			// All should be removed
			expect(manager.getActiveSessionWorktrees().length).toBe(0);

			for (const sessionId of sessions) {
				expect(manager.hasWorktree(sessionId)).toBe(false);
			}
		});
	});

	describe("Worktree Isolation", () => {
		it("should have isolated working directory", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			const sessionId = `session-iso-${Date.now()}`;

			const info = manager.createWorktree(sessionId);

			// Create a file in worktree
			const testFile = join(info.path, "worktree-only.txt");
			writeFileSync(testFile, "worktree content");

			// File should exist in worktree
			expect(existsSync(testFile)).toBe(true);

			// File should NOT exist in main repo
			expect(existsSync(join(testDir, "worktree-only.txt"))).toBe(false);
		});

		it("should be on separate branch", () => {
			manager = new WorktreeManager({ repoRoot: testDir, defaultBranch });
			const sessionId = `session-branch-${Date.now()}`;

			const info = manager.createWorktree(sessionId);

			// Get current branch in worktree
			const worktreeBranch = execSync("git rev-parse --abbrev-ref HEAD", {
				cwd: info.path,
				encoding: "utf-8",
			}).trim();

			// Get current branch in main repo
			const mainBranch = execSync("git rev-parse --abbrev-ref HEAD", {
				cwd: testDir,
				encoding: "utf-8",
			}).trim();

			expect(worktreeBranch).toBe(info.branch);
			expect(worktreeBranch).not.toBe(mainBranch);
		});
	});
});
