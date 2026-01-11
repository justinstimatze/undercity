/**
 * Plan Parser Module Tests
 *
 * Tests for parsing plan files into discrete steps.
 */

import { describe, expect, it } from "vitest";
import {
	generateTaskContext,
	getNextTask,
	getPendingTasks,
	getPlanProgress,
	getTasksByPriority,
	markTaskCompleted,
	parsePlanFile,
	planToTasks,
} from "../plan-parser.js";

describe("Plan Parser", () => {
	describe("parsePlanFile", () => {
		it("parses simple step list", () => {
			const content = `
Implement the first feature
Implement the second feature
Implement the third feature
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.steps).toHaveLength(3);
			expect(plan.steps[0].content).toBe("Implement the first feature");
			expect(plan.steps[1].content).toBe("Implement the second feature");
			expect(plan.steps[2].content).toBe("Implement the third feature");
		});

		it("ignores comment lines", () => {
			const content = `
# This is a comment
Implement the first step here
# Another comment
Implement the second step here
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.steps).toHaveLength(2);
			expect(plan.steps[0].content).toBe("Implement the first step here");
			expect(plan.steps[1].content).toBe("Implement the second step here");
		});

		it("ignores empty lines", () => {
			const content = `
Implement the first step

Implement the second step


Implement the third step
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.steps).toHaveLength(3);
		});

		it("parses markdown headers as section names", () => {
			const content = `
# Section One
Implement the step in section one

## Section Two
Implement the step in section two
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.sections).toHaveLength(2);
			expect(plan.sections[0].name).toBe("Section One");
			expect(plan.sections[1].name).toBe("Section Two");
			expect(plan.steps[0].section).toBe("Section One");
			expect(plan.steps[1].section).toBe("Section Two");
		});

		it("parses decorated section headers", () => {
			const content = `
# =============================================================================
# CRITICAL: Important Section
# =============================================================================
Implement the step in critical section
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.sections.length).toBeGreaterThanOrEqual(1);
			expect(plan.steps[0].section).toContain("CRITICAL");
		});

		it("extracts priority from section keywords", () => {
			const content = `
# CRITICAL Section
Implement the critical step here

# HIGH Priority
Implement the high priority step

# MEDIUM Priority
Implement the medium priority step

# LOW Priority
Implement the low priority step
`;
			const plan = parsePlanFile(content, "test.md");

			// Critical = priority 1
			expect(plan.steps.find((t) => t.content === "Implement the critical step here")?.sectionPriority).toBe(1);
			// High = priority 3
			expect(plan.steps.find((t) => t.content === "Implement the high priority step")?.sectionPriority).toBe(3);
			// Medium = priority 4
			expect(plan.steps.find((t) => t.content === "Implement the medium priority step")?.sectionPriority).toBe(4);
			// Low = priority 5
			expect(plan.steps.find((t) => t.content === "Implement the low priority step")?.sectionPriority).toBe(5);
		});

		it("cleans markdown list markers", () => {
			const content = `
- Implement the step with dash marker
* Implement the step with asterisk marker
+ Implement the step with plus marker
1. Implement the numbered step here
2) Implement this also numbered step
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.steps[0].content).toBe("Implement the step with dash marker");
			expect(plan.steps[1].content).toBe("Implement the step with asterisk marker");
			expect(plan.steps[2].content).toBe("Implement the step with plus marker");
			expect(plan.steps[3].content).toBe("Implement the numbered step here");
			expect(plan.steps[4].content).toBe("Implement this also numbered step");
		});

		it("handles checkbox items and detects completion", () => {
			const content = `
- [ ] Uncompleted step that needs work
- [x] Completed step that is done
* [ ] Another uncompleted step here
* [X] Another completed step here
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.steps[0].completed).toBe(false);
			expect(plan.steps[0].content).toBe("Uncompleted step that needs work");
			expect(plan.steps[1].completed).toBe(true);
			expect(plan.steps[1].content).toBe("Completed step that is done");
			expect(plan.steps[2].completed).toBe(false);
			expect(plan.steps[3].completed).toBe(true);
		});

		it("detects [DONE] markers", () => {
			const content = `
[DONE] This step is already done
[COMPLETE] This one is completed too
Regular step that is not done yet
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.steps[0].completed).toBe(true);
			expect(plan.steps[0].content).toBe("This step is already done");
			expect(plan.steps[1].completed).toBe(true);
			expect(plan.steps[2].completed).toBe(false);
		});

		it("skips steps in COMPLETED sections", () => {
			const content = `
# Active Section
Implement this active step here

# COMPLETED (for reference)
[DONE] This step is already done
This is also already done
`;
			const plan = parsePlanFile(content, "test.md");

			// Only the active step should be included
			expect(plan.steps).toHaveLength(1);
			expect(plan.steps[0].content).toBe("Implement this active step here");
		});

		it("assigns unique step IDs", () => {
			const content = `
Implement the first step here
Implement the second step here
Implement the third step here
`;
			const plan = parsePlanFile(content, "test.md");

			const ids = plan.steps.map((t) => t.id);
			const uniqueIds = new Set(ids);
			expect(uniqueIds.size).toBe(ids.length);
		});

		it("records line numbers", () => {
			const content = `Implement step on line one here
Implement step on line two here
Implement step on line three`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.steps[0].lineNumber).toBe(1);
			expect(plan.steps[1].lineNumber).toBe(2);
			expect(plan.steps[2].lineNumber).toBe(3);
		});

		it("extracts plan title from first header", () => {
			const content = `
# My Implementation Plan

## Section 1
Implement the step in section one
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.title).toBe("My Implementation Plan");
		});

		it("ignores short lines (less than 10 chars)", () => {
			const content = `
Short
This is a proper step with more content
Tiny
Another proper step here
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.steps).toHaveLength(2);
			expect(plan.steps[0].content).toBe("This is a proper step with more content");
			expect(plan.steps[1].content).toBe("Another proper step here");
		});
	});

	describe("getPlanProgress", () => {
		it("calculates progress correctly", () => {
			const content = `
- [ ] Implement the first step here
- [x] Implement the second step here
- [ ] Implement the third step here
- [x] Implement the fourth step here
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
- [x] Implement the done step A1
- [ ] Implement the todo step A2

# Section B
- [ ] Implement the todo step B1
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
		it("sorts steps by section priority then line number", () => {
			const content = `
# LOW Priority
Implement the low step number one
Implement the low step number two

# HIGH Priority
Implement the high step number one

# CRITICAL Section
Implement the critical step number one
`;
			const plan = parsePlanFile(content, "test.md");
			const sorted = getTasksByPriority(plan);

			// Critical (1) should come first
			expect(sorted[0].content).toBe("Implement the critical step number one");
			// Then High (3)
			expect(sorted[1].content).toBe("Implement the high step number one");
			// Then Low (5)
			expect(sorted[2].content).toBe("Implement the low step number one");
			expect(sorted[3].content).toBe("Implement the low step number two");
		});
	});

	describe("getPendingTasks", () => {
		it("filters out completed steps", () => {
			const content = `
- [x] Implement the done step here
- [ ] Implement the pending step here
[DONE] Another step that is done here
Implement the pending plain step
`;
			const plan = parsePlanFile(content, "test.md");
			const pending = getPendingTasks(plan);

			expect(pending).toHaveLength(2);
			expect(pending[0].content).toBe("Implement the pending step here");
			expect(pending[1].content).toBe("Implement the pending plain step");
		});
	});

	describe("getNextTask", () => {
		it("returns highest priority pending step", () => {
			const content = `
# LOW Section
- [ ] Implement the low priority step

# CRITICAL Section
- [ ] Implement the critical step here
`;
			const plan = parsePlanFile(content, "test.md");
			const next = getNextTask(plan);

			expect(next?.content).toBe("Implement the critical step here");
		});

		it("skips completed steps", () => {
			const content = `
# CRITICAL Section
- [x] Implement the done critical step
- [ ] Implement the pending critical step
`;
			const plan = parsePlanFile(content, "test.md");
			const next = getNextTask(plan);

			expect(next?.content).toBe("Implement the pending critical step");
		});

		it("returns undefined when all steps complete", () => {
			const content = `
- [x] Implement the done step one
- [x] Implement the done step two
`;
			const plan = parsePlanFile(content, "test.md");
			const next = getNextTask(plan);

			expect(next).toBeUndefined();
		});
	});

	describe("markTaskCompleted", () => {
		it("marks step as completed by ID", () => {
			const content = `
Implement the first step here
Implement the second step here
`;
			const plan = parsePlanFile(content, "test.md");
			const stepId = plan.steps[0].id;

			const updated = markTaskCompleted(plan, stepId);

			expect(updated.steps[0].completed).toBe(true);
			expect(updated.steps[1].completed).toBe(false);
		});

		it("does not mutate original plan", () => {
			const content = `
Implement the first step here
`;
			const plan = parsePlanFile(content, "test.md");
			const stepId = plan.steps[0].id;

			const updated = markTaskCompleted(plan, stepId);

			expect(plan.steps[0].completed).toBe(false);
			expect(updated.steps[0].completed).toBe(true);
		});
	});

	describe("generateTaskContext", () => {
		it("includes current step content", () => {
			const content = `
# Section A
Implement the first step here
Implement the second step here
`;
			const plan = parsePlanFile(content, "test.md");
			const context = generateTaskContext(plan, plan.steps[0].id);

			expect(context).toContain("Implement the first step here");
			expect(context).toContain("## Current Step");
		});

		it("includes progress information", () => {
			const content = `
- [x] Implement the done step here
- [ ] Implement the current step here
- [ ] Implement the future step here
`;
			const plan = parsePlanFile(content, "test.md");
			const context = generateTaskContext(plan, plan.steps[1].id);

			expect(context).toContain("1/3 steps complete");
			expect(context).toContain("33%");
		});

		it("shows section context", () => {
			const content = `
# My Section
- [x] Implement the completed in section step
- [ ] Implement the current step here
- [ ] Implement the upcoming step here
`;
			const plan = parsePlanFile(content, "test.md");
			const context = generateTaskContext(plan, plan.steps[1].id);

			expect(context).toContain("Section: My Section");
			expect(context).toContain("Completed in this section");
			expect(context).toContain("Upcoming in this section");
		});
	});

	describe("planToTasks", () => {
		it("converts pending steps to task format", () => {
			const content = `
# HIGH Section
- [ ] Implement the high step here
- [x] Implement the done step here

# LOW Section
- [ ] Implement the low step here
`;
			const plan = parsePlanFile(content, "test.md");
			const tasks = planToTasks(plan);

			// Should only include pending steps
			expect(tasks).toHaveLength(2);

			// Should preserve section info
			expect(tasks[0].section).toContain("HIGH");
			expect(tasks[1].section).toContain("LOW");

			// Should have sequential priority numbers
			expect(tasks[0].priority).toBe(0);
			expect(tasks[1].priority).toBe(1);
		});

		it("returns empty array for fully completed plan", () => {
			const content = `
- [x] Implement the done step one
- [x] Implement the done step two
`;
			const plan = parsePlanFile(content, "test.md");
			const tasks = planToTasks(plan);

			expect(tasks).toHaveLength(0);
		});
	});

	describe("real-world plan format", () => {
		it("parses section-based plan format with priority headers", () => {
			const content = `
# Undercity task board - the space pencil roadmap

# =============================================================================
# CRITICAL: Self-Improvement Loop (agents can't add new tasks)
# =============================================================================
Add ability for agents to add new tasks - when builder/sheriff discovers work, they should be able to queue it
Parse agent output for "[NEW QUEST: ...]" markers and auto-add to task board

# =============================================================================
# HIGH: Parallelism (the big gap vs Gas Town)
# =============================================================================
Add parallel builder support - spawn multiple builders working on different steps simultaneously
Implement step splitting in logistics - break large steps into independent subtasks

# =============================================================================
# COMPLETED (for reference)
# =============================================================================
# [DONE] Add vitest tests for raid, cli, backlog modules
# [DONE] Switch logistics from Opus to Sonnet for speed
`;
			const plan = parsePlanFile(content, "intel.txt");

			// Should have steps from CRITICAL and HIGH sections
			expect(plan.steps.length).toBe(4);

			// Tasks from COMPLETED section should be excluded
			const completedTasks = plan.steps.filter((t) => t.section?.includes("COMPLETED"));
			expect(completedTasks).toHaveLength(0);

			// Check priority ordering
			const sorted = getTasksByPriority(plan);
			expect(sorted[0].section).toContain("CRITICAL");
			expect(sorted[2].section).toContain("HIGH");
		});
	});
});
