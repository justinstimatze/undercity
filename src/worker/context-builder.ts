/**
 * Worker Context Builder
 *
 * Extracted context building logic from executeAgent to reduce complexity.
 */

import type { ContextBriefing } from "../context.js";
import { generateToolsPrompt } from "../efficiency-tools.js";
import { formatPatternsAsRules, getFailureWarningsForTask } from "../error-fix-patterns.js";
import { findRelevantLearnings, formatLearningsCompact } from "../knowledge.js";
import { classifyTask, hasClassificationData } from "../task-classifier.js";
import { findRelevantFiles, formatCoModificationHints, formatFileSuggestionsForPrompt } from "../task-file-patterns.js";
import { formatExecutionPlanAsContext, type TieredPlanResult } from "../task-planner.js";
import type { TicketContent } from "../types.js";
import { checkTaskMayBeComplete, formatTicketContext } from "./prompt-builder.js";
import { getFewShotExample } from "./task-helpers.js";

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
	/** Rich ticket content for task context */
	ticket?: TicketContent;
}

/**
 * Result from context building
 */
export interface ContextBuildResult {
	prompt: string;
	injectedLearningIds: string[];
	/** Files predicted to be modified based on task-file patterns */
	predictedFiles: string[];
	/** Classifier prediction for effectiveness tracking */
	classifierPrediction?: {
		riskLevel: "low" | "medium" | "high";
		confidence: number;
	};
}

/**
 * Build the context section for a standard implementation task prompt
 */
export async function buildImplementationContext(config: ContextBuildConfig): Promise<ContextBuildResult> {
	const {
		task,
		stateDir,
		briefing,
		executionPlan,
		lastPostMortem,
		errorHistory,
		assignmentContext,
		handoffContextSection,
		ticket,
	} = config;

	const sections: string[] = [];
	let injectedLearningIds: string[] = [];
	let predictedFiles: string[] = [];
	let classifierPrediction: ContextBuildResult["classifierPrediction"];

	// Add assignment context for worker identity and recovery
	if (assignmentContext) {
		sections.push(assignmentContext);
	}

	// Add ticket context early (high-value structured context from task definition)
	if (ticket) {
		const ticketContext = formatTicketContext(ticket);
		if (ticketContext) {
			sections.push(`# Task Ticket\n\n${ticketContext}`);
		}
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

	// Add semantic warnings from similar failed tasks (RAG-based classification)
	if (hasClassificationData(stateDir)) {
		try {
			const classification = await classifyTask(task, stateDir);

			// Convert riskScore (0-1) to riskLevel for effectiveness tracking
			const riskLevel: "low" | "medium" | "high" =
				classification.riskScore < 0.33 ? "low" : classification.riskScore < 0.66 ? "medium" : "high";

			// Capture classifier prediction for effectiveness tracking
			classifierPrediction = {
				riskLevel,
				confidence: classification.confidence,
			};

			if (classification.similarTasks.some((t) => t.outcome === "failure")) {
				const failedSimilar = classification.similarTasks.filter((t) => t.outcome === "failure");
				const warningLines = [
					"⚠️ SIMILAR TASKS HAVE FAILED BEFORE:",
					...failedSimilar.slice(0, 3).map((t) => {
						const reason = t.failureReason || "unknown reason";
						const objective = t.objective.length > 60 ? `${t.objective.substring(0, 60)}...` : t.objective;
						return `  - "${objective}" failed: ${reason}`;
					}),
					"",
					"Learn from these failures - avoid the same mistakes.",
				];
				sections.push(warningLines.join("\n"));
			}
		} catch {
			// Classification failed - continue without it
		}
	}

	// Ralph-style: inject RULES from error patterns and current session errors
	const errorRules = formatPatternsAsRules(task, errorHistory, stateDir);
	if (errorRules) {
		sections.push(errorRules);
	}

	// Add file suggestions based on task-file patterns
	// Also capture predicted files for effectiveness tracking
	const relevantFiles = findRelevantFiles(task, 10, stateDir);
	predictedFiles = relevantFiles.map((f) => f.file);
	const fileSuggestions = formatFileSuggestionsForPrompt(task, stateDir);
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
	const contextSection = sections.length > 0 ? `${sections.join("\n\n---\n\n")}\n\n---\n\n` : "";

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

	return { prompt, injectedLearningIds, predictedFiles, classifierPrediction };
}
