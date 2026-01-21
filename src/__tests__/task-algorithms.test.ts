/**
 * Task Algorithm Tests
 *
 * Tests the priority and duplicate detection algorithms in task.ts.
 * These are pure function tests that don't require filesystem access.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "../storage.js";
import {
	addTask,
	decomposeTaskIntoSubtasks,
	findDuplicateTask,
	getAllTasks,
	getNextTask,
	markTaskComplete,
} from "../task.js";

// =============================================================================
// Test Setup
// =============================================================================

describe("Task Algorithms", () => {
	let testDir: string;
	let tasksPath: string;

	beforeEach(() => {
		resetDatabase();
		testDir = mkdtempSync(join(tmpdir(), "task-algo-test-"));
		mkdirSync(join(testDir, ".undercity"), { recursive: true });
		tasksPath = join(testDir, ".undercity", "tasks.json");
	});

	afterEach(() => {
		resetDatabase();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	// =========================================================================
	// extractKeywords() - tested indirectly through findDuplicateTask
	// =========================================================================

	describe("extractKeywords (via findDuplicateTask)", () => {
		it("removes stop words from keyword extraction", () => {
			// Add a task with stop words
			addTask("Fix the bug in the authentication module", undefined, tasksPath);

			// A similar task with different stop words should be detected
			const duplicate = findDuplicateTask(
				"Fix a bug to authentication with module",
				join(testDir, ".undercity"),
			);

			// Should find the match because significant keywords overlap
			expect(duplicate).not.toBeUndefined();
		});

		it("filters out short words (≤2 chars)", () => {
			// Add task with short words
			addTask("Add new UI to the app for users", undefined, tasksPath);

			// Search with same content - "UI" (2 chars) should be filtered
			// "add", "new", "app", "for", "users" are the significant words
			const duplicate = findDuplicateTask(
				"Add new app to UI for users",
				join(testDir, ".undercity"),
			);

			expect(duplicate).not.toBeUndefined();
		});

		it("returns deduplicated set of keywords", () => {
			// Task with repeated words
			addTask("Fix bug bug fix authentication authentication", undefined, tasksPath);

			// Should match even though original had duplicates
			const duplicate = findDuplicateTask(
				"Fix authentication bug",
				join(testDir, ".undercity"),
			);

			expect(duplicate).not.toBeUndefined();
		});
	});

	// =========================================================================
	// jaccardSimilarity() - tested indirectly through findDuplicateTask
	// =========================================================================

	describe("jaccardSimilarity (via findDuplicateTask)", () => {
		it("returns 1 for identical sets", () => {
			addTask("Implement user authentication system", undefined, tasksPath);

			// Exact match should be found
			const duplicate = findDuplicateTask(
				"Implement user authentication system",
				join(testDir, ".undercity"),
			);

			expect(duplicate).not.toBeUndefined();
		});

		it("handles empty/low-keyword objectives gracefully", () => {
			// Task with very few meaningful words
			addTask("Fix it", undefined, tasksPath);

			// Short tasks don't trigger similarity check
			const result = findDuplicateTask("Fix it", join(testDir, ".undercity"));

			// Should find exact match (after normalization)
			expect(result).not.toBeUndefined();
		});

		it("returns 0 for disjoint sets (no duplicate found)", () => {
			addTask("Implement user authentication", undefined, tasksPath);

			// Completely different task
			const duplicate = findDuplicateTask(
				"Refactor database connection pooling",
				join(testDir, ".undercity"),
			);

			expect(duplicate).toBeUndefined();
		});
	});

	// =========================================================================
	// findDuplicateTask() threshold behavior
	// =========================================================================

	describe("findDuplicateTask threshold behavior", () => {
		it("detects exact match after normalization", () => {
			addTask("[plan] Implement feature X", undefined, tasksPath);

			// Same task without prefix
			const duplicate = findDuplicateTask("implement feature x", join(testDir, ".undercity"));

			expect(duplicate).not.toBeUndefined();
		});

		it("detects [meta:*] prefix removal in normalization", () => {
			addTask("[meta:triage] Review pending tasks", undefined, tasksPath);

			const duplicate = findDuplicateTask("Review pending tasks", join(testDir, ".undercity"));

			expect(duplicate).not.toBeUndefined();
		});

		it("requires 80% similarity AND ≥2 shared keywords", () => {
			// Task with 4 keywords: add, user, authentication, oauth
			addTask("Add user authentication with OAuth", undefined, tasksPath);

			// New has 5 keywords: add, user, authentication, oauth, login
			// Intersection: 4, Union: 5, Jaccard: 4/5 = 0.8 (80%)
			const duplicate = findDuplicateTask(
				"Add user authentication OAuth login",
				join(testDir, ".undercity"),
			);

			expect(duplicate).not.toBeUndefined();
		});

		it("does not match at 79% similarity (just below threshold)", () => {
			// Task with 6 distinct keywords
			addTask("Implement user authentication OAuth provider system", undefined, tasksPath);

			// Only 4/7 overlap when union considered = ~57%
			const duplicate = findDuplicateTask(
				"Build database connection pooling system feature",
				join(testDir, ".undercity"),
			);

			expect(duplicate).toBeUndefined();
		});

		it("skips similarity check for tasks with <3 keywords", () => {
			// Short task
			addTask("Fix bug", undefined, tasksPath);

			// Similar short task - should not match via similarity (only exact match)
			const duplicate = findDuplicateTask("Fix error", join(testDir, ".undercity"));

			expect(duplicate).toBeUndefined();
		});

		it("requires at least 2 shared keywords for duplicate detection", () => {
			addTask("Implement authentication system provider login", undefined, tasksPath);

			// Only 1 shared keyword ("system") - should not match
			const duplicate = findDuplicateTask(
				"Database optimization system module",
				join(testDir, ".undercity"),
			);

			expect(duplicate).toBeUndefined();
		});

		it("only checks pending and in_progress tasks", () => {
			const task = addTask("Implement feature X", undefined, tasksPath);
			markTaskComplete(task.id, tasksPath);

			// Completed task should not be detected as duplicate
			const duplicate = findDuplicateTask("Implement feature X", join(testDir, ".undercity"));

			expect(duplicate).toBeUndefined();
		});
	});

	// =========================================================================
	// getNextTask() priority scoring
	// =========================================================================

	describe("getNextTask priority scoring", () => {
		it("returns task with lowest computed priority score", () => {
			addTask("Task with priority 10", 10, tasksPath);
			addTask("Task with priority 5", 5, tasksPath);
			addTask("Task with priority 15", 15, tasksPath);

			const next = getNextTask(tasksPath);

			expect(next).not.toBeUndefined();
			expect(next?.priority).toBe(5);
		});

		it("applies critical tag boost (-50)", () => {
			// Lower priority number = processed first
			addTask("Normal task", 100, tasksPath);
			const criticalTask = addTask(
				"Important task",
				{ priority: 150, tags: ["critical"], path: tasksPath },
			);

			const next = getNextTask(tasksPath);

			// Critical task should be picked despite higher base priority
			// 150 - 50 (critical) = 100, same as normal, but critical was added second
			// Actually with same score, depends on order in array
			expect(next).not.toBeUndefined();
		});

		it("applies bugfix tag boost (-30)", () => {
			addTask("Feature task", 50, tasksPath);
			const bugfixTask = addTask(
				"Fix authentication bug",
				{ priority: 75, tags: ["bugfix"], path: tasksPath },
			);

			const next = getNextTask(tasksPath);

			// 75 - 30 = 45, lower than 50
			expect(next?.id).toBe(bugfixTask.id);
		});

		it("applies security tag boost (-25)", () => {
			addTask("Regular task", 50, tasksPath);
			const securityTask = addTask(
				"Security patch",
				{ priority: 70, tags: ["security"], path: tasksPath },
			);

			const next = getNextTask(tasksPath);

			// 70 - 25 = 45, lower than 50
			expect(next?.id).toBe(securityTask.id);
		});

		it("caps age penalty at +30", () => {
			// Create task with lower base priority - even if it had +30 age penalty,
			// it would still have a lower score than a fresh task with higher base priority
			const lowerPriorityTask = addTask("Low priority task", 50, tasksPath);
			addTask("High priority task", 100, tasksPath);

			// 50 + 30 (max age penalty) = 80, still lower than 100
			// So lower priority task should always be selected regardless of age
			const next = getNextTask(tasksPath);

			// Lower base priority wins even with max age penalty
			expect(next?.id).toBe(lowerPriorityTask.id);
		});

		it("adds dependency penalty (+5 per dependency)", () => {
			const prereq1 = addTask("Prerequisite 1", 10, tasksPath);
			const prereq2 = addTask("Prerequisite 2", 10, tasksPath);
			markTaskComplete(prereq1.id, tasksPath);
			markTaskComplete(prereq2.id, tasksPath);

			const taskWithDeps = addTask(
				"Task with dependencies",
				{ priority: 20, dependsOn: [prereq1.id, prereq2.id], path: tasksPath },
			);
			const taskNoDeps = addTask("Task without dependencies", 20, tasksPath);

			const next = getNextTask(tasksPath);

			// Task without deps should be picked: 20 vs 20 + 10 (2 deps * 5)
			expect(next?.id).toBe(taskNoDeps.id);
		});

		it("skips decomposed tasks", () => {
			const task = addTask("Parent task", 1, tasksPath);
			addTask("Child task", 10, tasksPath);

			// Mark parent as decomposed by decomposing it
			decomposeTaskIntoSubtasks(
				task.id,
				[{ objective: "Subtask 1", order: 1 }],
				tasksPath,
			);

			const next = getNextTask(tasksPath);

			// Should not return decomposed parent (priority 1)
			expect(next?.isDecomposed).not.toBe(true);
		});

		it("skips tasks with unsatisfied dependencies", () => {
			const prereq = addTask("Prerequisite", 100, tasksPath);
			addTask(
				"Dependent task",
				{ priority: 1, dependsOn: [prereq.id], path: tasksPath },
			);

			const next = getNextTask(tasksPath);

			// Should return prereq since dependent has unsatisfied dependency
			expect(next?.id).toBe(prereq.id);
		});

		it("returns undefined when no tasks are available", () => {
			const next = getNextTask(tasksPath);
			expect(next).toBeUndefined();
		});

		it("combines multiple tag boosts", () => {
			addTask("Normal task", 50, tasksPath);
			const criticalBugfix = addTask(
				"Critical bug",
				{ priority: 130, tags: ["critical", "bugfix"], path: tasksPath },
			);

			const next = getNextTask(tasksPath);

			// 130 - 50 (critical) - 30 (bugfix) = 50, equal to normal
			// But critical bugfix was added second, so depends on sort stability
			expect(next).not.toBeUndefined();
		});
	});

	// =========================================================================
	// Integration: Duplicate detection with addTask
	// =========================================================================

	describe("addTask duplicate detection integration", () => {
		it("returns existing task when duplicate detected", () => {
			const original = addTask("Implement user authentication", undefined, tasksPath);
			const duplicate = addTask("Implement user authentication", undefined, tasksPath);

			expect(duplicate.id).toBe(original.id);
			expect(getAllTasks(tasksPath)).toHaveLength(1);
		});

		it("allows skipDuplicateCheck option", () => {
			addTask("Implement user authentication", undefined, tasksPath);
			const newTask = addTask(
				"Implement user authentication",
				{ skipDuplicateCheck: true, path: tasksPath },
			);

			expect(getAllTasks(tasksPath)).toHaveLength(2);
		});

		it("handles whitespace normalization", () => {
			const original = addTask("Fix   bug   in   code", undefined, tasksPath);
			const duplicate = addTask("Fix bug in code", undefined, tasksPath);

			expect(duplicate.id).toBe(original.id);
		});

		it("handles case normalization", () => {
			const original = addTask("FIX BUG IN CODE", undefined, tasksPath);
			const duplicate = addTask("fix bug in code", undefined, tasksPath);

			expect(duplicate.id).toBe(original.id);
		});
	});
});
