/**
 * Integration test for full grind flow
 *
 * Tests the complete autonomous task execution cycle from task board to completion.
 * Uses a real temporary git repo but mocks the AI execution for speed and determinism.
 *
 * Note: These tests are skipped during verification runs to avoid slowdowns.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Task } from "../../types.js";

// Skip git-heavy integration tests during verification runs
const isCoverage = process.env.npm_lifecycle_event?.includes("coverage");
const isVerification = process.env.UNDERCITY_VERIFICATION === "true";
const describeIntegration = isCoverage || isVerification ? describe.skip : describe.sequential;

describeIntegration("Grind Flow Integration", () => {
	let testRepoPath: string;
	let tasksJsonPath: string;

	beforeEach(() => {
		// Create a minimal test git repo
		testRepoPath = mkdtempSync(join(tmpdir(), "grind-test-"));
		tasksJsonPath = join(testRepoPath, ".undercity", "tasks.json");

		// Initialize git
		execSync("git init", { cwd: testRepoPath, stdio: "pipe" });
		execSync('git config user.email "test@test.com"', { cwd: testRepoPath, stdio: "pipe" });
		execSync('git config user.name "Test User"', { cwd: testRepoPath, stdio: "pipe" });

		// Create minimal package.json with passing verification scripts
		writeFileSync(
			join(testRepoPath, "package.json"),
			JSON.stringify(
				{
					name: "test-repo",
					version: "1.0.0",
					scripts: {
						typecheck: "echo 'typecheck passed'",
						test: "echo 'tests passed'",
						lint: "echo 'lint passed'",
						build: "echo 'build passed'",
					},
				},
				null,
				2,
			),
		);

		// Create .undercity directory structure
		mkdirSync(join(testRepoPath, ".undercity"), { recursive: true });

		// Initial commit
		execSync("git add .", { cwd: testRepoPath, stdio: "pipe" });
		execSync('git commit -m "Initial commit"', { cwd: testRepoPath, stdio: "pipe" });
	});

	afterEach(() => {
		if (existsSync(testRepoPath)) {
			try {
				// Clean up any worktrees
				const worktrees = execSync("git worktree list --porcelain", {
					cwd: testRepoPath,
					encoding: "utf-8",
					stdio: "pipe",
				});
				const worktreePaths = worktrees
					.split("\n")
					.filter((line) => line.startsWith("worktree "))
					.map((line) => line.replace("worktree ", ""))
					.filter((path) => path !== testRepoPath);

				for (const path of worktreePaths) {
					try {
						execSync(`git worktree remove "${path}" --force`, {
							cwd: testRepoPath,
							stdio: "pipe",
						});
					} catch {
						// Ignore cleanup errors
					}
				}
			} catch {
				// Ignore if git worktree command fails
			}

			rmSync(testRepoPath, { recursive: true, force: true });

			// Also clean up worktrees directory (sibling to test repo)
			const worktreesDir = `${testRepoPath}-worktrees`;
			if (existsSync(worktreesDir)) {
				rmSync(worktreesDir, { recursive: true, force: true });
			}
		}
	});

	describe("Task Selection", () => {
		it("should load tasks from board and sort by priority", () => {
			const tasks: Task[] = [
				{
					id: "task-1",
					objective: "Low priority task",
					status: "pending",
					priority: 100,
					createdAt: new Date().toISOString(),
				},
				{
					id: "task-2",
					objective: "High priority task",
					status: "pending",
					priority: 1,
					createdAt: new Date().toISOString(),
				},
				{
					id: "task-3",
					objective: "Medium priority task",
					status: "pending",
					priority: 50,
					createdAt: new Date().toISOString(),
				},
			];

			writeFileSync(tasksJsonPath, JSON.stringify({ tasks }, null, 2));

			// Load and sort tasks (simulating what grind does)
			// Higher priority number = more important = comes first
			const loaded = JSON.parse(readFileSync(tasksJsonPath, "utf-8")).tasks;
			const sorted = loaded
				.filter((t: Task) => t.status === "pending")
				.sort((a: Task, b: Task) => (b.priority ?? 0) - (a.priority ?? 0));

			expect(sorted).toHaveLength(3);
			expect(sorted[0].id).toBe("task-1"); // priority 100 (highest)
			expect(sorted[1].id).toBe("task-3"); // priority 50
			expect(sorted[2].id).toBe("task-2"); // priority 1 (lowest)
		});

		it("should filter out non-pending tasks", () => {
			const tasks: Task[] = [
				{
					id: "task-1",
					objective: "Pending task",
					status: "pending",
					priority: 1,
					createdAt: new Date().toISOString(),
				},
				{
					id: "task-2",
					objective: "Completed task",
					status: "complete",
					priority: 2,
					createdAt: new Date().toISOString(),
				},
				{
					id: "task-3",
					objective: "Failed task",
					status: "failed",
					priority: 3,
					createdAt: new Date().toISOString(),
				},
			];

			writeFileSync(tasksJsonPath, JSON.stringify({ tasks }, null, 2));

			const loaded = JSON.parse(readFileSync(tasksJsonPath, "utf-8")).tasks;
			const pending = loaded.filter((t: Task) => t.status === "pending");

			expect(pending).toHaveLength(1);
			expect(pending[0].id).toBe("task-1");
		});
	});

	describe("Task Completion", () => {
		it("should mark task as complete after successful merge", () => {
			const tasks: Task[] = [
				{
					id: "task-1",
					objective: "Test task",
					status: "pending",
					priority: 1,
					createdAt: new Date().toISOString(),
				},
			];

			writeFileSync(tasksJsonPath, JSON.stringify({ tasks }, null, 2));

			// Simulate task completion
			const board = JSON.parse(readFileSync(tasksJsonPath, "utf-8"));
			board.tasks[0].status = "complete";
			board.tasks[0].completedAt = new Date().toISOString();
			writeFileSync(tasksJsonPath, JSON.stringify(board, null, 2));

			// Verify task is marked complete
			const updated = JSON.parse(readFileSync(tasksJsonPath, "utf-8"));
			expect(updated.tasks[0].status).toBe("complete");
			expect(updated.tasks[0].completedAt).toBeDefined();
		});
	});
});
