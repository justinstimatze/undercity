/**
 * Worker Context Builder
 *
 * Extracted context building logic from executeAgent to reduce complexity.
 */

import {
	formatCoModificationHints,
	formatFileSuggestionsForPrompt,
} from "../task-file-patterns.js";
import {
	formatPatternsAsRules,
	getFailureWarningsForTask,
} from "../error-fix-patterns.js";
import { findRelevantLearnings, formatLearningsCompact } from "../knowledge.js";
import { generateToolsPrompt } from "../efficiency-tools.js";
import { formatExecutionPlanAsContext, type TieredPlanResult } from "../task-planner.js";
import type { ContextBriefing } from "../context.js";
import { getFewShotExample } from "./task-helpers.js";
import { checkTaskMayBeComplete } from "./prompt-builder.js";

/**
 * Configuration for building agent context
 */
export interface ContextBuildConfig {
	task: string;
	stateDir: string;
	workingDirectory: string;
	assignmentContext?: string;
	handoffContextSection?: string;
	briefing?: ContextBriefing | null;
	executionPlan?: TieredPlanResult | null;
	lastPostMortem?: string;
	errorHistory: Array<{ category: string; message: string; attempt?: number }>;
}

/**
 * Result from context building
 */
export interface ContextBuildResult {
	prompt: string;
	injectedLearningIds: string[];
}

/**
 * Build the context section for a standard implementation task prompt
 */
export function buildImplementationContext(config: ContextBuildConfig): ContextBuildResult {
	const {
		task,
		stateDir,
		briefing,
		executionPlan,
		lastPostMortem,
		errorHistory,
		assignmentContext,
		handoffContextSection,
	} = config;

	const sections: string[] = [];
	let injectedLearningIds: string[] = [];

	// Add assignment context for worker identity and recovery
	if (assignmentContext) {
		sections.push(assignmentContext);
	}

	// Add handoff context from calling Claude Code session
	if (handoffContextSection) {
		sections.push(handoffContextSection);
	}

	// Add codebase briefing
	if (briefing?.briefingDoc) {
		sections.push(briefing.briefingDoc);
	}

	// Add efficiency tools section if any tools are available
	const toolsPrompt = generateToolsPrompt();
	if (toolsPrompt) {
		sections.push(toolsPrompt);
	}

	// Add relevant learnings from previous tasks (compact format for token efficiency)
	const relevantLearnings = findRelevantLearnings(task, 5, stateDir);
	if (relevantLearnings.length > 0) {
		const learningsPrompt = formatLearningsCompact(relevantLearnings);
		sections.push(learningsPrompt);
		injectedLearningIds = relevantLearnings.map((l) => l.id);
	}

	// Add failure warnings ("signs for Ralph") from past failures
	const failureWarnings = getFailureWarningsForTask(task, 2, stateDir);
	if (failureWarnings) {
		sections.push(failureWarnings);
	}

	// Ralph-style: inject RULES from error patterns and current session errors
	const errorRules = formatPatternsAsRules(task, errorHistory, stateDir);
	if (errorRules) {
		sections.push(errorRules);
	}

	// Add file suggestions based on task-file patterns
	const fileSuggestions = formatFileSuggestionsForPrompt(task);
	if (fileSuggestions) {
		sections.push(fileSuggestions);
	}

	// Add co-modification hints based on target files from context
	if (briefing?.targetFiles && briefing.targetFiles.length > 0) {
		const coModHints = formatCoModificationHints(briefing.targetFiles);
		if (coModHints) {
			sections.push(coModHints);
		}
	}

	// Check if task might already be complete (pre-flight check)
	const alreadyDoneHint = checkTaskMayBeComplete(task, config.workingDirectory);
	if (alreadyDoneHint) {
		sections.push(`⚠️ PRE-FLIGHT CHECK:\n${alreadyDoneHint}`);
	}

	// Add execution plan from planning phase (if available)
	if (executionPlan?.proceedWithExecution) {
		const planContext = formatExecutionPlanAsContext(executionPlan.plan);
		sections.push(planContext);
	}

	// Build context section with separators
	const contextSection = sections.length > 0 ? sections.join("\n\n---\n\n") + "\n\n---\n\n" : "";

	// Build post-mortem context (for escalation retries)
	const postMortemContext = lastPostMortem
		? `

POST-MORTEM FROM PREVIOUS TIER:
${lastPostMortem}

Use this analysis to avoid repeating the same mistakes.`
		: "";

	// Get few-shot example if applicable for this task type
	const fewShotExample = getFewShotExample(task);
	const exampleSection = fewShotExample ? `\nEXAMPLE OF SIMILAR TASK:\n${fewShotExample}\n` : "";

	const prompt = `${contextSection}TASK:
${task}${postMortemContext}${exampleSection}
RULES:
1. First verify the task isn't already complete - check git log, read target files
2. If task is already done, output exactly: TASK_ALREADY_COMPLETE: <reason>
3. If the target file/function/class doesn't exist and this isn't a create task, output: INVALID_TARGET: <reason>
4. If the task is too vague to act on (no specific targets, unclear what to change), output: NEEDS_DECOMPOSITION: <what specific subtasks are needed>
5. If the task requires creating new files, create them (Write tool creates parent directories)
5. If editing existing files, read them first before editing
6. Minimal changes only - nothing beyond task scope
7. No questions - decide and proceed`;

	return { prompt, injectedLearningIds };
}
