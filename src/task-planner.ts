/**
 * Task Planner Module
 *
 * Two planning modes:
 *
 * 1. [plan] prefix tasks - Generate subtasks from high-level objectives
 *    - Detect [plan] prefix in task objective
 *    - Run planning agent with codebase access
 *    - Agent explores files, identifies targets
 *    - Returns specific implementation tasks with file paths
 *    - Tasks added to board, plan marked complete
 *
 * 2. Pre-execution planning - Tiered planning before task execution
 *    - Haiku creates initial plan (cheap exploration)
 *    - Sonnet/opus reviews and validates the plan (quality gate)
 *    - Execution proceeds with validated, concrete plan
 *    - Principle: "having the next bigger model review outputs leads to good outcomes"
 *
 * Related modules (different concerns):
 * - task-analyzer.ts: Static analysis of task objectives
 * - task-scheduler.ts: Finding compatible parallel task sets
 * - task-board-analyzer.ts: Board-level insights and recommendations
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { sessionLogger } from "./logger.js";
import { MODEL_NAMES, type ModelTier } from "./types.js";

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

// =============================================================================
// Pre-Execution Planning (Tiered Review)
// =============================================================================

/**
 * A structured execution plan created before task execution
 */
export interface ExecutionPlan {
	/** Clear restatement of the task */
	objective: string;
	/** Files to read for context */
	filesToRead: string[];
	/** Files to modify */
	filesToModify: string[];
	/** Files to create (if any) */
	filesToCreate: string[];
	/** Step-by-step approach */
	steps: string[];
	/** Risks or edge cases */
	risks: string[];
	/** What success looks like */
	expectedOutcome: string;
	/** If task appears already complete */
	alreadyComplete?: { likely: boolean; reason?: string };
	/** If task needs decomposition */
	needsDecomposition?: { needed: boolean; suggestedSubtasks?: string[] };
}

/**
 * Result of plan review by higher-tier model
 */
export interface PlanReview {
	/** Whether plan is approved for execution */
	approved: boolean;
	/** Issues found */
	issues: string[];
	/** Suggested improvements */
	suggestions: string[];
	/** Revised plan if needed */
	revisedPlan?: Partial<ExecutionPlan>;
	/** Should skip execution entirely */
	skipExecution?: { skip: boolean; reason?: string };
}

/**
 * Combined result of tiered planning
 */
export interface TieredPlanResult {
	/** Whether planning succeeded */
	success: boolean;
	/** The validated plan */
	plan: ExecutionPlan;
	/** Review from higher-tier model */
	review: PlanReview;
	/** Model that created the plan */
	plannerModel: ModelTier;
	/** Model that reviewed the plan */
	reviewerModel: ModelTier;
	/** Whether to proceed with execution */
	proceedWithExecution: boolean;
	/** Reason if not proceeding */
	skipReason?: string;
	/** Number of plan-review iterations (1 = no revisions needed) */
	iterations?: number;
}

/**
 * Get the reviewer model (one tier up)
 */
function getReviewerTier(plannerTier: ModelTier): ModelTier {
	switch (plannerTier) {
		case "haiku":
			return "sonnet";
		case "sonnet":
			return "opus";
		case "opus":
			return "opus";
	}
}

/** Maximum iterations for plan revision (create + N revisions) */
const MAX_PLAN_ITERATIONS = 3;

/**
 * Create an execution plan using the specified model
 */
async function createExecutionPlan(task: string, model: ModelTier, cwd: string): Promise<ExecutionPlan> {
	const prompt = `You are a planning assistant. Analyze this task and create a detailed execution plan.

TASK: ${task}

Create a plan by exploring the codebase. Output your plan in this exact JSON format:

\`\`\`json
{
  "objective": "clear restatement of the task",
  "filesToRead": ["files to read for context"],
  "filesToModify": ["files that will be changed"],
  "filesToCreate": ["new files to create, if any"],
  "steps": ["step 1", "step 2", ...],
  "risks": ["potential issues to watch for"],
  "expectedOutcome": "what success looks like",
  "alreadyComplete": {"likely": false, "reason": "if already done, explain"},
  "needsDecomposition": {"needed": false, "suggestedSubtasks": ["if too big, list subtasks"]}
}
\`\`\`

RULES:
1. Explore the codebase to understand existing patterns
2. Check if the task is already complete (read relevant files)
3. If the task is too vague or large, mark needsDecomposition as true
4. Be specific about which files and what changes
5. List concrete steps, not vague directions
6. Check that referenced files actually exist`;

	logger.debug({ task: task.substring(0, 50), model }, "Creating execution plan");

	let planJson = "";

	for await (const message of query({
		prompt,
		options: {
			model: MODEL_NAMES[model],
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			maxTurns: 10,
			cwd,
		},
	})) {
		if (message.type === "result" && message.subtype === "success") {
			planJson = message.result;
		}
	}

	// Extract JSON from response
	const jsonMatch = planJson.match(/```json\s*([\s\S]*?)\s*```/);
	if (jsonMatch) {
		try {
			return JSON.parse(jsonMatch[1]) as ExecutionPlan;
		} catch (e) {
			logger.warn({ error: String(e) }, "Failed to parse plan JSON");
		}
	}

	// Fallback: try to parse the whole response as JSON
	try {
		return JSON.parse(planJson) as ExecutionPlan;
	} catch {
		// Return minimal plan if parsing fails
		return {
			objective: task,
			filesToRead: [],
			filesToModify: [],
			filesToCreate: [],
			steps: ["Execute the task as described"],
			risks: ["Plan parsing failed - proceeding with minimal plan"],
			expectedOutcome: "Task completion",
		};
	}
}

/**
 * Revise a plan based on review feedback
 *
 * The planner model receives the original plan and reviewer feedback,
 * then creates an improved version addressing the issues raised.
 */
async function revisePlan(
	task: string,
	currentPlan: ExecutionPlan,
	feedback: PlanReview,
	model: ModelTier,
	cwd: string,
): Promise<ExecutionPlan> {
	const issuesText = feedback.issues.length > 0 ? feedback.issues.join("\n- ") : "None specified";
	const suggestionsText = feedback.suggestions.length > 0 ? feedback.suggestions.join("\n- ") : "None specified";

	const prompt = `You are a planning assistant. Your previous plan was reviewed and needs revision.

TASK: ${task}

YOUR PREVIOUS PLAN:
${JSON.stringify(currentPlan, null, 2)}

REVIEWER FEEDBACK:
Issues found:
- ${issuesText}

Suggestions:
- ${suggestionsText}

Please revise your plan to address this feedback. Explore the codebase again if needed to verify files exist and understand the correct approach.

Output your REVISED plan in this exact JSON format:

\`\`\`json
{
  "objective": "clear restatement of the task",
  "filesToRead": ["files to read for context"],
  "filesToModify": ["files that will be changed"],
  "filesToCreate": ["new files to create, if any"],
  "steps": ["step 1", "step 2", ...],
  "risks": ["potential issues to watch for"],
  "expectedOutcome": "what success looks like",
  "alreadyComplete": {"likely": false, "reason": "if already done, explain"},
  "needsDecomposition": {"needed": false, "suggestedSubtasks": ["if too big, list subtasks"]}
}
\`\`\`

Address ALL issues raised by the reviewer. If a file doesn't exist, either remove it or change the approach.`;

	logger.debug({ task: task.substring(0, 50), model, iteration: "revision" }, "Revising execution plan");

	let planJson = "";

	for await (const message of query({
		prompt,
		options: {
			model: MODEL_NAMES[model],
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			maxTurns: 10,
			cwd,
		},
	})) {
		if (message.type === "result" && message.subtype === "success") {
			planJson = message.result;
		}
	}

	// Extract JSON from response
	const jsonMatch = planJson.match(/```json\s*([\s\S]*?)\s*```/);
	if (jsonMatch) {
		try {
			return JSON.parse(jsonMatch[1]) as ExecutionPlan;
		} catch (e) {
			logger.warn({ error: String(e) }, "Failed to parse revised plan JSON");
		}
	}

	// Fallback: try to parse the whole response as JSON
	try {
		return JSON.parse(planJson) as ExecutionPlan;
	} catch {
		// Return original plan if revision parsing fails
		logger.warn("Revision failed to parse, keeping original plan");
		return currentPlan;
	}
}

/**
 * Review a plan using a higher-tier model
 */
async function reviewExecutionPlan(
	task: string,
	plan: ExecutionPlan,
	model: ModelTier,
	cwd: string,
): Promise<PlanReview> {
	const prompt = `You are a senior code reviewer. Review this execution plan for quality and completeness.

ORIGINAL TASK: ${task}

PROPOSED PLAN:
${JSON.stringify(plan, null, 2)}

Review the plan and output your assessment in this exact JSON format:

\`\`\`json
{
  "approved": true,
  "issues": ["list any problems with the plan"],
  "suggestions": ["improvements to consider"],
  "revisedPlan": null,
  "skipExecution": {"skip": false, "reason": "if should skip, explain why"}
}
\`\`\`

REVIEW CRITERIA:
1. Do the files to modify actually exist? (for modify tasks)
2. Are the steps specific and actionable?
3. Is the scope appropriate (not too big, not too trivial)?
4. Are there missing edge cases or considerations?
5. Should this task be skipped (already done, invalid target, duplicate)?

If the plan has major issues, set approved=false and provide a revisedPlan.
If the task should be skipped entirely, set skipExecution.skip=true with reason.
Verify file existence by checking the filesystem.`;

	logger.debug({ task: task.substring(0, 50), model }, "Reviewing execution plan");

	let reviewJson = "";

	for await (const message of query({
		prompt,
		options: {
			model: MODEL_NAMES[model],
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			maxTurns: 5,
			cwd,
		},
	})) {
		if (message.type === "result" && message.subtype === "success") {
			reviewJson = message.result;
		}
	}

	// Extract JSON from response
	const jsonMatch = reviewJson.match(/```json\s*([\s\S]*?)\s*```/);
	if (jsonMatch) {
		try {
			return JSON.parse(jsonMatch[1]) as PlanReview;
		} catch (e) {
			logger.warn({ error: String(e) }, "Failed to parse review JSON");
		}
	}

	// Fallback
	try {
		return JSON.parse(reviewJson) as PlanReview;
	} catch {
		// Don't block on review parse failure
		return {
			approved: true,
			issues: ["Review parsing failed - approving by default"],
			suggestions: [],
		};
	}
}

/**
 * Run tiered planning: cheaper model creates plan, expensive model reviews
 *
 * Iterates on feedback: if reviewer has issues, planner revises and resubmits.
 * Similar to code review - iterate until approved or max iterations reached.
 *
 * @param task - The task objective
 * @param cwd - Working directory for exploration
 * @param plannerModel - Model for planning (default: haiku)
 * @returns Tiered planning result with validated plan
 */
export async function planTaskWithReview(
	task: string,
	cwd: string,
	plannerModel: ModelTier = "haiku",
): Promise<TieredPlanResult> {
	const reviewerModel = getReviewerTier(plannerModel);

	logger.info(
		{
			task: task.substring(0, 100),
			plannerModel,
			reviewerModel,
			maxIterations: MAX_PLAN_ITERATIONS,
		},
		"Starting tiered planning phase",
	);

	// Phase 1: Create initial plan with cheaper model
	let currentPlan = await createExecutionPlan(task, plannerModel, cwd);

	// Early exit: already complete
	if (currentPlan.alreadyComplete?.likely) {
		return {
			success: true,
			plan: currentPlan,
			review: {
				approved: true,
				issues: [],
				suggestions: [],
				skipExecution: { skip: true, reason: currentPlan.alreadyComplete.reason },
			},
			plannerModel,
			reviewerModel,
			proceedWithExecution: false,
			skipReason: `Task already complete: ${currentPlan.alreadyComplete.reason}`,
		};
	}

	// Early exit: needs decomposition
	if (currentPlan.needsDecomposition?.needed) {
		return {
			success: true,
			plan: currentPlan,
			review: {
				approved: false,
				issues: ["Task requires decomposition"],
				suggestions: currentPlan.needsDecomposition.suggestedSubtasks || [],
			},
			plannerModel,
			reviewerModel,
			proceedWithExecution: false,
			skipReason: "Task needs decomposition into smaller subtasks",
		};
	}

	// Phase 2: Review loop - iterate until approved or max iterations
	let review: PlanReview;
	let iteration = 0;

	while (iteration < MAX_PLAN_ITERATIONS) {
		iteration++;

		logger.info(
			{
				task: task.substring(0, 50),
				iteration,
				maxIterations: MAX_PLAN_ITERATIONS,
			},
			"Plan review iteration",
		);

		// Get review from higher-tier model
		review = await reviewExecutionPlan(task, currentPlan, reviewerModel, cwd);

		// If approved or should skip, we're done
		if (review.approved || review.skipExecution?.skip) {
			break;
		}

		// Not approved - check if we have feedback to act on
		const hasFeedback = review.issues.length > 0 || review.suggestions.length > 0;

		if (!hasFeedback) {
			// Rejected without feedback - can't improve, exit loop
			logger.warn({ iteration }, "Plan rejected without actionable feedback");
			break;
		}

		// Check if this is the last iteration
		if (iteration >= MAX_PLAN_ITERATIONS) {
			logger.info({ iteration }, "Max plan iterations reached, using current plan");
			break;
		}

		// Revise plan based on feedback
		logger.info(
			{
				iteration,
				issues: review.issues.length,
				suggestions: review.suggestions.length,
			},
			"Revising plan based on feedback",
		);

		currentPlan = await revisePlan(task, currentPlan, review, plannerModel, cwd);

		// Check if revision triggered decomposition
		if (currentPlan.needsDecomposition?.needed) {
			return {
				success: true,
				plan: currentPlan,
				review: {
					approved: false,
					issues: ["Task requires decomposition after revision"],
					suggestions: currentPlan.needsDecomposition.suggestedSubtasks || [],
				},
				plannerModel,
				reviewerModel,
				proceedWithExecution: false,
				skipReason: "Task needs decomposition into smaller subtasks",
			};
		}
	}

	// Apply any direct revisions from reviewer
	const finalPlan: ExecutionPlan = review!.revisedPlan ? { ...currentPlan, ...review!.revisedPlan } : currentPlan;

	const shouldSkip = review!.skipExecution?.skip || false;
	const proceedWithExecution = review!.approved && !shouldSkip;

	logger.info(
		{
			task: task.substring(0, 50),
			approved: review!.approved,
			proceedWithExecution,
			iterations: iteration,
			skipReason: review!.skipExecution?.reason,
		},
		"Tiered planning complete",
	);

	return {
		success: true,
		plan: finalPlan,
		review: review!,
		plannerModel,
		reviewerModel,
		proceedWithExecution,
		skipReason: shouldSkip ? review!.skipExecution?.reason : undefined,
		iterations: iteration,
	};
}

/**
 * Format an execution plan as context for the execution agent
 */
export function formatExecutionPlanAsContext(plan: ExecutionPlan): string {
	return `## EXECUTION PLAN (Reviewed and Approved)

**Objective:** ${plan.objective}

**Files to read for context:**
${plan.filesToRead.map((f) => `- ${f}`).join("\n") || "- (none identified)"}

**Files to modify:**
${plan.filesToModify.map((f) => `- ${f}`).join("\n") || "- (none identified)"}

**Files to create:**
${plan.filesToCreate.map((f) => `- ${f}`).join("\n") || "- (none)"}

**Steps:**
${plan.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

**Risks to watch for:**
${plan.risks.map((r) => `- ${r}`).join("\n") || "- (none identified)"}

**Expected outcome:** ${plan.expectedOutcome}

Follow this plan. The plan has been reviewed and validated.`;
}
