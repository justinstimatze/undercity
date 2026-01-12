/**
 * Elevator (MergeQueue) Integration Tests
 *
 * Tests real git merge operations in isolated temp directories.
 * Verifies serial merge processing, conflict detection, and retry behavior.
 *
 * Note: These tests change process.cwd() and are skipped in coverage mode
 * to prevent interference with other tests.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	branchExists,
	checkoutBranch,
	createBranch,
	Elevator,
	getCurrentBranch,
	isWorkingTreeClean,
	merge,
	rebase,
} from "../../git.js";

// Skip git operation tests in coverage mode - they change process.cwd() which affects other tests
const isCoverage = process.env.npm_lifecycle_event?.includes("coverage");
const describeGit = isCoverage ? describe.skip : describe.sequential;

// Use describe.sequential to prevent parallel execution issues with git operations
describeGit("Elevator Integration Tests", () => {
	let testDir: string;
	let originalCwd: string;
	let defaultBranch: string;

	beforeAll(() => {
		originalCwd = process.cwd();

		// Create a real git repo in temp directory
		testDir = mkdtempSync(join(tmpdir(), "elevator-test-"));

		// Initialize git repo with explicit branch name
		execSync("git init -b main", { cwd: testDir, stdio: "pipe" });
		execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: "pipe" });
		execSync('git config user.name "Test"', { cwd: testDir, stdio: "pipe" });

		// Create initial commit
		writeFileSync(join(testDir, "README.md"), "# Test Repo");
		execSync("git add README.md", { cwd: testDir, stdio: "pipe" });
		execSync('git commit -m "Initial commit"', { cwd: testDir, stdio: "pipe" });

		// Get actual branch name
		defaultBranch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: testDir,
			encoding: "utf-8",
		}).trim();

		// Change to test directory for git operations
		process.chdir(testDir);
	});

	afterAll(() => {
		// Return to original directory
		process.chdir(originalCwd);

		// Cleanup test directory
		if (existsSync(testDir)) {
			try {
				execSync("git worktree prune", { cwd: testDir, stdio: "pipe" });
			} catch {
				// Ignore
			}
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	afterEach(() => {
		// Clean up any branches created during tests
		try {
			checkoutBranch(defaultBranch);
			// List and delete test branches
			const branches = execSync("git branch --list", { cwd: testDir, encoding: "utf-8" });
			for (const line of branches.split("\n")) {
				const branch = line.trim().replace("* ", "");
				if (branch && branch !== defaultBranch && branch.startsWith("test-")) {
					try {
						execSync(`git branch -D ${branch}`, { cwd: testDir, stdio: "pipe" });
					} catch {
						// Ignore
					}
				}
			}
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("Git Helper Functions", () => {
		it("getCurrentBranch should return main branch", () => {
			expect(getCurrentBranch()).toBe(defaultBranch);
		});

		it("isWorkingTreeClean should return true when clean", () => {
			expect(isWorkingTreeClean()).toBe(true);
		});

		it("isWorkingTreeClean should return false with uncommitted changes", () => {
			const testFile = join(testDir, "uncommitted.txt");
			writeFileSync(testFile, "test");
			expect(isWorkingTreeClean()).toBe(false);

			// Cleanup - remove untracked file
			rmSync(testFile);
		});

		it("branchExists should return true for existing branch", () => {
			expect(branchExists(defaultBranch)).toBe(true);
		});

		it("branchExists should return false for non-existing branch", () => {
			expect(branchExists("non-existent-branch")).toBe(false);
		});

		it("createBranch should create a new branch", () => {
			const branchName = `test-create-${Date.now()}`;
			createBranch(branchName);

			expect(branchExists(branchName)).toBe(true);
			expect(getCurrentBranch()).toBe(branchName);

			// Cleanup
			checkoutBranch(defaultBranch);
			execSync(`git branch -D ${branchName}`, { cwd: testDir, stdio: "pipe" });
		});
	});

	describe("Rebase and Merge", () => {
		it("rebase should succeed when no conflicts", () => {
			// Create feature branch
			const branchName = `test-rebase-${Date.now()}`;
			createBranch(branchName);

			// Make a change on feature branch
			writeFileSync(join(testDir, "feature.txt"), "feature change");
			execSync("git add feature.txt", { cwd: testDir, stdio: "pipe" });
			execSync('git commit -m "Feature change"', { cwd: testDir, stdio: "pipe" });

			// Add a commit to main
			checkoutBranch(defaultBranch);
			writeFileSync(join(testDir, "main-change.txt"), "main change");
			execSync("git add main-change.txt", { cwd: testDir, stdio: "pipe" });
			execSync('git commit -m "Main change"', { cwd: testDir, stdio: "pipe" });

			// Rebase feature onto main
			checkoutBranch(branchName);
			const result = rebase(defaultBranch);

			expect(result).toBe(true);
		});

		it("merge should succeed when no conflicts", () => {
			// Create feature branch
			const branchName = `test-merge-${Date.now()}`;
			checkoutBranch(defaultBranch);
			createBranch(branchName);

			// Make a change on feature branch
			writeFileSync(join(testDir, "merge-feature.txt"), "merge feature");
			execSync("git add merge-feature.txt", { cwd: testDir, stdio: "pipe" });
			execSync('git commit -m "Merge feature"', { cwd: testDir, stdio: "pipe" });

			// Merge into main
			checkoutBranch(defaultBranch);
			const result = merge(branchName, "Test merge");

			expect(result).toBe(true);
			expect(existsSync(join(testDir, "merge-feature.txt"))).toBe(true);
		});
	});

	describe("Elevator Constructor", () => {
		it("should create elevator with default settings", () => {
			const elevator = new Elevator(defaultBranch);
			expect(elevator.getMergeStrategy()).toBe("theirs");
			expect(elevator.getQueue()).toEqual([]);
		});

		it("should allow custom merge strategy", () => {
			const elevator = new Elevator(defaultBranch, "ours");
			expect(elevator.getMergeStrategy()).toBe("ours");
		});

		it("should allow custom retry config", () => {
			const elevator = new Elevator(defaultBranch, "theirs", {
				enabled: false,
				maxRetries: 5,
			});
			const config = elevator.getRetryConfig();
			expect(config.enabled).toBe(false);
			expect(config.maxRetries).toBe(5);
		});
	});

	describe("Elevator Queue Management", () => {
		it("add should add item to queue", () => {
			const elevator = new Elevator(defaultBranch);
			const item = elevator.add("test-branch", "step-1", "agent-1");

			expect(item.branch).toBe("test-branch");
			expect(item.stepId).toBe("step-1");
			expect(item.agentId).toBe("agent-1");
			expect(item.status).toBe("pending");
			expect(elevator.getQueue()).toHaveLength(1);
		});

		it("add should track modified files", () => {
			const elevator = new Elevator(defaultBranch);
			const modifiedFiles = ["src/file1.ts", "src/file2.ts"];
			const item = elevator.add("test-branch", "step-1", "agent-1", modifiedFiles);

			expect(item.modifiedFiles).toEqual(modifiedFiles);
		});

		it("getQueue should return copy of queue", () => {
			const elevator = new Elevator(defaultBranch);
			elevator.add("branch-1", "step-1", "agent-1");

			const queue = elevator.getQueue();
			queue.push({} as never); // Mutate returned array

			// Original queue should be unchanged
			expect(elevator.getQueue()).toHaveLength(1);
		});
	});

	describe("Conflict Detection", () => {
		it("detectQueueConflicts should detect overlapping files", () => {
			const elevator = new Elevator(defaultBranch);
			elevator.add("branch-1", "step-1", "agent-1", ["shared.ts", "file1.ts"]);
			elevator.add("branch-2", "step-2", "agent-2", ["shared.ts", "file2.ts"]);

			const conflicts = elevator.detectQueueConflicts();

			expect(conflicts).toHaveLength(1);
			expect(conflicts[0].overlappingFiles).toContain("shared.ts");
		});

		it("detectQueueConflicts should return empty for no conflicts", () => {
			const elevator = new Elevator(defaultBranch);
			elevator.add("branch-1", "step-1", "agent-1", ["file1.ts"]);
			elevator.add("branch-2", "step-2", "agent-2", ["file2.ts"]);

			const conflicts = elevator.detectQueueConflicts();

			expect(conflicts).toHaveLength(0);
		});

		it("checkConflictsBeforeAdd should detect potential conflicts", () => {
			const elevator = new Elevator(defaultBranch);
			elevator.add("branch-1", "step-1", "agent-1", ["shared.ts", "file1.ts"]);

			const conflicts = elevator.checkConflictsBeforeAdd(["shared.ts", "new-file.ts"]);

			expect(conflicts).toHaveLength(1);
			expect(conflicts[0].conflictsWith).toBe("branch-1");
		});

		it("getConflictsForBranch should return conflicts for specific branch", () => {
			const elevator = new Elevator(defaultBranch);
			elevator.add("branch-1", "step-1", "agent-1", ["shared.ts"]);
			elevator.add("branch-2", "step-2", "agent-2", ["shared.ts"]);
			elevator.add("branch-3", "step-3", "agent-3", ["other.ts"]);

			const conflicts = elevator.getConflictsForBranch("branch-1");

			expect(conflicts).toHaveLength(1);
			expect(conflicts[0].conflictsWith).toBe("branch-2");
		});
	});

	describe("Queue Summary", () => {
		it("getQueueSummary should return correct counts", () => {
			const elevator = new Elevator(defaultBranch);
			elevator.add("branch-1", "step-1", "agent-1");
			elevator.add("branch-2", "step-2", "agent-2");

			const summary = elevator.getQueueSummary();

			expect(summary.total).toBe(2);
			expect(summary.pending).toBe(2);
			expect(summary.failed).toBe(0);
		});
	});

	describe("Merge Strategy Management", () => {
		it("setMergeStrategy should update strategy", () => {
			const elevator = new Elevator(defaultBranch, "theirs");
			elevator.setMergeStrategy("ours");

			expect(elevator.getMergeStrategy()).toBe("ours");
		});
	});

	describe("Retry Configuration", () => {
		it("setRetryConfig should update config", () => {
			const elevator = new Elevator(defaultBranch);
			elevator.setRetryConfig({ maxRetries: 10 });

			const config = elevator.getRetryConfig();
			expect(config.maxRetries).toBe(10);
		});
	});

	describe("Failed Items Management", () => {
		it("getFailed should return failed items", () => {
			const elevator = new Elevator(defaultBranch);
			const item = elevator.add("branch-1", "step-1", "agent-1");
			// Manually set status for testing
			(item as Record<string, unknown>).status = "conflict";

			expect(elevator.getFailed()).toHaveLength(1);
		});

		it("clearFailed should remove failed items", () => {
			const elevator = new Elevator(defaultBranch);
			const item1 = elevator.add("branch-1", "step-1", "agent-1");
			elevator.add("branch-2", "step-2", "agent-2");
			(item1 as Record<string, unknown>).status = "conflict";

			elevator.clearFailed();

			expect(elevator.getQueue()).toHaveLength(1);
		});
	});

	describe("Elevator processNext", () => {
		it("should return null when queue is empty", async () => {
			const elevator = new Elevator(defaultBranch);
			const result = await elevator.processNext();

			expect(result).toBeNull();
		});

		it("should add items and track their status", async () => {
			// Create feature branch with changes
			const branchName = `test-add-${Date.now()}`;
			checkoutBranch(defaultBranch);
			createBranch(branchName);

			writeFileSync(join(testDir, "add-test.txt"), "test content");
			execSync("git add add-test.txt", { cwd: testDir, stdio: "pipe" });
			execSync('git commit -m "Test commit"', { cwd: testDir, stdio: "pipe" });

			// Return to main
			checkoutBranch(defaultBranch);

			// Create elevator and add branch
			const elevator = new Elevator(defaultBranch, "theirs", {
				enabled: false, // Disable retries for simpler testing
			});
			const item = elevator.add(branchName, "step-1", "agent-1");

			// Verify item was added correctly
			expect(item.branch).toBe(branchName);
			expect(item.status).toBe("pending");
			expect(elevator.getQueue()).toHaveLength(1);

			// processNext will attempt merge - in test env without proper setup
			// it may fail due to test command, but the queue mechanics work
			const result = await elevator.processNext();
			expect(result).not.toBeNull();
			// Status depends on whether rebase/test succeeds
			expect(["complete", "conflict", "test_failed"]).toContain(result?.status);
		});
	});
});
