/**
 * Worker Prompt Builder
 *
 * Extracts prompt building logic from the TaskWorker class for better
 * maintainability and testability.
 */

import { findRelevantLearnings, formatLearningsCompact } from "../knowledge.js";
import { getMetaTaskPrompt } from "../meta-tasks.js";
import {
	formatCoModificationHints,
	formatFileSuggestionsForPrompt,
} from "../task-file-patterns.js";
import { formatExecutionPlanAsContext, type TieredPlanResult } from "../task-planner.js";
import type { ContextBriefing } from "../context.js";
import { generateToolsPrompt } from "../efficiency-tools.js";
import {
	formatPatternsAsRules,
	getFailureWarningsForTask,
} from "../error-fix-patterns.js";
import type { MetaTaskType } from "../types.js";

/**
 * Context required for building prompts
 */
export interface PromptBuildContext {
	task: string;
	workingDirectory: string;
	stateDir: string;
	attempts: number;
	lastFeedback?: string;
	lastPostMortem?: string;
	isMetaTask: boolean;
	isResearchTask: boolean;
	metaType: MetaTaskType | null;
	briefing?: ContextBriefing;
	executionPlan?: TieredPlanResult;
	handoffContext?: string;
	assignmentContext?: string;
	errorHistory: Array<{ category: string; message: string }>;
	consecutiveNoWriteAttempts: number;
}

/**
 * Result of prompt building
 */
export interface PromptBuildResult {
	prompt: string;
	resumePrompt?: string;
	canResume: boolean;
	injectedLearningIds: string[];
}

/**
 * Build resume prompt for retry with existing session
 */
export function buildResumePrompt(feedback: string): string {
	return `VERIFICATION FAILED. Here's what needs to be fixed:

${feedback}

Please fix these specific issues. You have all the context from your previous work - focus on addressing these errors.`;
}

/**
 * Build prompt for meta-tasks (triage, plan, etc.)
 */
export function buildMetaTaskPrompt(
	metaType: MetaTaskType,
	task: string,
	workingDirectory: string,
	attempts: number,
	lastFeedback?: string,
): string {
	const metaPrompt = getMetaTaskPrompt(metaType);
	const objectiveWithoutPrefix = task.replace(/^\[(?:meta:\w+|plan)\]\s*/i, "");

	let retryContext = "";
	if (attempts > 1 && lastFeedback) {
		retryContext = `

PREVIOUS ATTEMPT FAILED:
${lastFeedback}

Please fix these issues and return valid JSON.`;
	}

	return `${metaPrompt}

OBJECTIVE: ${objectiveWithoutPrefix}${retryContext}

Working directory: ${workingDirectory}
Read the task board from .undercity/tasks.json to analyze.
Return your analysis as JSON in the format specified above.`;
}

/**
 * Build prompt for research tasks
 */
export function buildResearchPrompt(
	task: string,
	attempts: number,
	lastFeedback?: string,
	consecutiveNoWriteAttempts?: number,
): string {
	const objectiveWithoutPrefix = task.replace(/^\[research\]\s*/i, "");

	// Generate a filename from the objective
	const slug = objectiveWithoutPrefix
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	const timestamp = new Date().toISOString().split("T")[0];
	const outputPath = `.undercity/research/${timestamp}-${slug}.md`;

	let retryContext = "";
	if (attempts > 1 && lastFeedback) {
		// Check if agent was using Edit on non-existent file
		const editOnNewFile =
			(consecutiveNoWriteAttempts ?? 0) >= 1 ||
			lastFeedback.includes("Edit") ||
			lastFeedback.includes("does not exist");

		if (editOnNewFile) {
			retryContext = `

PREVIOUS ATTEMPT FAILED - WRONG TOOL USED:
${lastFeedback}

CRITICAL FIX: The Edit tool CANNOT create new files. For new files, you MUST use the Write tool.
Steps:
1. Run: mkdir -p .undercity/research
2. Use Write tool (not Edit) to create ${outputPath} with your findings`;
		} else {
			retryContext = `

PREVIOUS ATTEMPT FEEDBACK:
${lastFeedback}

Please provide more detailed findings and ensure the markdown file is written.`;
		}
	}

	return `You are a research assistant. Your task is to gather information and document findings.

RESEARCH OBJECTIVE:
${objectiveWithoutPrefix}${retryContext}

INSTRUCTIONS:
1. Use web search, documentation, and any available resources to research this topic
2. Focus on gathering accurate, relevant information
3. Cite sources when possible
4. Provide actionable insights

OUTPUT FILE: ${outputPath}

CRITICAL - Follow these steps to write the output file:
1. First, run: mkdir -p .undercity/research (to ensure directory exists)
2. Check if ${outputPath} already exists using Read tool
3. If the file exists, read it first, then use Edit or Write to update it
4. If the file does NOT exist, you can create it with Write

Use this markdown structure:
\`\`\`markdown
# Research: ${objectiveWithoutPrefix}

## Summary
Brief summary of key findings.

## Findings
- **Finding 1**: Description (Source: URL)
- **Finding 2**: Description (Source: URL)

## Recommendations
- Actionable next steps based on research

## Sources
- [Source Name](URL)
\`\`\`

The file MUST be created at ${outputPath} for this task to succeed.`;
}

/**
 * Build all context sections for standard implementation tasks
 */
export function buildContextSections(ctx: PromptBuildContext): {
	contextSection: string;
	injectedLearningIds: string[];
} {
	let contextSection = "";
	let injectedLearningIds: string[] = [];

	// Add assignment context for worker identity and recovery
	if (ctx.assignmentContext) {
		contextSection += `${ctx.assignmentContext}\n---\n\n`;
	}

	// Add handoff context from calling Claude Code session
	if (ctx.handoffContext) {
		contextSection += `${ctx.handoffContext}\n---\n\n`;
	}

	// Add briefing document
	if (ctx.briefing?.briefingDoc) {
		contextSection += `${ctx.briefing.briefingDoc}\n\n---\n\n`;
	}

	// Add efficiency tools section if any tools are available
	const toolsPrompt = generateToolsPrompt();
	if (toolsPrompt) {
		contextSection += `${toolsPrompt}\n\n---\n\n`;
	}

	// Add relevant learnings from previous tasks (compact format for token efficiency)
	const relevantLearnings = findRelevantLearnings(ctx.task, 5, ctx.stateDir);
	if (relevantLearnings.length > 0) {
		const learningsPrompt = formatLearningsCompact(relevantLearnings);
		contextSection += `${learningsPrompt}\n\n---\n\n`;
		injectedLearningIds = relevantLearnings.map((l) => l.id);
	}

	// Add failure warnings ("signs for Ralph") from past failures
	const failureWarnings = getFailureWarningsForTask(ctx.task, 2, ctx.stateDir);
	if (failureWarnings) {
		contextSection += `${failureWarnings}\n\n---\n\n`;
	}

	// Ralph-style: inject RULES from error patterns and current session errors
	const errorRules = formatPatternsAsRules(ctx.task, ctx.errorHistory, ctx.stateDir);
	if (errorRules) {
		contextSection += `${errorRules}\n\n---\n\n`;
	}

	// Add file suggestions based on task-file patterns
	const fileSuggestions = formatFileSuggestionsForPrompt(ctx.task);
	if (fileSuggestions) {
		contextSection += `${fileSuggestions}\n\n---\n\n`;
	}

	// Add co-modification hints based on target files from context
	if (ctx.briefing?.targetFiles && ctx.briefing.targetFiles.length > 0) {
		const coModHints = formatCoModificationHints(ctx.briefing.targetFiles);
		if (coModHints) {
			contextSection += `${coModHints}\n\n---\n\n`;
		}
	}

	return { contextSection, injectedLearningIds };
}

/**
 * Check if task might already be complete
 */
export function checkTaskMayBeComplete(task: string, workingDirectory: string): string | null {
	// Import dynamically to avoid circular dependencies
	// This is a simple heuristic check - the worker has the full implementation
	return null; // Let the worker handle this with its full implementation
}

/**
 * Build the complete standard implementation prompt
 */
export function buildStandardPrompt(ctx: PromptBuildContext): PromptBuildResult {
	const { contextSection, injectedLearningIds } = buildContextSections(ctx);

	let fullContext = contextSection;

	// Add execution plan from planning phase (if available)
	if (ctx.executionPlan?.proceedWithExecution) {
		const planContext = formatExecutionPlanAsContext(ctx.executionPlan.plan);
		fullContext += `${planContext}\n\n---\n\n`;
	}

	// For first attempt after escalation, include post-mortem
	let postMortemContext = "";
	if (ctx.lastPostMortem) {
		postMortemContext = `

POST-MORTEM FROM PREVIOUS TIER:
${ctx.lastPostMortem}

Use this analysis to avoid repeating the same mistakes.`;
	}

	const prompt = `${fullContext}TASK:
${ctx.task}${postMortemContext}
RULES:
1. First verify the task isn't already complete - check git log, read target files
2. If task is already done, output exactly: TASK_ALREADY_COMPLETE: <reason>
3. If the target file/function/class doesn't exist and this isn't a create task, output: INVALID_TARGET: <reason>
4. If the task is too vague to act on (no specific targets, unclear what to change), output: NEEDS_DECOMPOSITION: <what specific subtasks are needed>
5. If the task requires creating new files, create them (Write tool creates parent directories)
5. If editing existing files, read them first before editing
6. Minimal changes only - nothing beyond task scope
7. No questions - decide and proceed`;

	return {
		prompt,
		canResume: false,
		injectedLearningIds,
	};
}

/**
 * Main entry point: build prompt based on task type
 */
export function buildPromptForTask(
	ctx: PromptBuildContext,
	currentAgentSessionId?: string,
): PromptBuildResult {
	const isRetry = ctx.attempts > 1 && ctx.lastFeedback;
	const canResume = isRetry && currentAgentSessionId && !ctx.lastPostMortem;

	// Resume existing session
	if (canResume && ctx.lastFeedback) {
		return {
			prompt: "",
			resumePrompt: buildResumePrompt(ctx.lastFeedback),
			canResume: true,
			injectedLearningIds: [],
		};
	}

	// Meta-task
	if (ctx.isMetaTask && ctx.metaType) {
		return {
			prompt: buildMetaTaskPrompt(
				ctx.metaType,
				ctx.task,
				ctx.workingDirectory,
				ctx.attempts,
				ctx.lastFeedback,
			),
			canResume: false,
			injectedLearningIds: [],
		};
	}

	// Research task
	if (ctx.isResearchTask) {
		return {
			prompt: buildResearchPrompt(
				ctx.task,
				ctx.attempts,
				ctx.lastFeedback,
				ctx.consecutiveNoWriteAttempts,
			),
			canResume: false,
			injectedLearningIds: [],
		};
	}

	// Standard implementation task
	return buildStandardPrompt(ctx);
}
