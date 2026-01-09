/**
 * Plan Parser Module Tests
 *
 * Tests for parsing plan files into discrete tasks.
 */

import { describe, expect, it } from "vitest";
import {
	parsePlanFile,
	getPlanProgress,
	getTasksByPriority,
	getPendingTasks,
	getNextTask,
	markTaskCompleted,
	generateTaskContext,
	planToQuests,
} from "../plan-parser.js";

describe("Plan Parser", () => {
	describe("parsePlanFile", () => {
		it("parses simple task list", () => {
			const content = `
Implement the first feature
Implement the second feature
Implement the third feature
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.tasks).toHaveLength(3);
			expect(plan.tasks[0].content).toBe("Implement the first feature");
			expect(plan.tasks[1].content).toBe("Implement the second feature");
			expect(plan.tasks[2].content).toBe("Implement the third feature");
		});

		it("ignores comment lines", () => {
			const content = `
# This is a comment
Implement the first task here
# Another comment
Implement the second task here
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.tasks).toHaveLength(2);
			expect(plan.tasks[0].content).toBe("Implement the first task here");
			expect(plan.tasks[1].content).toBe("Implement the second task here");
		});

		it("ignores empty lines", () => {
			const content = `
Implement the first task

Implement the second task


Implement the third task
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.tasks).toHaveLength(3);
		});

		it("parses markdown headers as section names", () => {
			const content = `
# Section One
Implement the task in section one

## Section Two
Implement the task in section two
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.sections).toHaveLength(2);
			expect(plan.sections[0].name).toBe("Section One");
			expect(plan.sections[1].name).toBe("Section Two");
			expect(plan.tasks[0].section).toBe("Section One");
			expect(plan.tasks[1].section).toBe("Section Two");
		});

		it("parses decorated section headers", () => {
			const content = `
# =============================================================================
# CRITICAL: Important Section
# =============================================================================
Implement the task in critical section
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.sections.length).toBeGreaterThanOrEqual(1);
			expect(plan.tasks[0].section).toContain("CRITICAL");
		});

		it("extracts priority from section keywords", () => {
			const content = `
# CRITICAL Section
Implement the critical task here

# HIGH Priority
Implement the high priority task

# MEDIUM Priority
Implement the medium priority task

# LOW Priority
Implement the low priority task
`;
			const plan = parsePlanFile(content, "test.md");

			// Critical = priority 1
			expect(plan.tasks.find((t) => t.content === "Implement the critical task here")?.sectionPriority).toBe(1);
			// High = priority 3
			expect(plan.tasks.find((t) => t.content === "Implement the high priority task")?.sectionPriority).toBe(3);
			// Medium = priority 4
			expect(plan.tasks.find((t) => t.content === "Implement the medium priority task")?.sectionPriority).toBe(4);
			// Low = priority 5
			expect(plan.tasks.find((t) => t.content === "Implement the low priority task")?.sectionPriority).toBe(5);
		});

		it("cleans markdown list markers", () => {
			const content = `
- Implement the task with dash marker
* Implement the task with asterisk marker
+ Implement the task with plus marker
1. Implement the numbered task here
2) Implement this also numbered task
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.tasks[0].content).toBe("Implement the task with dash marker");
			expect(plan.tasks[1].content).toBe("Implement the task with asterisk marker");
			expect(plan.tasks[2].content).toBe("Implement the task with plus marker");
			expect(plan.tasks[3].content).toBe("Implement the numbered task here");
			expect(plan.tasks[4].content).toBe("Implement this also numbered task");
		});

		it("handles checkbox items and detects completion", () => {
			const content = `
- [ ] Uncompleted task that needs work
- [x] Completed task that is done
* [ ] Another uncompleted task here
* [X] Another completed task here
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.tasks[0].completed).toBe(false);
			expect(plan.tasks[0].content).toBe("Uncompleted task that needs work");
			expect(plan.tasks[1].completed).toBe(true);
			expect(plan.tasks[1].content).toBe("Completed task that is done");
			expect(plan.tasks[2].completed).toBe(false);
			expect(plan.tasks[3].completed).toBe(true);
		});

		it("detects [DONE] markers", () => {
			const content = `
[DONE] This task is already done
[COMPLETE] This one is completed too
Regular task that is not done yet
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.tasks[0].completed).toBe(true);
			expect(plan.tasks[0].content).toBe("This task is already done");
			expect(plan.tasks[1].completed).toBe(true);
			expect(plan.tasks[2].completed).toBe(false);
		});

		it("skips tasks in COMPLETED sections", () => {
			const content = `
# Active Section
Implement this active task here

# COMPLETED (for reference)
[DONE] This task is already done
This is also already done
`;
			const plan = parsePlanFile(content, "test.md");

			// Only the active task should be included
			expect(plan.tasks).toHaveLength(1);
			expect(plan.tasks[0].content).toBe("Implement this active task here");
		});

		it("assigns unique task IDs", () => {
			const content = `
Implement the first task here
Implement the second task here
Implement the third task here
`;
			const plan = parsePlanFile(content, "test.md");

			const ids = plan.tasks.map((t) => t.id);
			const uniqueIds = new Set(ids);
			expect(uniqueIds.size).toBe(ids.length);
		});

		it("records line numbers", () => {
			const content = `Implement task on line one here
Implement task on line two here
Implement task on line three`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.tasks[0].lineNumber).toBe(1);
			expect(plan.tasks[1].lineNumber).toBe(2);
			expect(plan.tasks[2].lineNumber).toBe(3);
		});

		it("extracts plan title from first header", () => {
			const content = `
# My Implementation Plan

## Section 1
Implement the task in section one
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.title).toBe("My Implementation Plan");
		});

		it("ignores short lines (less than 10 chars)", () => {
			const content = `
Short
This is a proper task with more content
Tiny
Another proper task here
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.tasks).toHaveLength(2);
			expect(plan.tasks[0].content).toBe("This is a proper task with more content");
			expect(plan.tasks[1].content).toBe("Another proper task here");
		});
	});

	describe("getPlanProgress", () => {
		it("calculates progress correctly", () => {
			const content = `
- [ ] Implement the first task here
- [x] Implement the second task here
- [ ] Implement the third task here
- [x] Implement the fourth task here
`;
			const plan = parsePlanFile(content, "test.md");
			const progress = getPlanProgress(plan);

			expect(progress.total).toBe(4);
			expect(progress.completed).toBe(2);
			expect(progress.pending).toBe(2);
			expect(progress.percentComplete).toBe(50);
		});

		it("handles empty plan", () => {
			const plan = parsePlanFile("# Empty plan\n# Just comments", "test.md");
			const progress = getPlanProgress(plan);

			expect(progress.total).toBe(0);
			expect(progress.completed).toBe(0);
			expect(progress.percentComplete).toBe(0);
		});

		it("groups progress by section", () => {
			const content = `
# Section A
- [x] Implement the done task A1
- [ ] Implement the todo task A2

# Section B
- [ ] Implement the todo task B1
`;
			const plan = parsePlanFile(content, "test.md");
			const progress = getPlanProgress(plan);

			expect(progress.bySections).toHaveLength(2);
			const sectionA = progress.bySections.find((s) => s.section === "Section A");
			const sectionB = progress.bySections.find((s) => s.section === "Section B");

			expect(sectionA?.total).toBe(2);
			expect(sectionA?.completed).toBe(1);
			expect(sectionB?.total).toBe(1);
			expect(sectionB?.completed).toBe(0);
		});
	});

	describe("getTasksByPriority", () => {
		it("sorts tasks by section priority then line number", () => {
			const content = `
# LOW Priority
Implement the low task number one
Implement the low task number two

# HIGH Priority
Implement the high task number one

# CRITICAL Section
Implement the critical task number one
`;
			const plan = parsePlanFile(content, "test.md");
			const sorted = getTasksByPriority(plan);

			// Critical (1) should come first
			expect(sorted[0].content).toBe("Implement the critical task number one");
			// Then High (3)
			expect(sorted[1].content).toBe("Implement the high task number one");
			// Then Low (5)
			expect(sorted[2].content).toBe("Implement the low task number one");
			expect(sorted[3].content).toBe("Implement the low task number two");
		});
	});

	describe("getPendingTasks", () => {
		it("filters out completed tasks", () => {
			const content = `
- [x] Implement the done task here
- [ ] Implement the pending task here
[DONE] Another task that is done here
Implement the pending plain task
`;
			const plan = parsePlanFile(content, "test.md");
			const pending = getPendingTasks(plan);

			expect(pending).toHaveLength(2);
			expect(pending[0].content).toBe("Implement the pending task here");
			expect(pending[1].content).toBe("Implement the pending plain task");
		});
	});

	describe("getNextTask", () => {
		it("returns highest priority pending task", () => {
			const content = `
# LOW Section
- [ ] Implement the low priority task

# CRITICAL Section
- [ ] Implement the critical task here
`;
			const plan = parsePlanFile(content, "test.md");
			const next = getNextTask(plan);

			expect(next?.content).toBe("Implement the critical task here");
		});

		it("skips completed tasks", () => {
			const content = `
# CRITICAL Section
- [x] Implement the done critical task
- [ ] Implement the pending critical task
`;
			const plan = parsePlanFile(content, "test.md");
			const next = getNextTask(plan);

			expect(next?.content).toBe("Implement the pending critical task");
		});

		it("returns undefined when all tasks complete", () => {
			const content = `
- [x] Implement the done task one
- [x] Implement the done task two
`;
			const plan = parsePlanFile(content, "test.md");
			const next = getNextTask(plan);

			expect(next).toBeUndefined();
		});
	});

	describe("markTaskCompleted", () => {
		it("marks task as completed by ID", () => {
			const content = `
Implement the first task here
Implement the second task here
`;
			const plan = parsePlanFile(content, "test.md");
			const taskId = plan.tasks[0].id;

			const updated = markTaskCompleted(plan, taskId);

			expect(updated.tasks[0].completed).toBe(true);
			expect(updated.tasks[1].completed).toBe(false);
		});

		it("does not mutate original plan", () => {
			const content = `
Implement the first task here
`;
			const plan = parsePlanFile(content, "test.md");
			const taskId = plan.tasks[0].id;

			const updated = markTaskCompleted(plan, taskId);

			expect(plan.tasks[0].completed).toBe(false);
			expect(updated.tasks[0].completed).toBe(true);
		});
	});

	describe("generateTaskContext", () => {
		it("includes current task content", () => {
			const content = `
# Section A
Implement the first task here
Implement the second task here
`;
			const plan = parsePlanFile(content, "test.md");
			const context = generateTaskContext(plan, plan.tasks[0].id);

			expect(context).toContain("Implement the first task here");
			expect(context).toContain("## Current Task");
		});

		it("includes progress information", () => {
			const content = `
- [x] Implement the done task here
- [ ] Implement the current task here
- [ ] Implement the future task here
`;
			const plan = parsePlanFile(content, "test.md");
			const context = generateTaskContext(plan, plan.tasks[1].id);

			expect(context).toContain("1/3 tasks complete");
			expect(context).toContain("33%");
		});

		it("shows section context", () => {
			const content = `
# My Section
- [x] Implement the completed in section task
- [ ] Implement the current task here
- [ ] Implement the upcoming task here
`;
			const plan = parsePlanFile(content, "test.md");
			const context = generateTaskContext(plan, plan.tasks[1].id);

			expect(context).toContain("Section: My Section");
			expect(context).toContain("Completed in this section");
			expect(context).toContain("Upcoming in this section");
		});
	});

	describe("planToQuests", () => {
		it("converts pending tasks to quest format", () => {
			const content = `
# HIGH Section
- [ ] Implement the high task here
- [x] Implement the done task here

# LOW Section
- [ ] Implement the low task here
`;
			const plan = parsePlanFile(content, "test.md");
			const quests = planToQuests(plan);

			// Should only include pending tasks
			expect(quests).toHaveLength(2);

			// Should preserve section info
			expect(quests[0].section).toContain("HIGH");
			expect(quests[1].section).toContain("LOW");

			// Should have sequential priority numbers
			expect(quests[0].priority).toBe(0);
			expect(quests[1].priority).toBe(1);
		});

		it("returns empty array for fully completed plan", () => {
			const content = `
- [x] Implement the done task one
- [x] Implement the done task two
`;
			const plan = parsePlanFile(content, "test.md");
			const quests = planToQuests(plan);

			expect(quests).toHaveLength(0);
		});
	});

	describe("real-world plan format", () => {
		it("parses quests.txt style format", () => {
			const content = `
# Undercity quest board - the space pencil roadmap
# Run: undercity load quests.txt && undercity work -y

# =============================================================================
# CRITICAL: Self-Improvement Loop (agents can't add new quests)
# =============================================================================
Add ability for agents to add new quests - when fabricator/auditor discovers work, they should be able to queue it
Parse agent output for "[NEW QUEST: ...]" markers and auto-add to quest board

# =============================================================================
# HIGH: Parallelism (the big gap vs Gas Town)
# =============================================================================
Add parallel fabricator support - spawn multiple fabricators working on different tasks simultaneously
Implement task splitting in planner - break large tasks into independent subtasks

# =============================================================================
# COMPLETED (for reference)
# =============================================================================
# [DONE] Add vitest tests for raid, cli, backlog modules
# [DONE] Switch planner from Opus to Sonnet for speed
`;
			const plan = parsePlanFile(content, "quests.txt");

			// Should have tasks from CRITICAL and HIGH sections
			expect(plan.tasks.length).toBe(4);

			// Tasks from COMPLETED section should be excluded
			const completedTasks = plan.tasks.filter((t) => t.section?.includes("COMPLETED"));
			expect(completedTasks).toHaveLength(0);

			// Check priority ordering
			const sorted = getTasksByPriority(plan);
			expect(sorted[0].section).toContain("CRITICAL");
			expect(sorted[2].section).toContain("HIGH");
		});
	});
});
