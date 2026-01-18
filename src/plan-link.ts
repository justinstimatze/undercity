/**
 * Plan-Task Linkage
 *
 * Manages bidirectional links between Claude Code plan files and undercity tasks.
 * Uses YAML frontmatter in plan files to store task associations.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readdirSync } from "node:fs";

// Default Claude Code plans directory
const DEFAULT_PLANS_DIR = join(homedir(), ".claude", "plans");

/**
 * Frontmatter metadata for undercity linkage
 */
export interface PlanMetadata {
	/** Task IDs linked to this plan */
	tasks: string[];
	/** Project root this plan is associated with */
	project?: string;
	/** When the plan was linked */
	linkedAt?: string;
	/** Plan status */
	status?: "draft" | "approved" | "implementing" | "complete";
}

/**
 * Parsed plan file
 */
export interface ParsedPlan {
	/** Path to the plan file */
	path: string;
	/** Plan filename */
	name: string;
	/** Undercity metadata (if present) */
	metadata?: PlanMetadata;
	/** Plan title (first # heading) */
	title?: string;
	/** Raw content without frontmatter */
	content: string;
	/** Whether file has frontmatter */
	hasFrontmatter: boolean;
}

/**
 * Parse YAML frontmatter from a plan file
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } | null {
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) {
		return null;
	}

	try {
		// Simple YAML parsing for our use case
		const yamlContent = match[1];
		const body = match[2];
		const frontmatter: Record<string, unknown> = {};

		// Parse undercity block
		const undercityMatch = yamlContent.match(/undercity:\n((?: {2}.*\n?)*)/);
		if (undercityMatch) {
			const undercityBlock = undercityMatch[1];
			const undercity: Record<string, unknown> = {};

			// Parse tasks array
			const tasksMatch = undercityBlock.match(/tasks:\s*\[(.*?)\]/);
			if (tasksMatch) {
				undercity.tasks = tasksMatch[1]
					.split(",")
					.map((t) => t.trim().replace(/['"]/g, ""))
					.filter(Boolean);
			}

			// Parse project
			const projectMatch = undercityBlock.match(/project:\s*(.+)/);
			if (projectMatch) {
				undercity.project = projectMatch[1].trim();
			}

			// Parse linkedAt
			const linkedAtMatch = undercityBlock.match(/linkedAt:\s*(.+)/);
			if (linkedAtMatch) {
				undercity.linkedAt = linkedAtMatch[1].trim();
			}

			// Parse status
			const statusMatch = undercityBlock.match(/status:\s*(.+)/);
			if (statusMatch) {
				undercity.status = statusMatch[1].trim();
			}

			frontmatter.undercity = undercity;
		}

		return { frontmatter, body };
	} catch {
		return null;
	}
}

/**
 * Serialize frontmatter back to YAML
 */
function serializeFrontmatter(metadata: PlanMetadata): string {
	const lines: string[] = ["---", "undercity:"];

	if (metadata.tasks.length > 0) {
		const taskList = metadata.tasks.map((t) => `"${t}"`).join(", ");
		lines.push(`  tasks: [${taskList}]`);
	} else {
		lines.push("  tasks: []");
	}

	if (metadata.project) {
		lines.push(`  project: ${metadata.project}`);
	}

	if (metadata.linkedAt) {
		lines.push(`  linkedAt: ${metadata.linkedAt}`);
	}

	if (metadata.status) {
		lines.push(`  status: ${metadata.status}`);
	}

	lines.push("---");
	return lines.join("\n");
}

/**
 * Extract title from plan content
 */
function extractTitle(content: string): string | undefined {
	const match = content.match(/^#\s+(.+)$/m);
	return match ? match[1].trim() : undefined;
}

/**
 * Parse a plan file
 */
export function parsePlanFile(path: string): ParsedPlan | null {
	if (!existsSync(path)) {
		return null;
	}

	try {
		const content = readFileSync(path, "utf-8");
		const parsed = parseFrontmatter(content);

		if (parsed) {
			const undercity = parsed.frontmatter.undercity as Record<string, unknown> | undefined;
			return {
				path,
				name: path.split("/").pop() || path,
				metadata: undercity
					? {
							tasks: (undercity.tasks as string[]) || [],
							project: undercity.project as string | undefined,
							linkedAt: undercity.linkedAt as string | undefined,
							status: undercity.status as PlanMetadata["status"],
						}
					: undefined,
				title: extractTitle(parsed.body),
				content: parsed.body,
				hasFrontmatter: true,
			};
		}

		return {
			path,
			name: path.split("/").pop() || path,
			metadata: undefined,
			title: extractTitle(content),
			content,
			hasFrontmatter: false,
		};
	} catch {
		return null;
	}
}

/**
 * Update plan file with new metadata
 */
export function updatePlanMetadata(path: string, metadata: PlanMetadata): boolean {
	const plan = parsePlanFile(path);
	if (!plan) {
		return false;
	}

	try {
		const frontmatter = serializeFrontmatter(metadata);
		const newContent = `${frontmatter}\n${plan.content}`;
		writeFileSync(path, newContent, "utf-8");
		return true;
	} catch {
		return false;
	}
}

/**
 * Link tasks to a plan file
 */
export function linkTasksToPlan(
	planPath: string,
	taskIds: string[],
	projectRoot: string = process.cwd(),
): boolean {
	const plan = parsePlanFile(planPath);
	if (!plan) {
		return false;
	}

	const existingTasks = plan.metadata?.tasks || [];
	const allTasks = [...new Set([...existingTasks, ...taskIds])];

	const metadata: PlanMetadata = {
		tasks: allTasks,
		project: projectRoot,
		linkedAt: plan.metadata?.linkedAt || new Date().toISOString(),
		status: plan.metadata?.status || "implementing",
	};

	return updatePlanMetadata(planPath, metadata);
}

/**
 * Unlink tasks from a plan file
 */
export function unlinkTasksFromPlan(planPath: string, taskIds: string[]): boolean {
	const plan = parsePlanFile(planPath);
	if (!plan || !plan.metadata) {
		return false;
	}

	const remainingTasks = plan.metadata.tasks.filter((t) => !taskIds.includes(t));

	const metadata: PlanMetadata = {
		...plan.metadata,
		tasks: remainingTasks,
	};

	return updatePlanMetadata(planPath, metadata);
}

/**
 * Find plans linked to this project
 */
export function findLinkedPlans(
	projectRoot: string = process.cwd(),
	plansDir: string = DEFAULT_PLANS_DIR,
): ParsedPlan[] {
	if (!existsSync(plansDir)) {
		return [];
	}

	const plans: ParsedPlan[] = [];
	const files = readdirSync(plansDir).filter((f) => f.endsWith(".md"));

	for (const file of files) {
		const plan = parsePlanFile(join(plansDir, file));
		if (plan?.metadata?.project === projectRoot) {
			plans.push(plan);
		}
	}

	return plans;
}

/**
 * Find plan containing a specific task
 */
export function findPlanForTask(
	taskId: string,
	plansDir: string = DEFAULT_PLANS_DIR,
): ParsedPlan | null {
	if (!existsSync(plansDir)) {
		return null;
	}

	const files = readdirSync(plansDir).filter((f) => f.endsWith(".md"));

	for (const file of files) {
		const plan = parsePlanFile(join(plansDir, file));
		if (plan?.metadata?.tasks.includes(taskId)) {
			return plan;
		}
	}

	return null;
}

/**
 * Get plan status summary
 */
export interface PlanStatusSummary {
	plan: ParsedPlan;
	totalTasks: number;
	completedTasks: number;
	pendingTasks: number;
	failedTasks: number;
	completionPercent: number;
}

/**
 * Get status of a plan with task completion info
 */
export async function getPlanStatus(planPath: string): Promise<PlanStatusSummary | null> {
	const plan = parsePlanFile(planPath);
	if (!plan || !plan.metadata) {
		return null;
	}

	// Dynamic import to avoid circular dependency
	const { getTaskById } = await import("./task.js");

	let completed = 0;
	let pending = 0;
	let failed = 0;

	for (const taskId of plan.metadata.tasks) {
		const task = getTaskById(taskId);
		if (!task) {
			// Task not found, count as pending (might be deleted)
			pending++;
		} else if (task.status === "complete") {
			completed++;
		} else if (task.status === "failed") {
			failed++;
		} else {
			pending++;
		}
	}

	const total = plan.metadata.tasks.length;

	return {
		plan,
		totalTasks: total,
		completedTasks: completed,
		pendingTasks: pending,
		failedTasks: failed,
		completionPercent: total > 0 ? Math.round((completed / total) * 100) : 0,
	};
}

/**
 * List all plans with optional filtering
 */
export function listPlans(
	plansDir: string = DEFAULT_PLANS_DIR,
	filter?: {
		project?: string;
		hasUndercityMetadata?: boolean;
		status?: PlanMetadata["status"];
	},
): ParsedPlan[] {
	if (!existsSync(plansDir)) {
		return [];
	}

	const plans: ParsedPlan[] = [];
	const files = readdirSync(plansDir).filter((f) => f.endsWith(".md"));

	for (const file of files) {
		const plan = parsePlanFile(join(plansDir, file));
		if (!plan) continue;

		// Apply filters
		if (filter?.project && plan.metadata?.project !== filter.project) {
			continue;
		}
		if (filter?.hasUndercityMetadata && !plan.metadata) {
			continue;
		}
		if (filter?.status && plan.metadata?.status !== filter.status) {
			continue;
		}

		plans.push(plan);
	}

	return plans;
}

/**
 * Mark a plan as complete
 */
export function markPlanComplete(planPath: string): boolean {
	const plan = parsePlanFile(planPath);
	if (!plan || !plan.metadata) {
		return false;
	}

	const metadata: PlanMetadata = {
		...plan.metadata,
		status: "complete",
	};

	return updatePlanMetadata(planPath, metadata);
}

/**
 * Resolve plan path (handles relative paths and plan names)
 */
export function resolvePlanPath(pathOrName: string, plansDir: string = DEFAULT_PLANS_DIR): string {
	// If it's an absolute path, use it directly
	if (pathOrName.startsWith("/")) {
		return pathOrName;
	}

	// If it's a relative path with directory separators, resolve from cwd
	if (pathOrName.includes("/")) {
		return resolve(pathOrName);
	}

	// Otherwise, treat as a plan name in the default directory
	const withMd = pathOrName.endsWith(".md") ? pathOrName : `${pathOrName}.md`;
	return join(plansDir, withMd);
}
