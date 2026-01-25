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

import { existsSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getASTIndex } from "./ast-index.js";
import { quickDecision } from "./automated-pm.js";
import { type ContextBriefing, prepareContext } from "./context.js";
import { findRelevantLearnings, formatLearningsCompact } from "./knowledge.js";
import { sessionLogger } from "./logger.js";
import { findRelevantFiles } from "./task-file-patterns.js";
import {
	buildAlreadyCompleteResult,
	buildDecompositionResult,
	buildFinalPlanResult,
	buildParseFailureReview,
	parsePlanReview,
	shouldContinueReviewLoop,
	shouldEscalatePlanner,
	validatePlanSpecificity,
} from "./task-planner/index.js";
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
	/** Open questions that need decisions before execution */
	openQuestions?: Array<{
		question: string;
		options?: string[];
		context?: string;
	}>;
	/** Resolved decisions from PM */
	resolvedDecisions?: Array<{
		question: string;
		decision: string;
	}>;
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
		case "sonnet":
			return "opus";
		case "opus":
			return "opus";
	}
}

/**
 * Request decomposition subtasks from a model
 * Called when a plan says "needs decomposition" but doesn't provide subtasks
 */
async function requestDecompositionSubtasks(
	task: string,
	reason: string,
	model: ModelTier,
	cwd: string,
): Promise<string[]> {
	const prompt = `You are decomposing a task that is too large or vague to execute directly.

TASK: ${task}

REASON IT NEEDS DECOMPOSITION: ${reason}

Break this task into 2-5 specific, actionable subtasks. Each subtask should:
1. Be concrete and executable (not vague)
2. Target specific files or components
3. Be completable independently
4. Together fully accomplish the original task

Respond with ONLY a JSON array of subtask descriptions:
["subtask 1 description", "subtask 2 description", ...]`;

	try {
		let result = "";
		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES[model],
				maxTurns: 1,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				cwd,
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				result = message.result;
			}
		}

		// Parse JSON array from response
		const match = result.match(/\[[\s\S]*?\]/);
		if (match) {
			const subtasks = JSON.parse(match[0]) as string[];
			if (Array.isArray(subtasks) && subtasks.length > 0 && subtasks.every((s) => typeof s === "string")) {
				logger.info({ model, count: subtasks.length }, "Got decomposition subtasks");
				return subtasks;
			}
		}
		logger.warn({ model, result: result.substring(0, 200) }, "Failed to parse subtasks from response");
		return [];
	} catch (error) {
		logger.warn({ error: String(error), model }, "Failed to request decomposition subtasks");
		return [];
	}
}

/** Maximum iterations for plan revision (create + N revisions) */
const MAX_PLAN_ITERATIONS = 3;

/**
 * Pre-gathered context for planning
 * Uses existing infrastructure instead of having planner explore
 */
interface PlanningContext {
	/** Context briefing with target files, types, etc. */
	briefing?: ContextBriefing;
	/** Suggested files from task-file patterns */
	suggestedFiles: Array<{ file: string; score: number; keywords: string[] }>;
	/** Relevant learnings from past tasks */
	learnings: string;
}

/**
 * Gather context for planning using existing infrastructure
 * This is FREE (local operations) vs expensive (LLM exploration)
 */
async function gatherPlanningContext(task: string, cwd: string): Promise<PlanningContext> {
	// Get suggested files from task-file patterns (instant, local)
	const suggestedFiles = findRelevantFiles(task, 10);

	// Get relevant learnings from knowledge base (instant, local)
	// Use compact format for token efficiency during planning
	const learnings = findRelevantLearnings(task, 5);
	const learningsText = learnings.length > 0 ? formatLearningsCompact(learnings) : "";

	// Prepare context briefing (uses AST index, grep - fast local operations)
	let briefing: ContextBriefing | undefined;
	try {
		briefing = await prepareContext(task, { cwd, mode: "compact" });
	} catch (e) {
		logger.warn({ error: String(e) }, "Failed to prepare context for planning");
	}

	return {
		briefing,
		suggestedFiles,
		learnings: learningsText,
	};
}

/**
 * Format pre-gathered context for injection into planner prompt
 */
function formatContextForPlanner(ctx: PlanningContext): string {
	const sections: string[] = [];

	if (ctx.briefing?.targetFiles && ctx.briefing.targetFiles.length > 0) {
		sections.push(`TARGET FILES (from codebase analysis):
${ctx.briefing.targetFiles.map((f) => `- ${f}`).join("\n")}`);
	}

	if (ctx.suggestedFiles.length > 0) {
		sections.push(`SUGGESTED FILES (from past task patterns):
${ctx.suggestedFiles.map((f) => `- ${f.file} (matched: ${f.keywords.join(", ")})`).join("\n")}`);
	}

	if (ctx.briefing?.typeDefinitions && ctx.briefing.typeDefinitions.length > 0) {
		sections.push(`RELEVANT TYPES:
${ctx.briefing.typeDefinitions.slice(0, 5).join("\n")}`);
	}

	if (ctx.briefing?.functionSignatures && ctx.briefing.functionSignatures.length > 0) {
		sections.push(`RELEVANT FUNCTIONS:
${ctx.briefing.functionSignatures.slice(0, 5).join("\n")}`);
	}

	if (ctx.learnings) {
		sections.push(ctx.learnings);
	}

	if (ctx.briefing?.constraints && ctx.briefing.constraints.length > 0) {
		sections.push(`CONSTRAINTS:
${ctx.briefing.constraints.map((c) => `- ${c}`).join("\n")}`);
	}

	return sections.length > 0 ? sections.join("\n\n") : "";
}

/**
 * Create an execution plan using the specified model
 */
async function createExecutionPlan(
	task: string,
	model: ModelTier,
	cwd: string,
	preContext?: PlanningContext,
): Promise<ExecutionPlan> {
	// Format pre-gathered context if available
	const contextSection = preContext ? formatContextForPlanner(preContext) : "";
	const contextIntro = contextSection
		? `\n\nPRE-GATHERED CONTEXT (use this instead of exploring):
${contextSection}

Based on this context, create your plan. You may still read specific files to verify details.`
		: "\n\nCreate a plan by exploring the codebase.";

	const prompt = `You are a planning assistant. Analyze this task and create a detailed execution plan.

TASK: ${task}${contextIntro}

Output your plan in this exact JSON format:

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
  "needsDecomposition": {"needed": false, "suggestedSubtasks": ["if too big, list subtasks"]},
  "openQuestions": [{"question": "question needing decision", "options": ["option1", "option2"], "context": "why this matters"}]
}
\`\`\`

RULES:
1. Use the pre-gathered context above - don't explore redundantly
2. Read specific files only to verify details or check current state
3. Check if the task is already complete (read target files)
4. If the task is too vague or large, mark needsDecomposition as true
5. Be specific about which files and what changes
6. List concrete steps, not vague directions
7. If there are multiple valid approaches or decisions to make, add them to openQuestions`;

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
		// Return minimal plan if parsing fails - marked for retry
		return {
			objective: task,
			filesToRead: [],
			filesToModify: [],
			filesToCreate: [],
			steps: ["Execute the task as described"],
			risks: ["Plan parsing failed - proceeding with minimal plan"],
			expectedOutcome: "Task completion",
			_parsingFailed: true, // Internal flag for retry logic
		} as ExecutionPlan & { _parsingFailed?: boolean };
	}
}

/**
 * Detect if a task is test-related (needs special handling)
 */
export function isTestTask(objective: string): boolean {
	const lower = objective.toLowerCase();
	return (
		lower.includes("test") ||
		lower.includes("spec") ||
		lower.includes("__tests__") ||
		lower.includes(".test.") ||
		lower.includes(".spec.") ||
		lower.includes("coverage") ||
		lower.includes("unit test") ||
		lower.includes("integration test") ||
		lower.includes("e2e")
	);
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
	preContext?: PlanningContext,
): Promise<ExecutionPlan> {
	const issuesText = feedback.issues.length > 0 ? feedback.issues.join("\n- ") : "None specified";
	const suggestionsText = feedback.suggestions.length > 0 ? feedback.suggestions.join("\n- ") : "None specified";

	// Include pre-gathered context for revision
	const contextSection = preContext ? formatContextForPlanner(preContext) : "";
	const contextIntro = contextSection
		? `\n\nAVAILABLE CONTEXT:
${contextSection}`
		: "";

	const prompt = `You are a planning assistant. Your previous plan was reviewed and needs revision.

TASK: ${task}${contextIntro}

YOUR PREVIOUS PLAN:
${JSON.stringify(currentPlan, null, 2)}

REVIEWER FEEDBACK:
Issues found:
- ${issuesText}

Suggestions:
- ${suggestionsText}

Revise your plan to address this feedback. Use the context above; read files only to verify specific details.

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
 * Pre-validate a plan by checking files and symbols exist
 * Returns validation findings to inject into review prompt
 */
function preValidatePlan(
	plan: ExecutionPlan,
	cwd: string,
): { missingFiles: string[]; unknownSymbols: string[]; validationSummary: string } {
	const missingFiles: string[] = [];
	const unknownSymbols: string[] = [];

	// Check if files to modify exist
	for (const file of plan.filesToModify) {
		const fullPath = join(cwd, file);
		if (!existsSync(fullPath)) {
			missingFiles.push(file);
		}
	}

	// Check if files to read exist
	for (const file of plan.filesToRead) {
		const fullPath = join(cwd, file);
		if (!existsSync(fullPath)) {
			// Reading a non-existent file is a warning, not an error
			// The plan might create it or it might be optional
		}
	}

	// Try to validate symbols via AST index
	try {
		const astIndex = getASTIndex(cwd);

		// Extract function/class/type names from steps
		const symbolPattern = /\b([A-Z][a-zA-Z0-9]+|[a-z]+[A-Z][a-zA-Z0-9]*)\b/g;
		const mentionedSymbols = new Set<string>();

		for (const step of plan.steps) {
			for (const match of step.matchAll(symbolPattern)) {
				// Filter out common words and short names
				if (match[1].length > 3 && !["true", "false", "null", "undefined"].includes(match[1].toLowerCase())) {
					mentionedSymbols.add(match[1]);
				}
			}
		}

		// Check if symbols exist (limit to avoid noise)
		let checked = 0;
		for (const symbol of mentionedSymbols) {
			if (checked >= 10) break;
			const definitions = astIndex.findSymbolDefinition(symbol);
			if (definitions.length === 0) {
				// Only flag if it looks like a real symbol (starts with capital or is camelCase)
				if (/^[A-Z]/.test(symbol) || /[a-z][A-Z]/.test(symbol)) {
					unknownSymbols.push(symbol);
				}
			}
			checked++;
		}
	} catch {
		// AST index not available, skip symbol validation
	}

	// Build validation summary
	const parts: string[] = [];
	if (missingFiles.length > 0) {
		parts.push(`MISSING FILES: ${missingFiles.join(", ")}`);
	}
	if (unknownSymbols.length > 0) {
		parts.push(`UNKNOWN SYMBOLS (may not exist): ${unknownSymbols.join(", ")}`);
	}

	const validationSummary =
		parts.length > 0
			? `\n\nPRE-VALIDATION FINDINGS (automated check):\n${parts.join("\n")}`
			: "\n\nPRE-VALIDATION: All referenced files exist.";

	return { missingFiles, unknownSymbols, validationSummary };
}

/**
 * Review a plan using a higher-tier model
 */
async function reviewExecutionPlan(
	task: string,
	plan: ExecutionPlan,
	model: ModelTier,
	cwd: string,
	retryCount = 0,
): Promise<PlanReview> {
	const MAX_RETRIES = 1; // Retry once on empty response

	// Pre-validate plan before sending to reviewer
	const validation = preValidatePlan(plan, cwd);

	logger.debug(
		{
			missingFiles: validation.missingFiles.length,
			unknownSymbols: validation.unknownSymbols.length,
		},
		"Plan pre-validation complete",
	);

	const prompt = `You are a senior code reviewer. Review this execution plan for quality and completeness.

ORIGINAL TASK: ${task}

PROPOSED PLAN:
${JSON.stringify(plan, null, 2)}${validation.validationSummary}

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
Verify file existence by checking the filesystem.

IMPORTANT: You MUST output a JSON response. Do not output an empty response.`;

	logger.debug({ task: task.substring(0, 50), model, retryCount }, "Reviewing execution plan");

	let reviewJson = "";
	let messageCount = 0;
	let lastError: string | undefined;

	for await (const message of query({
		prompt,
		options: {
			model: MODEL_NAMES[model],
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			maxTurns: 15, // Increased from 5 - agent needs time to process plan
			cwd,
		},
	})) {
		messageCount++;
		const msg = message as Record<string, unknown>;

		// Capture any error for logging
		if (msg.type === "result" && msg.subtype === "error") {
			lastError = String(msg.result || "Unknown error");
			logger.warn({ error: lastError, messageCount }, "Plan review query returned error");
		}

		if (message.type === "result" && message.subtype === "success") {
			reviewJson = message.result;
			logger.debug({ messageCount, resultLength: reviewJson?.length || 0 }, "Plan review received result");
		}
	}

	// Parse the review response using extracted pure function
	const parseResult = parsePlanReview(reviewJson);

	if (parseResult.success) {
		return parseResult.review;
	}

	// Handle parse failure based on reason
	switch (parseResult.reason) {
		case "empty":
			// Log diagnostic info for empty response
			logger.warn({ model, retryCount, messageCount, lastError }, "Plan review returned empty - diagnostic info");

			// Retry if we haven't exceeded retries
			if (retryCount < MAX_RETRIES) {
				logger.warn({ model, retryCount }, "Empty review response, retrying...");
				await new Promise((resolve) => setTimeout(resolve, 1000));
				return reviewExecutionPlan(task, plan, model, cwd, retryCount + 1);
			}
			logger.warn({ model, retryCount }, "Empty review response after retries, rejecting plan");
			return buildParseFailureReview("Review returned empty response after retries - rejecting for safety");

		case "rejection_signal":
			logger.info("Detected rejection signal in unparseable response, treating as rejection");
			return buildParseFailureReview("Review parsing failed - detected rejection signals in response");

		default:
			// Log full response for debugging
			logger.warn(
				{
					responseLength: reviewJson.length,
					responsePreview: reviewJson.substring(0, 500),
					responseEnd: reviewJson.length > 500 ? reviewJson.substring(reviewJson.length - 200) : undefined,
				},
				"Review parsing failed after all attempts",
			);
			return buildParseFailureReview("Review parsing failed - rejecting for safety");
	}
}

/**
 * Resolve open questions in a plan via the automated PM
 *
 * The PM uses past decisions, knowledge base, and (optionally) LLM judgment
 * to resolve questions inline before review. This keeps the plan-review
 * cycle self-contained rather than deferring decisions.
 */
async function resolveOpenQuestions(
	plan: ExecutionPlan,
	taskId: string,
	stateDir: string = ".undercity",
): Promise<ExecutionPlan> {
	if (!plan.openQuestions || plan.openQuestions.length === 0) {
		return plan;
	}

	logger.info({ taskId, questionCount: plan.openQuestions.length }, "Resolving open questions via PM");

	const resolvedDecisions: Array<{ question: string; decision: string }> = [];

	for (const q of plan.openQuestions) {
		try {
			const context = q.context || `Options: ${q.options?.join(", ") || "none specified"}`;
			const decision = await quickDecision(q.question, context, taskId, stateDir);

			if (decision) {
				resolvedDecisions.push({ question: q.question, decision });
				logger.debug({ question: q.question.substring(0, 50), decision }, "PM resolved question");
			} else {
				// PM escalated to human - leave question open
				logger.info({ question: q.question.substring(0, 50) }, "PM escalated question to human");
			}
		} catch (error) {
			logger.warn({ error: String(error), question: q.question.substring(0, 50) }, "Failed to resolve question via PM");
		}
	}

	// Return plan with resolved decisions and remaining open questions
	const unresolvedQuestions = plan.openQuestions.filter(
		(q) => !resolvedDecisions.some((r) => r.question === q.question),
	);

	return {
		...plan,
		resolvedDecisions: [...(plan.resolvedDecisions || []), ...resolvedDecisions],
		openQuestions: unresolvedQuestions.length > 0 ? unresolvedQuestions : undefined,
	};
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
	plannerModel: ModelTier = "sonnet",
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

	// Gather context using existing infrastructure (FREE - local operations)
	const planningContext = await gatherPlanningContext(task, cwd);
	logger.debug(
		{
			targetFiles: planningContext.briefing?.targetFiles?.length || 0,
			suggestedFiles: planningContext.suggestedFiles.length,
			hasLearnings: !!planningContext.learnings,
		},
		"Planning context gathered",
	);

	// Phase 1: Create initial plan with cheaper model (using pre-gathered context)
	let currentPlan = await createExecutionPlan(task, plannerModel, cwd, planningContext);
	let actualPlannerModel = plannerModel;

	// Phase 1.2: Validate plan specificity - retry with better model if too vague
	const specificity = validatePlanSpecificity(currentPlan);
	const planWithMeta = currentPlan as ExecutionPlan & { _parsingFailed?: boolean };

	if (shouldEscalatePlanner(specificity, !!planWithMeta._parsingFailed)) {
		logger.warn(
			{
				issues: specificity.issues,
				parsingFailed: !!planWithMeta._parsingFailed,
				plannerModel,
			},
			"Initial plan not specific enough - escalating planner model",
		);

		// Escalate planner model
		const escalatedModel = getReviewerTier(plannerModel);
		if (escalatedModel !== plannerModel) {
			logger.info({ from: plannerModel, to: escalatedModel }, "Retrying plan creation with escalated model");
			currentPlan = await createExecutionPlan(task, escalatedModel, cwd, planningContext);
			actualPlannerModel = escalatedModel;

			// Re-validate after escalation
			const recheck = validatePlanSpecificity(currentPlan);
			if (!recheck.isSpecific) {
				logger.warn({ issues: recheck.issues }, "Escalated plan still not specific - will proceed to review");
			}
		}
	}

	// Phase 1.5: Resolve any open questions via PM (inline, not deferred)
	if (currentPlan.openQuestions && currentPlan.openQuestions.length > 0) {
		const taskId = `plan-${Date.now().toString(36)}`;
		currentPlan = await resolveOpenQuestions(currentPlan, taskId);
	}

	// Recalculate reviewer model based on actual planner model used
	const actualReviewerModel = getReviewerTier(actualPlannerModel);

	// Early exit: already complete
	if (currentPlan.alreadyComplete?.likely) {
		return buildAlreadyCompleteResult(currentPlan, actualPlannerModel, actualReviewerModel);
	}

	// Early exit: needs decomposition
	if (currentPlan.needsDecomposition?.needed) {
		let subtasks = currentPlan.needsDecomposition.suggestedSubtasks || [];
		const reason = "Task is too large or vague to execute directly";

		// If no subtasks provided, escalate through models to get them
		if (subtasks.length === 0) {
			logger.info(
				{ plannerModel: actualPlannerModel, reason },
				"Plan needs decomposition but no subtasks - escalating",
			);

			// Try reviewerModel first (sonnet if planner was haiku)
			subtasks = await requestDecompositionSubtasks(task, reason, actualReviewerModel, cwd);

			// If still no subtasks and not at opus, try opus
			if (subtasks.length === 0 && actualReviewerModel !== "opus") {
				logger.info("Escalating to opus for decomposition subtasks");
				subtasks = await requestDecompositionSubtasks(task, reason, "opus", cwd);
			}
		}

		return buildDecompositionResult(currentPlan, subtasks, actualPlannerModel, actualReviewerModel);
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
		review = await reviewExecutionPlan(task, currentPlan, actualReviewerModel, cwd);

		// Check if we should continue the loop
		const loopCheck = shouldContinueReviewLoop(review, iteration, MAX_PLAN_ITERATIONS);
		if (!loopCheck.continue) {
			if (loopCheck.reason === "no_feedback") {
				logger.warn({ iteration }, "Plan rejected without actionable feedback");
			} else if (loopCheck.reason === "max_iterations") {
				logger.info({ iteration }, "Max plan iterations reached, using current plan");
			}
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

		currentPlan = await revisePlan(task, currentPlan, review, actualPlannerModel, cwd, planningContext);

		// Check if revision triggered decomposition
		if (currentPlan.needsDecomposition?.needed) {
			let subtasks = currentPlan.needsDecomposition.suggestedSubtasks || [];
			const reason = "Task is too large or vague after plan revision";

			// If no subtasks provided, escalate through models to get them
			if (subtasks.length === 0) {
				logger.info(
					{ plannerModel: actualPlannerModel, reason },
					"Revision needs decomposition but no subtasks - escalating",
				);
				subtasks = await requestDecompositionSubtasks(task, reason, actualReviewerModel, cwd);

				if (subtasks.length === 0 && actualReviewerModel !== "opus") {
					logger.info("Escalating to opus for decomposition subtasks");
					subtasks = await requestDecompositionSubtasks(task, reason, "opus", cwd);
				}
			}

			return buildDecompositionResult(currentPlan, subtasks, actualPlannerModel, actualReviewerModel, reason);
		}
	}

	// Build final result using helper
	const result = buildFinalPlanResult(currentPlan, review!, actualPlannerModel, actualReviewerModel, iteration);

	logger.info(
		{
			task: task.substring(0, 50),
			approved: review!.approved,
			proceedWithExecution: result.proceedWithExecution,
			iterations: iteration,
			skipReason: result.skipReason,
		},
		"Tiered planning complete",
	);

	return result;
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
