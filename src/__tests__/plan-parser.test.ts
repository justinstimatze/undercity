/**
 * Plan Parser Module Tests
 *
 * Tests for parsing plan files into discrete waypoints.
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
	planToQuests,
} from "../plan-parser.js";

describe("Plan Parser", () => {
	describe("parsePlanFile", () => {
		it("parses simple waypoint list", () => {
			const content = `
Implement the first feature
Implement the second feature
Implement the third feature
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.waypoints).toHaveLength(3);
			expect(plan.waypoints[0].content).toBe("Implement the first feature");
			expect(plan.waypoints[1].content).toBe("Implement the second feature");
			expect(plan.waypoints[2].content).toBe("Implement the third feature");
		});

		it("ignores comment lines", () => {
			const content = `
# This is a comment
Implement the first waypoint here
# Another comment
Implement the second waypoint here
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.waypoints).toHaveLength(2);
			expect(plan.waypoints[0].content).toBe("Implement the first waypoint here");
			expect(plan.waypoints[1].content).toBe("Implement the second waypoint here");
		});

		it("ignores empty lines", () => {
			const content = `
Implement the first waypoint

Implement the second waypoint


Implement the third waypoint
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.waypoints).toHaveLength(3);
		});

		it("parses markdown headers as section names", () => {
			const content = `
# Section One
Implement the waypoint in section one

## Section Two
Implement the waypoint in section two
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.sections).toHaveLength(2);
			expect(plan.sections[0].name).toBe("Section One");
			expect(plan.sections[1].name).toBe("Section Two");
			expect(plan.waypoints[0].section).toBe("Section One");
			expect(plan.waypoints[1].section).toBe("Section Two");
		});

		it("parses decorated section headers", () => {
			const content = `
# =============================================================================
# CRITICAL: Important Section
# =============================================================================
Implement the waypoint in critical section
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.sections.length).toBeGreaterThanOrEqual(1);
			expect(plan.waypoints[0].section).toContain("CRITICAL");
		});

		it("extracts priority from section keywords", () => {
			const content = `
# CRITICAL Section
Implement the critical waypoint here

# HIGH Priority
Implement the high priority waypoint

# MEDIUM Priority
Implement the medium priority waypoint

# LOW Priority
Implement the low priority waypoint
`;
			const plan = parsePlanFile(content, "test.md");

			// Critical = priority 1
			expect(plan.waypoints.find((t) => t.content === "Implement the critical waypoint here")?.sectionPriority).toBe(1);
			// High = priority 3
			expect(plan.waypoints.find((t) => t.content === "Implement the high priority waypoint")?.sectionPriority).toBe(3);
			// Medium = priority 4
			expect(plan.waypoints.find((t) => t.content === "Implement the medium priority waypoint")?.sectionPriority).toBe(
				4,
			);
			// Low = priority 5
			expect(plan.waypoints.find((t) => t.content === "Implement the low priority waypoint")?.sectionPriority).toBe(5);
		});

		it("cleans markdown list markers", () => {
			const content = `
- Implement the waypoint with dash marker
* Implement the waypoint with asterisk marker
+ Implement the waypoint with plus marker
1. Implement the numbered waypoint here
2) Implement this also numbered waypoint
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.waypoints[0].content).toBe("Implement the waypoint with dash marker");
			expect(plan.waypoints[1].content).toBe("Implement the waypoint with asterisk marker");
			expect(plan.waypoints[2].content).toBe("Implement the waypoint with plus marker");
			expect(plan.waypoints[3].content).toBe("Implement the numbered waypoint here");
			expect(plan.waypoints[4].content).toBe("Implement this also numbered waypoint");
		});

		it("handles checkbox items and detects completion", () => {
			const content = `
- [ ] Uncompleted waypoint that needs work
- [x] Completed waypoint that is done
* [ ] Another uncompleted waypoint here
* [X] Another completed waypoint here
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.waypoints[0].completed).toBe(false);
			expect(plan.waypoints[0].content).toBe("Uncompleted waypoint that needs work");
			expect(plan.waypoints[1].completed).toBe(true);
			expect(plan.waypoints[1].content).toBe("Completed waypoint that is done");
			expect(plan.waypoints[2].completed).toBe(false);
			expect(plan.waypoints[3].completed).toBe(true);
		});

		it("detects [DONE] markers", () => {
			const content = `
[DONE] This waypoint is already done
[COMPLETE] This one is completed too
Regular waypoint that is not done yet
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.waypoints[0].completed).toBe(true);
			expect(plan.waypoints[0].content).toBe("This waypoint is already done");
			expect(plan.waypoints[1].completed).toBe(true);
			expect(plan.waypoints[2].completed).toBe(false);
		});

		it("skips waypoints in COMPLETED sections", () => {
			const content = `
# Active Section
Implement this active waypoint here

# COMPLETED (for reference)
[DONE] This waypoint is already done
This is also already done
`;
			const plan = parsePlanFile(content, "test.md");

			// Only the active waypoint should be included
			expect(plan.waypoints).toHaveLength(1);
			expect(plan.waypoints[0].content).toBe("Implement this active waypoint here");
		});

		it("assigns unique waypoint IDs", () => {
			const content = `
Implement the first waypoint here
Implement the second waypoint here
Implement the third waypoint here
`;
			const plan = parsePlanFile(content, "test.md");

			const ids = plan.waypoints.map((t) => t.id);
			const uniqueIds = new Set(ids);
			expect(uniqueIds.size).toBe(ids.length);
		});

		it("records line numbers", () => {
			const content = `Implement waypoint on line one here
Implement waypoint on line two here
Implement waypoint on line three`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.waypoints[0].lineNumber).toBe(1);
			expect(plan.waypoints[1].lineNumber).toBe(2);
			expect(plan.waypoints[2].lineNumber).toBe(3);
		});

		it("extracts plan title from first header", () => {
			const content = `
# My Implementation Plan

## Section 1
Implement the waypoint in section one
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.title).toBe("My Implementation Plan");
		});

		it("ignores short lines (less than 10 chars)", () => {
			const content = `
Short
This is a proper waypoint with more content
Tiny
Another proper waypoint here
`;
			const plan = parsePlanFile(content, "test.md");

			expect(plan.waypoints).toHaveLength(2);
			expect(plan.waypoints[0].content).toBe("This is a proper waypoint with more content");
			expect(plan.waypoints[1].content).toBe("Another proper waypoint here");
		});
	});

	describe("getPlanProgress", () => {
		it("calculates progress correctly", () => {
			const content = `
- [ ] Implement the first waypoint here
- [x] Implement the second waypoint here
- [ ] Implement the third waypoint here
- [x] Implement the fourth waypoint here
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
- [x] Implement the done waypoint A1
- [ ] Implement the todo waypoint A2

# Section B
- [ ] Implement the todo waypoint B1
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
		it("sorts waypoints by section priority then line number", () => {
			const content = `
# LOW Priority
Implement the low waypoint number one
Implement the low waypoint number two

# HIGH Priority
Implement the high waypoint number one

# CRITICAL Section
Implement the critical waypoint number one
`;
			const plan = parsePlanFile(content, "test.md");
			const sorted = getTasksByPriority(plan);

			// Critical (1) should come first
			expect(sorted[0].content).toBe("Implement the critical waypoint number one");
			// Then High (3)
			expect(sorted[1].content).toBe("Implement the high waypoint number one");
			// Then Low (5)
			expect(sorted[2].content).toBe("Implement the low waypoint number one");
			expect(sorted[3].content).toBe("Implement the low waypoint number two");
		});
	});

	describe("getPendingTasks", () => {
		it("filters out completed waypoints", () => {
			const content = `
- [x] Implement the done waypoint here
- [ ] Implement the pending waypoint here
[DONE] Another waypoint that is done here
Implement the pending plain waypoint
`;
			const plan = parsePlanFile(content, "test.md");
			const pending = getPendingTasks(plan);

			expect(pending).toHaveLength(2);
			expect(pending[0].content).toBe("Implement the pending waypoint here");
			expect(pending[1].content).toBe("Implement the pending plain waypoint");
		});
	});

	describe("getNextTask", () => {
		it("returns highest priority pending waypoint", () => {
			const content = `
# LOW Section
- [ ] Implement the low priority waypoint

# CRITICAL Section
- [ ] Implement the critical waypoint here
`;
			const plan = parsePlanFile(content, "test.md");
			const next = getNextTask(plan);

			expect(next?.content).toBe("Implement the critical waypoint here");
		});

		it("skips completed waypoints", () => {
			const content = `
# CRITICAL Section
- [x] Implement the done critical waypoint
- [ ] Implement the pending critical waypoint
`;
			const plan = parsePlanFile(content, "test.md");
			const next = getNextTask(plan);

			expect(next?.content).toBe("Implement the pending critical waypoint");
		});

		it("returns undefined when all waypoints complete", () => {
			const content = `
- [x] Implement the done waypoint one
- [x] Implement the done waypoint two
`;
			const plan = parsePlanFile(content, "test.md");
			const next = getNextTask(plan);

			expect(next).toBeUndefined();
		});
	});

	describe("markTaskCompleted", () => {
		it("marks waypoint as completed by ID", () => {
			const content = `
Implement the first waypoint here
Implement the second waypoint here
`;
			const plan = parsePlanFile(content, "test.md");
			const waypointId = plan.waypoints[0].id;

			const updated = markTaskCompleted(plan, waypointId);

			expect(updated.waypoints[0].completed).toBe(true);
			expect(updated.waypoints[1].completed).toBe(false);
		});

		it("does not mutate original plan", () => {
			const content = `
Implement the first waypoint here
`;
			const plan = parsePlanFile(content, "test.md");
			const waypointId = plan.waypoints[0].id;

			const updated = markTaskCompleted(plan, waypointId);

			expect(plan.waypoints[0].completed).toBe(false);
			expect(updated.waypoints[0].completed).toBe(true);
		});
	});

	describe("generateTaskContext", () => {
		it("includes current waypoint content", () => {
			const content = `
# Section A
Implement the first waypoint here
Implement the second waypoint here
`;
			const plan = parsePlanFile(content, "test.md");
			const context = generateTaskContext(plan, plan.waypoints[0].id);

			expect(context).toContain("Implement the first waypoint here");
			expect(context).toContain("## Current Waypoint");
		});

		it("includes progress information", () => {
			const content = `
- [x] Implement the done waypoint here
- [ ] Implement the current waypoint here
- [ ] Implement the future waypoint here
`;
			const plan = parsePlanFile(content, "test.md");
			const context = generateTaskContext(plan, plan.waypoints[1].id);

			expect(context).toContain("1/3 waypoints complete");
			expect(context).toContain("33%");
		});

		it("shows section context", () => {
			const content = `
# My Section
- [x] Implement the completed in section waypoint
- [ ] Implement the current waypoint here
- [ ] Implement the upcoming waypoint here
`;
			const plan = parsePlanFile(content, "test.md");
			const context = generateTaskContext(plan, plan.waypoints[1].id);

			expect(context).toContain("Section: My Section");
			expect(context).toContain("Completed in this section");
			expect(context).toContain("Upcoming in this section");
		});
	});

	describe("planToQuests", () => {
		it("converts pending waypoints to quest format", () => {
			const content = `
# HIGH Section
- [ ] Implement the high waypoint here
- [x] Implement the done waypoint here

# LOW Section
- [ ] Implement the low waypoint here
`;
			const plan = parsePlanFile(content, "test.md");
			const quests = planToQuests(plan);

			// Should only include pending waypoints
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
- [x] Implement the done waypoint one
- [x] Implement the done waypoint two
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
Add ability for agents to add new quests - when quester/sheriff discovers work, they should be able to queue it
Parse agent output for "[NEW QUEST: ...]" markers and auto-add to quest board

# =============================================================================
# HIGH: Parallelism (the big gap vs Gas Town)
# =============================================================================
Add parallel quester support - spawn multiple questers working on different waypoints simultaneously
Implement waypoint splitting in logistics - break large waypoints into independent subtasks

# =============================================================================
# COMPLETED (for reference)
# =============================================================================
# [DONE] Add vitest tests for raid, cli, backlog modules
# [DONE] Switch logistics from Opus to Sonnet for speed
`;
			const plan = parsePlanFile(content, "quests.txt");

			// Should have waypoints from CRITICAL and HIGH sections
			expect(plan.waypoints.length).toBe(4);

			// Tasks from COMPLETED section should be excluded
			const completedTasks = plan.waypoints.filter((t) => t.section?.includes("COMPLETED"));
			expect(completedTasks).toHaveLength(0);

			// Check priority ordering
			const sorted = getTasksByPriority(plan);
			expect(sorted[0].section).toContain("CRITICAL");
			expect(sorted[2].section).toContain("HIGH");
		});
	});
});
