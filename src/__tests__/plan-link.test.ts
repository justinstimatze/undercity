/**
 * Tests for plan-link.ts
 *
 * Tests plan-task linkage, frontmatter parsing, and plan management.
 * Uses temp directories for file operations.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findLinkedPlans,
	findPlanForTask,
	linkTasksToPlan,
	listPlans,
	markPlanComplete,
	type PlanMetadata,
	parsePlanFile,
	resolvePlanPath,
	unlinkTasksFromPlan,
	updatePlanMetadata,
} from "../plan-link.js";

describe("plan-link", () => {
	let tempDir: string;
	let plansDir: string;

	beforeEach(() => {
		// Create a unique temp directory for each test
		tempDir = join(tmpdir(), `plan-link-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		plansDir = join(tempDir, "plans");
		mkdirSync(plansDir, { recursive: true });
	});

	afterEach(() => {
		// Clean up temp directory
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	describe("parsePlanFile", () => {
		it("parses plan without frontmatter", () => {
			const planPath = join(plansDir, "simple.md");
			writeFileSync(
				planPath,
				`# My Plan

Some content here.
`,
			);

			const result = parsePlanFile(planPath);

			expect(result).not.toBeNull();
			expect(result?.name).toBe("simple.md");
			expect(result?.title).toBe("My Plan");
			expect(result?.hasFrontmatter).toBe(false);
			expect(result?.metadata).toBeUndefined();
			expect(result?.content).toContain("Some content here");
		});

		it("parses plan with undercity frontmatter", () => {
			const planPath = join(plansDir, "linked.md");
			writeFileSync(
				planPath,
				`---
undercity:
  tasks: ["task-abc", "task-def"]
  project: /home/user/myproject
  linkedAt: 2026-01-15T12:00:00.000Z
  status: implementing
---

# Linked Plan

Content after frontmatter.
`,
			);

			const result = parsePlanFile(planPath);

			expect(result).not.toBeNull();
			expect(result?.hasFrontmatter).toBe(true);
			expect(result?.metadata?.tasks).toEqual(["task-abc", "task-def"]);
			expect(result?.metadata?.project).toBe("/home/user/myproject");
			expect(result?.metadata?.linkedAt).toBe("2026-01-15T12:00:00.000Z");
			expect(result?.metadata?.status).toBe("implementing");
			expect(result?.title).toBe("Linked Plan");
		});

		it("returns null for non-existent file", () => {
			const result = parsePlanFile(join(plansDir, "nonexistent.md"));
			expect(result).toBeNull();
		});

		it("handles empty tasks array", () => {
			const planPath = join(plansDir, "empty-tasks.md");
			writeFileSync(
				planPath,
				`---
undercity:
  tasks: []
  status: draft
---

# Empty Tasks Plan
`,
			);

			const result = parsePlanFile(planPath);

			expect(result?.metadata?.tasks).toEqual([]);
		});

		it("extracts title from content", () => {
			const planPath = join(plansDir, "titled.md");
			writeFileSync(
				planPath,
				`# Plan Title Here

## Section

Content
`,
			);

			const result = parsePlanFile(planPath);

			expect(result?.title).toBe("Plan Title Here");
		});

		it("handles plan without title", () => {
			const planPath = join(plansDir, "no-title.md");
			writeFileSync(
				planPath,
				`Just some content without a heading.
`,
			);

			const result = parsePlanFile(planPath);

			expect(result?.title).toBeUndefined();
		});
	});

	describe("updatePlanMetadata", () => {
		it("adds frontmatter to plan without it", () => {
			const planPath = join(plansDir, "add-meta.md");
			writeFileSync(
				planPath,
				`# Plan Without Frontmatter

Content here.
`,
			);

			const metadata: PlanMetadata = {
				tasks: ["task-123"],
				project: "/project/path",
				linkedAt: "2026-01-20T10:00:00.000Z",
				status: "approved",
			};

			const success = updatePlanMetadata(planPath, metadata);

			expect(success).toBe(true);

			// Re-read and verify
			const updated = parsePlanFile(planPath);
			expect(updated?.hasFrontmatter).toBe(true);
			expect(updated?.metadata?.tasks).toEqual(["task-123"]);
			expect(updated?.metadata?.status).toBe("approved");
		});

		it("updates existing frontmatter", () => {
			const planPath = join(plansDir, "update-meta.md");
			writeFileSync(
				planPath,
				`---
undercity:
  tasks: ["old-task"]
  status: draft
---

# Plan

Content.
`,
			);

			const metadata: PlanMetadata = {
				tasks: ["new-task-1", "new-task-2"],
				status: "implementing",
			};

			const success = updatePlanMetadata(planPath, metadata);

			expect(success).toBe(true);

			const updated = parsePlanFile(planPath);
			expect(updated?.metadata?.tasks).toEqual(["new-task-1", "new-task-2"]);
			expect(updated?.metadata?.status).toBe("implementing");
		});

		it("returns false for non-existent file", () => {
			const success = updatePlanMetadata(join(plansDir, "nonexistent.md"), {
				tasks: [],
			});
			expect(success).toBe(false);
		});
	});

	describe("linkTasksToPlan", () => {
		it("links tasks to plan without existing metadata", () => {
			const planPath = join(plansDir, "link-new.md");
			writeFileSync(planPath, "# New Plan\n\nContent.\n");

			const success = linkTasksToPlan(planPath, ["task-1", "task-2"], "/my/project");

			expect(success).toBe(true);

			const plan = parsePlanFile(planPath);
			expect(plan?.metadata?.tasks).toContain("task-1");
			expect(plan?.metadata?.tasks).toContain("task-2");
			expect(plan?.metadata?.project).toBe("/my/project");
			expect(plan?.metadata?.status).toBe("implementing");
		});

		it("adds tasks to existing task list", () => {
			const planPath = join(plansDir, "link-existing.md");
			writeFileSync(
				planPath,
				`---
undercity:
  tasks: ["existing-task"]
  project: /project
  linkedAt: 2026-01-01T00:00:00.000Z
  status: implementing
---

# Plan
`,
			);

			linkTasksToPlan(planPath, ["new-task"], "/project");

			const plan = parsePlanFile(planPath);
			expect(plan?.metadata?.tasks).toContain("existing-task");
			expect(plan?.metadata?.tasks).toContain("new-task");
			// Should preserve original linkedAt
			expect(plan?.metadata?.linkedAt).toBe("2026-01-01T00:00:00.000Z");
		});

		it("deduplicates task IDs", () => {
			const planPath = join(plansDir, "link-dedup.md");
			writeFileSync(
				planPath,
				`---
undercity:
  tasks: ["task-a"]
---

# Plan
`,
			);

			linkTasksToPlan(planPath, ["task-a", "task-b", "task-a"], "/project");

			const plan = parsePlanFile(planPath);
			const taskCount = plan?.metadata?.tasks.filter((t) => t === "task-a").length;
			expect(taskCount).toBe(1);
		});

		it("returns false for non-existent plan", () => {
			const success = linkTasksToPlan(join(plansDir, "nonexistent.md"), ["task-1"], "/project");
			expect(success).toBe(false);
		});
	});

	describe("unlinkTasksFromPlan", () => {
		it("removes specified tasks", () => {
			const planPath = join(plansDir, "unlink.md");
			writeFileSync(
				planPath,
				`---
undercity:
  tasks: ["task-1", "task-2", "task-3"]
  status: implementing
---

# Plan
`,
			);

			const success = unlinkTasksFromPlan(planPath, ["task-2"]);

			expect(success).toBe(true);

			const plan = parsePlanFile(planPath);
			expect(plan?.metadata?.tasks).toEqual(["task-1", "task-3"]);
		});

		it("handles removing non-existent task gracefully", () => {
			const planPath = join(plansDir, "unlink-missing.md");
			writeFileSync(
				planPath,
				`---
undercity:
  tasks: ["task-1"]
---

# Plan
`,
			);

			const success = unlinkTasksFromPlan(planPath, ["nonexistent-task"]);

			expect(success).toBe(true);

			const plan = parsePlanFile(planPath);
			expect(plan?.metadata?.tasks).toEqual(["task-1"]);
		});

		it("returns false for plan without metadata", () => {
			const planPath = join(plansDir, "no-meta.md");
			writeFileSync(planPath, "# Plan\n");

			const success = unlinkTasksFromPlan(planPath, ["task-1"]);

			expect(success).toBe(false);
		});
	});

	describe("findLinkedPlans", () => {
		it("finds plans linked to project", () => {
			// Create plans for different projects
			writeFileSync(
				join(plansDir, "proj1-plan.md"),
				`---
undercity:
  tasks: ["t1"]
  project: /project/one
---

# Project One Plan
`,
			);

			writeFileSync(
				join(plansDir, "proj2-plan.md"),
				`---
undercity:
  tasks: ["t2"]
  project: /project/two
---

# Project Two Plan
`,
			);

			const plans = findLinkedPlans("/project/one", plansDir);

			expect(plans).toHaveLength(1);
			expect(plans[0].title).toBe("Project One Plan");
		});

		it("returns empty array when no plans match", () => {
			writeFileSync(
				join(plansDir, "other.md"),
				`---
undercity:
  tasks: []
  project: /other/project
---

# Other
`,
			);

			const plans = findLinkedPlans("/my/project", plansDir);

			expect(plans).toEqual([]);
		});

		it("returns empty array for non-existent directory", () => {
			const plans = findLinkedPlans("/project", "/nonexistent/dir");
			expect(plans).toEqual([]);
		});

		it("ignores non-markdown files", () => {
			writeFileSync(join(plansDir, "notes.txt"), "Not a plan");
			writeFileSync(
				join(plansDir, "plan.md"),
				`---
undercity:
  tasks: []
  project: /project
---

# Plan
`,
			);

			const plans = findLinkedPlans("/project", plansDir);

			expect(plans).toHaveLength(1);
		});
	});

	describe("findPlanForTask", () => {
		it("finds plan containing task", () => {
			writeFileSync(
				join(plansDir, "has-task.md"),
				`---
undercity:
  tasks: ["task-abc", "task-def"]
---

# Plan With Task
`,
			);

			writeFileSync(
				join(plansDir, "no-task.md"),
				`---
undercity:
  tasks: ["task-xyz"]
---

# Other Plan
`,
			);

			const plan = findPlanForTask("task-def", plansDir);

			expect(plan).not.toBeNull();
			expect(plan?.title).toBe("Plan With Task");
		});

		it("returns null when task not found", () => {
			writeFileSync(
				join(plansDir, "plan.md"),
				`---
undercity:
  tasks: ["task-1"]
---

# Plan
`,
			);

			const plan = findPlanForTask("nonexistent-task", plansDir);

			expect(plan).toBeNull();
		});

		it("returns null for non-existent directory", () => {
			const plan = findPlanForTask("task-1", "/nonexistent/dir");
			expect(plan).toBeNull();
		});
	});

	describe("listPlans", () => {
		beforeEach(() => {
			// Set up test plans
			writeFileSync(
				join(plansDir, "draft.md"),
				`---
undercity:
  tasks: []
  project: /project/a
  status: draft
---

# Draft Plan
`,
			);

			writeFileSync(
				join(plansDir, "implementing.md"),
				`---
undercity:
  tasks: ["t1"]
  project: /project/b
  status: implementing
---

# Implementing Plan
`,
			);

			writeFileSync(join(plansDir, "no-meta.md"), "# Plan Without Metadata\n");
		});

		it("lists all plans without filter", () => {
			const plans = listPlans(plansDir);
			expect(plans).toHaveLength(3);
		});

		it("filters by project", () => {
			const plans = listPlans(plansDir, { project: "/project/a" });
			expect(plans).toHaveLength(1);
			expect(plans[0].title).toBe("Draft Plan");
		});

		it("filters by hasUndercityMetadata", () => {
			const plans = listPlans(plansDir, { hasUndercityMetadata: true });
			expect(plans).toHaveLength(2);
		});

		it("filters by status", () => {
			const plans = listPlans(plansDir, { status: "implementing" });
			expect(plans).toHaveLength(1);
			expect(plans[0].title).toBe("Implementing Plan");
		});

		it("combines multiple filters", () => {
			const plans = listPlans(plansDir, {
				hasUndercityMetadata: true,
				status: "draft",
			});
			expect(plans).toHaveLength(1);
			expect(plans[0].title).toBe("Draft Plan");
		});

		it("returns empty for non-existent directory", () => {
			const plans = listPlans("/nonexistent/dir");
			expect(plans).toEqual([]);
		});
	});

	describe("markPlanComplete", () => {
		it("updates status to complete", () => {
			const planPath = join(plansDir, "complete-me.md");
			writeFileSync(
				planPath,
				`---
undercity:
  tasks: ["t1", "t2"]
  status: implementing
---

# Plan
`,
			);

			const success = markPlanComplete(planPath);

			expect(success).toBe(true);

			const plan = parsePlanFile(planPath);
			expect(plan?.metadata?.status).toBe("complete");
			// Should preserve tasks
			expect(plan?.metadata?.tasks).toEqual(["t1", "t2"]);
		});

		it("returns false for plan without metadata", () => {
			const planPath = join(plansDir, "no-meta.md");
			writeFileSync(planPath, "# No Metadata\n");

			const success = markPlanComplete(planPath);

			expect(success).toBe(false);
		});

		it("returns false for non-existent plan", () => {
			const success = markPlanComplete(join(plansDir, "nonexistent.md"));
			expect(success).toBe(false);
		});
	});

	describe("resolvePlanPath", () => {
		it("returns absolute path unchanged", () => {
			const result = resolvePlanPath("/absolute/path/to/plan.md", plansDir);
			expect(result).toBe("/absolute/path/to/plan.md");
		});

		it("resolves relative path with directory separators from cwd", () => {
			const result = resolvePlanPath("./subdir/plan.md", plansDir);
			expect(result).toContain("subdir/plan.md");
		});

		it("treats simple name as plan in default directory", () => {
			const result = resolvePlanPath("my-plan", plansDir);
			expect(result).toBe(join(plansDir, "my-plan.md"));
		});

		it("does not double .md extension", () => {
			const result = resolvePlanPath("my-plan.md", plansDir);
			expect(result).toBe(join(plansDir, "my-plan.md"));
			expect(result).not.toContain(".md.md");
		});
	});

	describe("frontmatter edge cases", () => {
		it("handles tasks with single quotes", () => {
			const planPath = join(plansDir, "single-quotes.md");
			writeFileSync(
				planPath,
				`---
undercity:
  tasks: ['task-1', 'task-2']
---

# Plan
`,
			);

			const plan = parsePlanFile(planPath);
			expect(plan?.metadata?.tasks).toEqual(["task-1", "task-2"]);
		});

		it("handles tasks without quotes", () => {
			const planPath = join(plansDir, "no-quotes.md");
			writeFileSync(
				planPath,
				`---
undercity:
  tasks: [task-1, task-2]
---

# Plan
`,
			);

			const plan = parsePlanFile(planPath);
			expect(plan?.metadata?.tasks).toEqual(["task-1", "task-2"]);
		});

		it("handles whitespace in tasks array", () => {
			const planPath = join(plansDir, "whitespace.md");
			writeFileSync(
				planPath,
				`---
undercity:
  tasks: [  "task-1"  ,  "task-2"  ]
---

# Plan
`,
			);

			const plan = parsePlanFile(planPath);
			expect(plan?.metadata?.tasks).toEqual(["task-1", "task-2"]);
		});
	});
});
