/**
 * Task-related commands
 *
 * | Command      | Purpose                                      |
 * |--------------|----------------------------------------------|
 * | tasks        | Show/filter task board                       |
 * | add          | Add goal to backlog                          |
 * | complete     | Mark task as complete                        |
 * | update       | Update task objective, priority, tags, status|
 * | remove       | Permanently delete a task                    |
 * | load         | Bulk load goals from file                    |
 * | dispatch     | Import plan + grind (one-command handoff)    |
 * | plans        | Manage plan-task linkage (frontmatter)       |
 * | reconcile    | Sync completed tasks with git history        |
 * | triage       | Analyze board health                         |
 * | prune        | Remove stale/test/duplicate tasks            |
 * | maintain     | Autonomous triage → prune → refine cycle     |
 * | refine       | Enrich tasks with rich ticket content        |
 *
 * Handlers: task-handlers.ts (extracted for maintainability)
 */

import { handlePlan as handlePlanLinkage, type PlanOptions as PlanLinkageOptions } from "./plan-handlers.js";
import {
	type AddOptions,
	type CompleteOptions,
	type DispatchOptions,
	handleAdd,
	handleComplete,
	handleDispatch,
	handleLoad,
	handleMaintain,
	handlePrune,
	handleReconcile,
	handleRefine,
	handleRemove,
	handleTasks,
	handleTriage,
	handleUpdate,
	type MaintainOptions,
	type PruneOptions,
	type ReconcileOptions,
	type RefineOptions,
	type TasksOptions,
	type TriageOptions,
	type UpdateOptions,
} from "./task-handlers.js";
import type { CommandModule } from "./types.js";

export const taskCommands: CommandModule = {
	register(program) {
		// Backlog command - show/manage the goal queue
		program
			.command("tasks")
			.description("Show the task board")
			.option("-s, --status <status>", "Filter by status: pending, in_progress, complete, failed")
			.option("-t, --tag <tag>", "Filter by tag")
			.option("-i, --issues", "Show only tasks with triage issues")
			.option("--issue-type <type>", "Filter by triage issue type (e.g., status_bug, duplicate)")
			.option("-a, --all", "Show all tasks (not just first 10)")
			.option("-c, --count <n>", "Number of tasks to show (default: 10)")
			.action((options: TasksOptions) => handleTasks(options));

		// Add command - add a goal to the backlog
		program
			.command("add <goal>")
			.description("Add a goal to the backlog")
			.option("-p, --priority <number>", "Task priority (lower = higher priority)")
			.option("-c, --context <file>", "JSON file with handoff context for worker")
			.option("-f, --from-file <file>", "YAML/JSON file with full ticket definition")
			.option("--files-read <files>", "Comma-separated list of files already analyzed")
			.option("--notes <notes>", "Notes to pass to the worker")
			.option("--depends-on <taskIds>", "Comma-separated task IDs this task depends on")
			.option("--skip-intent-completion", "Skip intent completion for ambiguous objectives")
			.action(async (goal: string, options: AddOptions) => handleAdd(goal, options));

		// Load command - load goals from a file (one per line)
		program
			.command("load <file>")
			.description("Load goals from a file (one per line)")
			.action((file: string) => handleLoad(file));

		// Dispatch command - import plan and immediately start grind (single-command handoff)
		program
			.command("dispatch <file>")
			.description("Import a plan and immediately start grind (one-command handoff)")
			.option("--parallel <n>", "Number of parallel workers", "3")
			.option("-n, --count <n>", "Max tasks to process (0 = all)", "0")
			.option("--dry-run", "Show what would be dispatched without executing")
			.action((file: string, options: DispatchOptions) => handleDispatch(file, options));

		// Reconcile command - detect duplicate tasks from git history
		program
			.command("reconcile")
			.description("Detect and mark tasks that are already completed in git history")
			.option("--dry-run", "Show what would be marked without making changes")
			.option("--lookback <number>", "Number of commits to search (default: 100)", "100")
			.action((options: ReconcileOptions) => handleReconcile(options));

		// Triage command - analyze task board health
		program
			.command("triage")
			.description("Analyze task board health (find duplicates, test cruft, status bugs)")
			.option("--json", "Output as JSON for automation")
			.action((options: TriageOptions) => handleTriage(options));

		// Prune command - remove stale/test/duplicate tasks
		program
			.command("prune")
			.description("Remove test cruft and fix status bugs (use triage to preview)")
			.option("--dry-run", "Show what would be removed without making changes")
			.option("--force", "Remove without confirmation")
			.action((options: PruneOptions) => handlePrune(options));

		// Maintain command - autonomous board maintenance (triage → prune → refine)
		program
			.command("maintain")
			.description("Autonomous board maintenance: triage → prune → refine until healthy")
			.option("--dry-run", "Preview what would be done without making changes")
			.option("--target-coverage <percent>", "Target ticket coverage percentage (default: 80)")
			.option("--max-refinements <n>", "Maximum tasks to refine per run (default: 50)")
			.option("--skip-prune", "Skip the prune phase")
			.option("--skip-refine", "Skip the refine phase")
			.action((options: MaintainOptions) => handleMaintain(options));

		// Refine command - enrich tasks with ticket content
		program
			.command("refine [taskId]")
			.description("Enrich tasks with rich ticket content (description, acceptance criteria, test plan)")
			.option("-n, --count <number>", "Maximum number of tasks to refine", "10")
			.option("--dry-run", "Preview refinements without saving")
			.option("--all", "Refine all tasks lacking tickets (ignores --count)")
			.option("--force", "Re-refine tasks even if they have ticket content")
			.action((taskId: string | undefined, options: RefineOptions) => handleRefine(taskId, options));

		// Complete command - mark a task as complete
		program
			.command("complete <taskId>")
			.description("Mark a task as complete")
			.option("-r, --resolution <text>", "Resolution notes describing how the task was completed")
			.option("--reason <text>", "Reason for completion (alias for --resolution)")
			.action((taskId: string, options: CompleteOptions) => handleComplete(taskId, options));

		// Update command - update task fields
		program
			.command("update <taskId>")
			.description("Update task objective, priority, tags, or status")
			.option("-o, --objective <text>", "New objective text")
			.option("-p, --priority <number>", "New priority (1-1000, lower = higher priority)")
			.option("-t, --tags <tags>", "Comma-separated tags (e.g., feature,urgent)")
			.option(
				"-s, --status <status>",
				"New status (pending, in_progress, complete, failed, blocked, canceled, obsolete)",
			)
			.action((taskId: string, options: UpdateOptions) => handleUpdate(taskId, options));

		// Remove command - permanently delete a task
		program
			.command("remove <taskId>")
			.description("Permanently remove a task from the board")
			.action((taskId: string) => handleRemove(taskId));

		// Plans command - manage plan-task linkage
		program
			.command("plans [plan]")
			.description("Manage plan-task linkage (links Claude Code plans to undercity tasks)")
			.option("--list", "List plans linked to this project")
			.option("--status", "Show plan completion status with task progress")
			.option("--link <taskIds>", "Link comma-separated task IDs to plan")
			.option("--unlink <taskIds>", "Unlink comma-separated task IDs from plan")
			.option("--complete", "Mark plan as complete")
			.option("--project", "Show all plans in ~/.claude/plans/, not just project-linked")
			.action((plan: string | undefined, options: PlanLinkageOptions) => handlePlanLinkage(plan, options));
	},
};
