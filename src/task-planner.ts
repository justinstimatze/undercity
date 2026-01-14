/**
 * Task Planner Module
 *
 * Handles [plan] prefix tasks by using an AI agent to generate specific subtasks.
 * This is different from task-analyzer/scheduler/board-analyzer which handle
 * parallelization and compatibility - this module expands high-level goals into
 * concrete implementation steps.
 *
 * Flow:
 * 1. Detect [plan] prefix in task objective
 * 2. Run planning agent with codebase access
 * 3. Agent explores files, identifies targets
 * 4. Returns specific implementation tasks with file paths
 * 5. Tasks added to board, plan marked complete
 *
 * Related modules (different concerns):
 * - task-analyzer.ts: Static analysis of task objectives
 * - task-scheduler.ts: Finding compatible parallel task sets
 * - task-board-analyzer.ts: Board-level insights and recommendations
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { sessionLogger } from "./logger.js";
import { MODEL_NAMES } from "./types.js";

const logger = sessionLogger.child({ module: "task-planner" });

/**
 * A specific implementation task generated from planning
 */
export interface PlannedTask {
	/** Specific objective with file paths */
	objective: string;
	/** Target files to modify */
	targetFiles: string[];
	/** Priority (1-1000, higher = more important) */
	priority: number;
	/** Order within the plan (for dependencies) */
	order: number;
}

/**
 * Result of running the planner
 */
export interface PlanResult {
	/** Whether planning succeeded */
	success: boolean;
	/** Original high-level objective */
	originalObjective: string;
	/** Generated implementation tasks */
	tasks: PlannedTask[];
	/** Summary of the plan */
	summary: string;
	/** Any warnings or notes */
	notes: string[];
}

/**
 * Check if a task is a planning task
 */
export function isPlanTask(objective: string): boolean {
	return objective.trim().toLowerCase().startsWith("[plan]");
}

/**
 * Extract the actual objective from a plan task
 */
export function extractPlanObjective(objective: string): string {
	return objective.replace(/^\[plan\]\s*/i, "").trim();
}

/**
 * Run the planning agent to generate specific implementation tasks
 *
 * Uses Sonnet with tool access to explore the codebase
 */
export async function runPlanner(objective: string, workingDirectory: string): Promise<PlanResult> {
	const cleanObjective = extractPlanObjective(objective);

	logger.info({ objective: cleanObjective }, "Starting planning session");

	try {
		let result = "";

		for await (const message of query({
			prompt: `You are a technical planner. Your job is to analyze a high-level objective and create specific, actionable implementation tasks.

## Objective
${cleanObjective}

## Your Task
1. Explore the codebase to understand the current structure
2. Identify which files need to be modified
3. Create specific implementation tasks with exact file paths

## Rules for Generated Tasks
- Each task should modify 1-3 files maximum
- Include exact file paths in the objective (e.g., "In src/foo.ts, add...")
- Be specific about what to add/change (e.g., "add a --priority option that accepts 1-1000")
- Tasks should be independently executable
- Order tasks by dependency (earlier tasks don't depend on later ones)

## Output Format
After exploring, respond with ONLY this JSON (no other text):
{
  "success": true,
  "summary": "Brief description of the plan",
  "tasks": [
    {
      "objective": "In src/file.ts, add function X that does Y",
      "targetFiles": ["src/file.ts"],
      "priority": 900,
      "order": 1
    }
  ],
  "notes": ["any warnings or considerations"]
}

Start by exploring the codebase, then provide your plan.`,
			options: {
				model: MODEL_NAMES.sonnet,
				maxTurns: 15,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				cwd: workingDirectory,
				// Only allow read-only tools for planning
				allowedTools: ["Read", "Glob", "Grep", "Bash(ls *)", "Bash(cat *)", "Bash(head *)", "Bash(find *)"],
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				result = message.result;
			}
		}

		// Parse the JSON response
		const jsonMatch = result.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			logger.warn({ result }, "No JSON found in planner response");
			return {
				success: false,
				originalObjective: cleanObjective,
				tasks: [],
				summary: "Planning failed - no structured output",
				notes: ["Planner did not return valid JSON"],
			};
		}

		const parsed = JSON.parse(jsonMatch[0]);

		// Validate and normalize tasks
		const tasks: PlannedTask[] = (parsed.tasks || []).map((t: Record<string, unknown>, i: number) => ({
			objective: String(t.objective || ""),
			targetFiles: Array.isArray(t.targetFiles) ? t.targetFiles.map(String) : [],
			priority: Number(t.priority) || 800,
			order: Number(t.order) || i + 1,
		}));

		// Filter out empty tasks
		const validTasks = tasks.filter((t) => t.objective.length > 10);

		logger.info(
			{
				taskCount: validTasks.length,
				summary: parsed.summary,
			},
			"Planning complete",
		);

		return {
			success: Boolean(parsed.success) && validTasks.length > 0,
			originalObjective: cleanObjective,
			tasks: validTasks,
			summary: String(parsed.summary || ""),
			notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : [],
		};
	} catch (error) {
		logger.error({ error, objective: cleanObjective }, "Planning failed");
		return {
			success: false,
			originalObjective: cleanObjective,
			tasks: [],
			summary: `Planning failed: ${error}`,
			notes: [],
		};
	}
}
