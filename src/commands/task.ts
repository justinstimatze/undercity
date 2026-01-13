/**
 * Task-related commands
 *
 * | Command      | Purpose                                      |
 * |--------------|----------------------------------------------|
 * | tasks        | Show/filter task board                       |
 * | add          | Add goal to backlog                          |
 * | complete     | Mark task as complete                        |
 * | update       | Update task objective, priority, tags, status|
 * | load         | Bulk load goals from file                    |
 * | import-plan  | Parse plan file into discrete tasks          |
 * | plan         | Execute plan file with judgment              |
 * | work         | Process backlog continuously                 |
 * | task-analyze | Parallelization opportunities                |
 * | reconcile    | Sync completed tasks with git history        |
 * | triage       | Analyze board health                         |
 * | prune        | Remove stale/test/duplicate tasks            |
 *
 * Handlers: task-handlers.ts (extracted for maintainability)
 */

import {
	type AddOptions,
	type CompleteOptions,
	handleAdd,
	handleComplete,
	handleImportPlan,
	handleLoad,
	handlePlan,
	handlePrune,
	handleReconcile,
	handleTaskAnalyze,
	handleTaskStatus,
	handleTasks,
	handleTriage,
	handleUpdate,
	handleWork,
	type ImportPlanOptions,
	type PlanOptions,
	type PruneOptions,
	type ReconcileOptions,
	type TaskAnalyzeOptions,
	type TasksOptions,
	type TriageOptions,
	type UpdateOptions,
	type WorkOptions,
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
			.option("-a, --all", "Show all tasks (not just first 10)")
			.option("-c, --count <n>", "Number of tasks to show (default: 10)")
			.action((options: TasksOptions) => handleTasks(options));

		// Add command - add a goal to the backlog
		program
			.command("add <goal>")
			.description("Add a goal to the backlog")
			.option("-p, --priority <number>", "Task priority (lower = higher priority)")
			.option("-c, --context <file>", "JSON file with handoff context for worker")
			.option("--files-read <files>", "Comma-separated list of files already analyzed")
			.option("--notes <notes>", "Notes to pass to the worker")
			.action((goal: string, options: AddOptions) => handleAdd(goal, options));

		// Load command - load goals from a file (one per line)
		program
			.command("load <file>")
			.description("Load goals from a file (one per line)")
			.action((file: string) => handleLoad(file));

		// Import-plan command - parse plan files into discrete tasks
		program
			.command("import-plan <file>")
			.description("Import a plan file as discrete tasks (extracts steps from markdown plans)")
			.option("--dry-run", "Show what would be imported without adding to task board")
			.option("--by-priority", "Sort steps by section priority (default: by file order)")
			.action((file: string, options: ImportPlanOptions) => handleImportPlan(file, options));

		// Plan command - execute a plan file intelligently
		program
			.command("plan <file>")
			.description("Execute a plan file with good judgment (uses logistics to determine next steps)")
			.option("-s, --stream", "Stream agent activity")
			.option("-c, --continuous", "Keep executing until plan is complete")
			.option("-n, --steps <n>", "Max steps to execute (default: unlimited in continuous mode)")
			.option("--legacy", "Use legacy mode (re-read whole plan each iteration)")
			.action((file: string, options: PlanOptions) => handlePlan(file, options));

		// Work command - process the backlog continuously
		program
			.command("work")
			.description("Process the backlog continuously (run in separate terminal)")
			.option("-n, --count <n>", "Process only N goals then stop", "0")
			.option("-s, --stream", "Stream agent activity")
			.action((options: WorkOptions) => handleWork(options));

		// Task analyze command - analyze task board for parallelization opportunities
		program
			.command("task-analyze")
			.description("Analyze task board for parallelization opportunities")
			.option("--compatibility", "Show compatibility matrix")
			.option("--suggestions", "Show optimization suggestions")
			.action((options: TaskAnalyzeOptions) => handleTaskAnalyze(options));

		// Task status command - show detailed task board status
		program
			.command("task-status")
			.description("Show detailed task board status and analytics")
			.action(() => handleTaskStatus());

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
	},
};
