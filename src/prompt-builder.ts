/**
 * Prompt Builder
 *
 * Centralized module for all prompt construction logic.
 * Consolidates prompt formatting, context building, and input sanitization
 * into a single maintainable module.
 *
 * Previously split across worker/prompt-builder.ts and worker/context-builder.ts.
 */

import type { ComplexityLevel } from "./complexity.js";
import { sanitizeContent } from "./content-sanitizer.js";
import type { ContextBriefing } from "./context.js";
import { generateToolsPrompt } from "./efficiency-tools.js";
import { formatPatternsAsRules, getFailureWarningsForTask } from "./error-fix-patterns.js";
import { findRelevantLearnings, formatLearningsCompact } from "./knowledge.js";
import { getMetaTaskPrompt } from "./meta-tasks.js";
import { classifyTask, hasClassificationData } from "./task-classifier.js";
import { findRelevantFiles, formatCoModificationHints, formatFileSuggestionsForPrompt } from "./task-file-patterns.js";
import { formatExecutionPlanAsContext, type TieredPlanResult } from "./task-planner.js";
import type { MetaTaskType, TicketContent } from "./types.js";
import { getFewShotExample } from "./worker/task-helpers.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Result of prompt building
 */
export interface PromptBuildResult {
	prompt: string;
	resumePrompt?: string;
	canResume: boolean;
	injectedLearningIds: string[];
	/** Files predicted to be modified based on task-file patterns */
	predictedFiles: string[];
}

/**
 * Result from building a research prompt
 */
export interface ResearchPromptResult {
	prompt: string;
	injectedLearningIds: string[];
}

export interface BuildResearchPromptOptions {
	task: string;
	attempts: number;
	lastFeedback?: string;
	consecutiveNoWriteAttempts?: number;
	stateDir?: string;
}

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

// =============================================================================
// Prompt Building Functions
// =============================================================================

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
 * Build prompt for research tasks with learning context injection
 */
export async function buildResearchPrompt(opts: BuildResearchPromptOptions): Promise<ResearchPromptResult> {
	const { task, attempts, lastFeedback, consecutiveNoWriteAttempts, stateDir } = opts;
	const objectiveWithoutPrefix = task.replace(/^\[research\]\s*/i, "");
	const sections: string[] = [];
	let injectedLearningIds: string[] = [];

	// Generate a filename from the objective
	const slug = objectiveWithoutPrefix
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	const timestamp = new Date().toISOString().split("T")[0];
	const outputPath = `.undercity/research/${timestamp}-${slug}.md`;

	// Inject relevant learnings from previous research/tasks
	const relevantLearnings = findRelevantLearnings(objectiveWithoutPrefix, 5, stateDir);
	if (relevantLearnings.length > 0) {
		const learningsPrompt = formatLearningsCompact(relevantLearnings);
		sections.push(learningsPrompt);
		injectedLearningIds = relevantLearnings.map((l) => l.id);
	}

	// Inject semantic warnings from similar failed tasks
	if (stateDir && hasClassificationData(stateDir)) {
		try {
			const classification = await classifyTask(objectiveWithoutPrefix, stateDir);
			if (classification.similarTasks.some((t) => t.outcome === "failure")) {
				const failedSimilar = classification.similarTasks.filter((t) => t.outcome === "failure");
				const warningLines = [
					"SIMILAR RESEARCH HAS FAILED BEFORE:",
					...failedSimilar.slice(0, 3).map((t) => {
						const reason = t.failureReason || "unknown reason";
						const objective = t.objective.length > 60 ? `${t.objective.substring(0, 60)}...` : t.objective;
						return `  - "${objective}" failed: ${reason}`;
					}),
					"",
					"Learn from these failures - try a different approach.",
				];
				sections.push(warningLines.join("\n"));
			}
		} catch {
			// Classification failed - continue without it
		}
	}

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

	// Build context section from learnings/warnings
	const contextSection = sections.length > 0 ? `${sections.join("\n\n---\n\n")}\n\n---\n\n` : "";

	const prompt = `${contextSection}You are a research assistant. Your task is to gather information and document findings.

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

	return { prompt, injectedLearningIds };
}

// =============================================================================
// Ticket Formatting
// =============================================================================

/**
 * Sanitize a ticket field value.
 * Ticket content may come from external sources (file imports, PM generation)
 * so we sanitize to prevent prompt injection.
 */
function sanitizeTicketField(value: string, fieldName: string): string {
	const result = sanitizeContent(value, `ticket-${fieldName}`);
	return result.blocked ? "" : result.content;
}

/**
 * Format ticket content as context for the agent prompt.
 * Converts the structured ticket into readable markdown sections.
 * Ticket fields are sanitized to prevent prompt injection from external sources.
 */
export function formatTicketContext(ticket: TicketContent): string {
	const parts: string[] = [];

	if (ticket.description) {
		parts.push(`## Task Description\n${sanitizeTicketField(ticket.description, "description")}`);
	}
	if (ticket.acceptanceCriteria?.length) {
		const sanitized = ticket.acceptanceCriteria.map((c) => sanitizeTicketField(c, "criteria")).filter(Boolean);
		if (sanitized.length > 0) {
			parts.push(`## Acceptance Criteria\n${sanitized.map((c) => `- [ ] ${c}`).join("\n")}`);
		}
	}
	if (ticket.testPlan) {
		parts.push(`## Test Plan\n${sanitizeTicketField(ticket.testPlan, "testPlan")}`);
	}
	if (ticket.implementationNotes) {
		parts.push(`## Implementation Notes\n${sanitizeTicketField(ticket.implementationNotes, "notes")}`);
	}
	if (ticket.rationale) {
		parts.push(`## Why This Matters\n${sanitizeTicketField(ticket.rationale, "rationale")}`);
	}
	if (ticket.researchFindings?.length) {
		const sanitized = ticket.researchFindings.map((f) => sanitizeTicketField(f, "research")).filter(Boolean);
		if (sanitized.length > 0) {
			parts.push(`## Research Findings\n${sanitized.map((f) => `- ${f}`).join("\n")}`);
		}
	}

	return parts.join("\n\n");
}

// =============================================================================
// Context Building
// =============================================================================

/**
 * Build the context section for a standard implementation task prompt
 */
export async function buildImplementationContext(
	config: ContextBuildConfig,
	complexityLevel?: ComplexityLevel,
): Promise<ContextBuildResult> {
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

	// Lightweight tasks skip expensive context that provides minimal benefit
	const isLightweight = complexityLevel === "trivial" || complexityLevel === "simple";

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

	// Skip expensive context for lightweight tasks - too simple to benefit
	if (!isLightweight) {
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
						"SIMILAR TASKS HAVE FAILED BEFORE:",
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
	}

	// Add file suggestions based on task-file patterns
	// Also capture predicted files for effectiveness tracking
	const relevantFiles = findRelevantFiles(task, 10, stateDir);
	predictedFiles = relevantFiles.map((f) => f.file);
	const fileSuggestions = formatFileSuggestionsForPrompt(task, stateDir);
	if (fileSuggestions) {
		sections.push(fileSuggestions);
	}

	// Skip co-modification hints for lightweight tasks
	if (!isLightweight && briefing?.targetFiles && briefing.targetFiles.length > 0) {
		const coModHints = formatCoModificationHints(briefing.targetFiles);
		if (coModHints) {
			sections.push(coModHints);
		}
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
