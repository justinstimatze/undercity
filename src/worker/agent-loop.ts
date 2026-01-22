/**
 * Agent Loop Execution
 *
 * Core agent execution loop extracted from TaskWorker.
 * Handles SDK query, message processing, write tracking, and error handling.
 *
 * Uses dependency injection for:
 *   - State access (read/write)
 *   - Metrics tracking
 *   - Streaming output
 *
 * Reuses existing extracted modules:
 *   - agent-execution.ts for SDK helpers
 *   - message-tracker.ts for message processing
 *   - stop-hooks.ts for stop hook logic
 *   - hooks.ts for pre-tool-use hooks
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import chalk from "chalk";
import type { ContextBriefing } from "../context.js";
import { captureDecision, parseAgentOutputForDecisions } from "../decision-tracker.js";
import { dualLogger } from "../dual-logger.js";
import { sessionLogger } from "../logger.js";
import type { HandoffContext } from "../task.js";
import type { TieredPlanResult } from "../task-planner.js";
import { extractMetaTaskType } from "../task-schema.js";
import type { ModelTier, TicketContent, TokenUsage } from "../types.js";
import { MODEL_NAMES } from "../types.js";
import {
	buildQueryOptions,
	buildQueryParams,
	captureDecisionsFromOutput,
	createMessageTiming,
	extractResultMessageData,
	type HookCallbackMatcher,
	logSlowMessageGap,
	parseResultMarkers,
	type ResultMessageData,
	recordAgentQueryResult,
	type SDKHookOutput,
} from "./agent-execution.js";
import { buildImplementationContext } from "./context-builder.js";
import { createPreToolUseHooks, getMaxTurnsForModel } from "./hooks.js";
import {
	type PendingWriteTool,
	processAssistantMessage,
	processUserMessage,
	type TaskMarkers,
	type WriteTrackingState,
} from "./message-tracker.js";
import { buildMetaTaskPrompt, buildResearchPrompt, buildResumePrompt } from "./prompt-builder.js";

// =============================================================================
// Configuration (Immutable)
// =============================================================================

/**
 * Immutable configuration for agent loop execution
 */
export interface AgentLoopConfig {
	readonly workingDirectory: string;
	readonly stateDir: string;
	readonly stream: boolean;
	readonly auditBash: boolean;
	readonly useSystemPromptPreset: boolean;
	readonly maxWritesPerFile: number;
}

// =============================================================================
// State (Mutable)
// =============================================================================

/**
 * Mutable state for agent loop execution.
 * Passed by reference - modifications persist to caller.
 */
export interface AgentLoopState {
	// Current execution context
	currentTaskId: string;
	currentModel: ModelTier;
	attempts: number;

	// Task classification
	isCurrentTaskMeta: boolean;
	isCurrentTaskResearch: boolean;

	// Session state
	currentAgentSessionId: string | undefined;
	lastFeedback: string | undefined;
	lastPostMortem: string | undefined;

	// Write tracking
	writeCountThisExecution: number;
	writesPerFile: Map<string, number>;
	noOpEditCount: number;
	consecutiveNoWriteAttempts: number;

	// Task markers
	taskAlreadyCompleteReason: string | null;
	invalidTargetReason: string | null;
	needsDecompositionReason: string | null;

	// Output storage
	lastAgentOutput: string;
	lastAgentTurns: number;

	// Token tracking
	tokenUsageThisTask: TokenUsage[];

	// Injected learning IDs (output)
	injectedLearningIds: string[];
}

/**
 * Context provided to agent loop for building prompts
 */
export interface AgentLoopContext {
	task: string;
	briefing: ContextBriefing | undefined;
	executionPlan: TieredPlanResult | null;
	handoffContext: HandoffContext | undefined;
	errorHistory: Array<{ category: string; message: string; attempt: number }>;
	/** Rich ticket content for task context */
	ticket?: TicketContent;
}

// =============================================================================
// Dependencies
// =============================================================================

/**
 * Dependencies injected into agent loop
 */
export interface AgentLoopDependencies {
	/** Extract token usage from SDK message */
	extractTokenUsage: (message: unknown) => TokenUsage | undefined;
	/** Record token usage to metrics */
	recordTokenUsage: (message: unknown, model: ModelTier) => void;
	/** Build assignment context section */
	buildAssignmentContext: () => string;
	/** Build handoff context section */
	buildHandoffContextSection: () => string;
}

// =============================================================================
// Result
// =============================================================================

/**
 * Result of agent loop execution
 */
export interface AgentLoopResult {
	/** Agent output text */
	output: string;
	/** Number of turns taken */
	turns: number;
	/** Whether agent reported completion */
	reportedComplete: boolean;
	/** Whether agent reported invalid target */
	reportedInvalidTarget: boolean;
	/** Whether agent needs decomposition */
	needsDecomposition: boolean;
}

// =============================================================================
// Stop Hooks
// =============================================================================

/**
 * Build stop hooks for agent execution.
 * Prevents agent from finishing without making changes.
 */
export function buildStopHooks(state: AgentLoopState, isMetaTask: boolean): HookCallbackMatcher[] {
	// Meta-tasks don't need the "must write files" check
	if (isMetaTask) {
		return [];
	}

	return [
		{
			hooks: [
				async (_input, _toolUseID, _options): Promise<SDKHookOutput> => {
					// Allow stopping if agent reported task is already complete
					if (state.taskAlreadyCompleteReason) {
						sessionLogger.info(
							{ reason: state.taskAlreadyCompleteReason },
							"Stop hook accepted: task already complete",
						);
						return { continue: true };
					}

					// Allow stopping if we detected no-op edits (content was already correct)
					if (state.noOpEditCount > 0 && state.writeCountThisExecution === 0) {
						sessionLogger.info(
							{ noOpEdits: state.noOpEditCount },
							"Stop hook accepted: no-op edits detected (content already correct)",
						);
						return { continue: true };
					}

					// No writes made - provide feedback
					if (state.writeCountThisExecution === 0) {
						state.consecutiveNoWriteAttempts++;
						sessionLogger.info(
							{
								model: state.currentModel,
								writes: 0,
								consecutiveNoWrites: state.consecutiveNoWriteAttempts,
							},
							"Stop hook rejected: agent tried to finish with 0 writes",
						);

						// FAIL FAST: After 3 no-write attempts, terminate immediately
						if (state.consecutiveNoWriteAttempts >= 3) {
							sessionLogger.warn(
								{
									consecutiveNoWrites: state.consecutiveNoWriteAttempts,
									model: state.currentModel,
								},
								"FAIL FAST: 3+ consecutive no-write attempts - terminating to save tokens",
							);
							throw new Error(
								`VAGUE_TASK: Agent attempted to finish ${state.consecutiveNoWriteAttempts} times without making changes. ` +
									"Task likely needs decomposition into more specific subtasks.",
							);
						}

						// Provide escalating feedback
						const reason =
							state.consecutiveNoWriteAttempts === 2
								? "You still haven't made any code changes. If you're unsure what to modify:\n" +
									"- Re-read the task to identify the specific file and change needed\n" +
									"- If the task is unclear, output: NEEDS_DECOMPOSITION: <what clarification or subtasks are needed>\n" +
									"- If already complete: TASK_ALREADY_COMPLETE: <reason>"
								: "You haven't made any code changes yet. If the task is already complete, output: TASK_ALREADY_COMPLETE: <reason>. Otherwise, implement the required changes.";

						return { continue: false, reason };
					}

					return { continue: true };
				},
			],
		},
	];
}

// =============================================================================
// Message Processing
// =============================================================================

/**
 * Stream agent message to console
 */
function streamMessage(message: unknown, model: ModelTier): void {
	const msg = message as Record<string, unknown>;
	const prefix = chalk.dim(`[${model}]`);

	if (msg.type === "content_block_start") {
		const contentBlock = msg.content_block as { type?: string; name?: string } | undefined;
		if (contentBlock?.type === "tool_use" && contentBlock.name) {
			dualLogger.writeLine(`${prefix} ${chalk.yellow(contentBlock.name)}`);
		}
	}

	if (msg.type === "result" && msg.subtype === "success") {
		dualLogger.writeLine(`${prefix} ${chalk.green("✓")} Done`);
	}
}

/**
 * Track write operations from SDK messages
 */
function trackWriteOperations(
	message: unknown,
	state: AgentLoopState,
	pendingWriteTools: Map<string, PendingWriteTool>,
	maxWritesPerFile: number,
): void {
	const msg = message as Record<string, unknown>;

	// Check assistant messages for task markers and write tool requests
	if (msg.type === "assistant") {
		const betaMessage = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
		if (betaMessage?.content) {
			const currentMarkers: TaskMarkers = {
				taskAlreadyComplete: state.taskAlreadyCompleteReason ?? undefined,
				invalidTarget: state.invalidTargetReason ?? undefined,
				needsDecomposition: state.needsDecompositionReason ?? undefined,
			};
			const updatedMarkers = processAssistantMessage(
				betaMessage.content as unknown as Parameters<typeof processAssistantMessage>[0],
				currentMarkers,
				pendingWriteTools,
			);
			// Update state from markers
			if (updatedMarkers.taskAlreadyComplete && !state.taskAlreadyCompleteReason) {
				state.taskAlreadyCompleteReason = updatedMarkers.taskAlreadyComplete;
			}
			if (updatedMarkers.invalidTarget && !state.invalidTargetReason) {
				state.invalidTargetReason = updatedMarkers.invalidTarget;
			}
			if (updatedMarkers.needsDecomposition && !state.needsDecompositionReason) {
				state.needsDecompositionReason = updatedMarkers.needsDecomposition;
			}
		}
	}

	// Check for tool results (success or failure)
	if (msg.type === "user") {
		const userMessage = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
		if (userMessage?.content) {
			const writeState: WriteTrackingState = {
				writeCount: state.writeCountThisExecution,
				consecutiveNoWriteAttempts: state.consecutiveNoWriteAttempts,
				noOpEditCount: state.noOpEditCount,
				writesPerFile: state.writesPerFile,
			};
			processUserMessage(
				userMessage.content as unknown as Parameters<typeof processUserMessage>[0],
				pendingWriteTools,
				writeState,
				maxWritesPerFile,
			);
			// Update state from write tracking
			state.writeCountThisExecution = writeState.writeCount;
			state.consecutiveNoWriteAttempts = writeState.consecutiveNoWriteAttempts;
			state.noOpEditCount = writeState.noOpEditCount;
		}
	}
}

/**
 * Handle SDK error subtypes distinctly
 */
function handleAgentErrorSubtype(resultData: ResultMessageData, state: AgentLoopState): void {
	const { errorSubtype, errors, numTurns } = resultData;

	switch (errorSubtype) {
		case "error_max_turns":
			sessionLogger.warn(
				{
					model: state.currentModel,
					turns: numTurns,
					taskId: state.currentTaskId,
				},
				`Agent hit maxTurns limit (${numTurns} turns) - task may need decomposition or model escalation`,
			);
			// Track this as a potential signal for task complexity
			if (!state.needsDecompositionReason) {
				state.needsDecompositionReason = `Agent exhausted ${numTurns} turns without completing task`;
			}
			break;

		case "error_max_budget_usd":
			// This shouldn't happen with Claude Max, but log if it does
			sessionLogger.error(
				{
					model: state.currentModel,
					taskId: state.currentTaskId,
				},
				"Agent hit budget limit - unexpected with Claude Max plan",
			);
			break;

		case "error_during_execution":
			sessionLogger.error(
				{
					model: state.currentModel,
					taskId: state.currentTaskId,
					errors: errors ?? [],
				},
				`Agent execution error: ${errors?.join("; ") ?? "unknown error"}`,
			);
			break;

		default:
			// Unknown error subtype
			if (errorSubtype) {
				sessionLogger.warn(
					{
						subtype: errorSubtype,
						model: state.currentModel,
						taskId: state.currentTaskId,
					},
					`Unknown SDK error subtype: ${errorSubtype}`,
				);
			}
	}
}

// =============================================================================
// Prompt Building
// =============================================================================

/**
 * Build the prompt for agent execution
 */
function buildPrompt(
	context: AgentLoopContext,
	state: AgentLoopState,
	config: AgentLoopConfig,
	deps: AgentLoopDependencies,
): { prompt: string; resumePrompt?: string; injectedLearningIds: string[] } {
	const metaType = state.isCurrentTaskMeta ? extractMetaTaskType(context.task) : null;

	// Check if this is a retry with an existing session to resume
	const isRetry = state.attempts > 1 && state.lastFeedback;
	const canResume = isRetry && state.currentAgentSessionId && !state.lastPostMortem;

	if (canResume && state.lastFeedback) {
		// Resume with verification feedback
		const resumePrompt = buildResumePrompt(state.lastFeedback);
		sessionLogger.info(
			{ sessionId: state.currentAgentSessionId, attempt: state.attempts },
			"Resuming agent session with verification feedback",
		);
		return { prompt: "", resumePrompt, injectedLearningIds: [] };
	}

	if (state.isCurrentTaskMeta && metaType) {
		// Meta-task prompt
		const prompt = buildMetaTaskPrompt(
			metaType,
			context.task,
			config.workingDirectory,
			state.attempts,
			state.lastFeedback,
		);
		return { prompt, injectedLearningIds: [] };
	}

	if (state.isCurrentTaskResearch) {
		// Research task prompt
		const prompt = buildResearchPrompt(
			context.task,
			state.attempts,
			state.lastFeedback,
			state.consecutiveNoWriteAttempts,
		);
		return { prompt, injectedLearningIds: [] };
	}

	// Standard implementation task: build prompt with context
	const contextResult = buildImplementationContext({
		task: context.task,
		stateDir: config.stateDir,
		workingDirectory: config.workingDirectory,
		assignmentContext: deps.buildAssignmentContext(),
		handoffContextSection: context.handoffContext ? deps.buildHandoffContextSection() : undefined,
		briefing: context.briefing,
		executionPlan: context.executionPlan,
		lastPostMortem: state.lastPostMortem,
		errorHistory: context.errorHistory,
		ticket: context.ticket,
	});

	return {
		prompt: contextResult.prompt,
		injectedLearningIds: contextResult.injectedLearningIds,
	};
}

// =============================================================================
// Main Execution
// =============================================================================

/**
 * Execute the agent loop on current task.
 *
 * Uses session resume on retry to preserve agent's exploration work.
 * Instead of starting fresh, we continue the conversation with feedback.
 */
export async function runAgentLoop(
	context: AgentLoopContext,
	state: AgentLoopState,
	config: AgentLoopConfig,
	deps: AgentLoopDependencies,
): Promise<AgentLoopResult> {
	let result = "";

	// Build prompt
	const { prompt, resumePrompt, injectedLearningIds } = buildPrompt(context, state, config, deps);
	state.injectedLearningIds = injectedLearningIds;

	// Clear post-mortem after use - only applies to first attempt at new tier
	if (state.lastPostMortem && !resumePrompt) {
		state.lastPostMortem = undefined;
	}

	// Reset counters for this execution
	state.writeCountThisExecution = 0;
	state.writesPerFile.clear();
	state.noOpEditCount = 0;
	state.taskAlreadyCompleteReason = null;
	state.invalidTargetReason = null;
	state.needsDecompositionReason = null;

	// Build stop hooks
	const stopHooks = buildStopHooks(state, state.isCurrentTaskMeta);

	// Set maxTurns based on model tier
	const maxTurns = getMaxTurnsForModel(state.currentModel);
	sessionLogger.debug({ model: state.currentModel, maxTurns }, `Agent maxTurns: ${maxTurns}`);

	// Build PreToolUse hooks for bash auditing
	const preToolUseHooks = createPreToolUseHooks(state.currentTaskId, config.auditBash);

	// Build task context for system prompt preset
	const taskContextForPrompt = config.useSystemPromptPreset
		? `\n\n## Current Task\n${context.task}${context.executionPlan ? `\n\n## Plan\n${context.executionPlan.plan}` : ""}`
		: undefined;

	// Build query options
	const queryOptions = buildQueryOptions({
		modelName: MODEL_NAMES[state.currentModel],
		workingDirectory: config.workingDirectory,
		maxTurns,
		stopHooks,
		isOpus: state.currentModel === "opus",
		preToolUseHooks,
		useSystemPromptPreset: config.useSystemPromptPreset,
		taskContextForPrompt,
	});

	// Build query params
	const canResume = !!resumePrompt;
	const queryParams = buildQueryParams(canResume, state.currentAgentSessionId, resumePrompt, prompt, queryOptions);

	// Log prompt size
	const promptSize = prompt?.length || resumePrompt?.length || 0;
	sessionLogger.info({ promptSize, hasContext: !!context.briefing }, `Agent prompt size: ${promptSize} chars`);

	// Pending write tools for tracking
	const pendingWriteTools: Map<string, PendingWriteTool> = new Map();

	// Message timing for performance analysis
	const timing = createMessageTiming();

	// Execute agent query loop
	for await (const message of query(queryParams)) {
		timing.msgCount++;
		const msg = message as Record<string, unknown>;

		// Log slow messages
		logSlowMessageGap(msg, timing);
		timing.lastMsgTime = Date.now();

		// Track token usage
		const usage = deps.extractTokenUsage(message);
		if (usage) {
			deps.recordTokenUsage(message, state.currentModel);
			state.tokenUsageThisTask.push(usage);
		}

		// Track write operations
		trackWriteOperations(message, state, pendingWriteTools, config.maxWritesPerFile);

		// Stream output if enabled
		if (config.stream) {
			streamMessage(message, state.currentModel);
		}

		if (message.type === "result") {
			const resultData = extractResultMessageData(msg);

			// Capture session ID for potential resume
			if (!state.currentAgentSessionId && resultData.conversationId) {
				state.currentAgentSessionId = resultData.conversationId;
				sessionLogger.debug({ sessionId: state.currentAgentSessionId }, "Captured agent session ID for resume");
			}

			// Capture turn count
			state.lastAgentTurns = resultData.numTurns;

			// Record SDK metrics
			recordAgentQueryResult(resultData, state.lastAgentTurns, state.currentModel);

			if (resultData.isSuccess) {
				result = resultData.result;
			} else {
				handleAgentErrorSubtype(resultData, state);
			}
		}
	}

	// Store output for knowledge extraction
	state.lastAgentOutput = result;

	// Parse task markers from result
	const markers = parseResultMarkers(result);
	if (markers.taskAlreadyComplete && !state.taskAlreadyCompleteReason) {
		state.taskAlreadyCompleteReason = markers.taskAlreadyComplete;
		sessionLogger.info({ reason: markers.taskAlreadyComplete }, "Agent reported task already complete");
	}
	if (markers.invalidTarget && !state.invalidTargetReason) {
		state.invalidTargetReason = markers.invalidTarget;
		sessionLogger.warn({ reason: markers.invalidTarget }, "Agent reported invalid target");
	}
	if (markers.needsDecomposition && !state.needsDecompositionReason) {
		state.needsDecompositionReason = markers.needsDecomposition;
		sessionLogger.info({ reason: markers.needsDecomposition }, "Agent reported task needs decomposition");
	}

	// Capture decisions from output
	captureDecisionsFromOutput(
		result,
		state.currentTaskId,
		parseAgentOutputForDecisions,
		captureDecision,
		config.stateDir,
	);

	return {
		output: result,
		turns: state.lastAgentTurns,
		reportedComplete: state.taskAlreadyCompleteReason !== null,
		reportedInvalidTarget: state.invalidTargetReason !== null,
		needsDecomposition: state.needsDecompositionReason !== null,
	};
}
