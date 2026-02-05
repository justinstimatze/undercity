/**
 * Worker Agent Execution Helpers
 *
 * Extracted helpers for executeAgent to reduce complexity.
 */

import { recordQueryResult } from "../live-metrics.js";
import { sessionLogger } from "../logger.js";
import type { ModelTier } from "../types.js";
import { parseTaskMarkers, type TaskMarkers } from "./message-tracker.js";

/**
 * SDK hook input types (simplified for our use cases)
 * Full types are in @anthropic-ai/claude-agent-sdk
 */
export interface SDKPreToolUseHookInput {
	hook_event_name: "PreToolUse";
	tool_name: string;
	tool_input: unknown;
	tool_use_id: string;
	session_id: string;
	transcript_path: string;
	cwd: string;
	permission_mode?: string;
}

export interface SDKStopHookInput {
	hook_event_name: "Stop";
	session_id: string;
	transcript_path: string;
	cwd: string;
	permission_mode?: string;
}

/**
 * SDK hook output type (synchronous)
 */
export interface SDKHookOutput {
	continue?: boolean;
	decision?: "approve" | "block";
	reason?: string;
	stopReason?: string;
	suppressOutput?: boolean;
	hookSpecificOutput?: {
		hookEventName: "PreToolUse";
		permissionDecision?: "allow" | "deny" | "ask";
		permissionDecisionReason?: string;
	};
}

/**
 * SDK hook callback type
 */
export type SDKHookCallback = (
	input: SDKPreToolUseHookInput | SDKStopHookInput,
	toolUseID: string | undefined,
	options: { signal: AbortSignal },
) => Promise<SDKHookOutput>;

/**
 * System prompt configuration options
 *
 * Either use a preset (like claude_code) or provide a custom system prompt.
 */
export type SystemPromptConfig =
	| { type: "preset"; preset: "claude_code"; append?: string }
	| { type: "custom"; content: string };

/**
 * Hook event types supported by the SDK
 */
export type HookEvent =
	| "PreToolUse"
	| "PostToolUse"
	| "PostToolUseFailure"
	| "Notification"
	| "UserPromptSubmit"
	| "SessionStart"
	| "SessionEnd"
	| "Stop"
	| "SubagentStart"
	| "SubagentStop"
	| "PreCompact"
	| "PermissionRequest";

/**
 * SDK query options for agent execution
 */
export interface AgentQueryOptions {
	model: string;
	permissionMode: "bypassPermissions";
	allowDangerouslySkipPermissions: true;
	settingSources: ("project" | "user")[];
	cwd: string;
	maxTurns: number;
	disallowedTools: string[];
	/** Limit thinking tokens for Opus extended thinking (cost control) */
	maxThinkingTokens?: number;
	/** System prompt configuration (preset or custom) */
	systemPrompt?: SystemPromptConfig;
	/** Hooks for agent execution */
	hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
}

/**
 * Execution state that gets reset each agent run
 */
export interface ExecutionState {
	writeCountThisExecution: number;
	writesPerFile: Map<string, number>;
	noOpEditCount: number;
	taskAlreadyCompleteReason: string | null;
	invalidTargetReason: string | null;
	needsDecompositionReason: string | null;
}

/**
 * Reset execution state for a new agent run
 */
export function createFreshExecutionState(): ExecutionState {
	return {
		writeCountThisExecution: 0,
		writesPerFile: new Map(),
		noOpEditCount: 0,
		taskAlreadyCompleteReason: null,
		invalidTargetReason: null,
		needsDecompositionReason: null,
	};
}

/**
 * Message timing tracker for performance analysis
 */
export interface MessageTiming {
	queryStart: number;
	lastMsgTime: number;
	msgCount: number;
}

/**
 * Create initial message timing state
 */
export function createMessageTiming(): MessageTiming {
	const now = Date.now();
	return {
		queryStart: now,
		lastMsgTime: now,
		msgCount: 0,
	};
}

/**
 * Log slow message gaps (>5s between messages)
 */
export function logSlowMessageGap(message: Record<string, unknown>, timing: MessageTiming): void {
	const now = Date.now();
	const delta = now - timing.lastMsgTime;
	const msgType = message.type as string;

	if (delta > 5000) {
		const subtype = message.subtype as string | undefined;
		const toolName =
			msgType === "assistant"
				? ((message.message as Record<string, unknown>)?.content as Array<{ type: string; name?: string }>)?.find(
						(c) => c.type === "tool_use",
					)?.name
				: undefined;

		sessionLogger.info(
			{
				msgCount: timing.msgCount,
				msgType,
				subtype,
				toolName,
				deltaMs: delta,
				totalMs: now - timing.queryStart,
			},
			`Slow message gap: ${delta}ms waiting for ${msgType}${toolName ? `:${toolName}` : ""}`,
		);
	}
}

/**
 * SDK result subtypes for error classification
 * - success: Task completed successfully
 * - error_max_turns: Hit maxTurns limit
 * - error_max_budget_usd: Hit budget limit (not applicable for Claude Max)
 * - error_during_execution: Error during agent execution
 */
export type ResultSubtype = "success" | "error_max_turns" | "error_max_budget_usd" | "error_during_execution";

/**
 * Result message data extracted from SDK response
 */
export interface ResultMessageData {
	result: string;
	conversationId?: string;
	numTurns: number;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens: number;
		cacheCreationInputTokens: number;
	};
	modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; costUSD?: number }>;
	totalCostUsd: number;
	durationMs: number;
	apiDurationMs: number;
	isSuccess: boolean;
	/** SDK error subtype when isSuccess is false */
	errorSubtype?: ResultSubtype;
	/** Error details array from SDK (for error_during_execution) */
	errors?: string[];
}

/**
 * Extract data from SDK result message
 */
export function extractResultMessageData(message: Record<string, unknown>): ResultMessageData {
	const usageData = message.usage as Record<string, number> | undefined;
	const modelUsage = message.modelUsage as Record<string, Record<string, number>> | undefined;
	const subtype = message.subtype as ResultSubtype | undefined;
	const isSuccess = subtype === "success";

	// Extract errors array for error_during_execution
	const errorsRaw = message.errors as Array<unknown> | undefined;
	const errors = errorsRaw?.map((e) => String(e));

	return {
		result: isSuccess ? (message.result as string) : "",
		conversationId: message.conversationId as string | undefined,
		numTurns: (message.num_turns as number) ?? 0,
		usage: usageData
			? {
					inputTokens: usageData.inputTokens ?? 0,
					outputTokens: usageData.outputTokens ?? 0,
					cacheReadInputTokens: usageData.cacheReadInputTokens ?? 0,
					cacheCreationInputTokens: usageData.cacheCreationInputTokens ?? 0,
				}
			: undefined,
		modelUsage: modelUsage as ResultMessageData["modelUsage"],
		totalCostUsd: (message.total_cost_usd as number) ?? 0,
		durationMs: (message.duration_ms as number) ?? 0,
		apiDurationMs: (message.duration_api_ms as number) ?? 0,
		isSuccess,
		errorSubtype: isSuccess ? undefined : subtype,
		errors,
	};
}

/**
 * Record query result to live metrics
 */
export function recordAgentQueryResult(data: ResultMessageData, turns: number, model: ModelTier): void {
	recordQueryResult({
		success: data.isSuccess,
		rateLimited: !data.isSuccess && data.result.includes("rate"),
		inputTokens: data.usage?.inputTokens ?? 0,
		outputTokens: data.usage?.outputTokens ?? 0,
		cacheReadTokens: data.usage?.cacheReadInputTokens ?? 0,
		cacheCreationTokens: data.usage?.cacheCreationInputTokens ?? 0,
		costUsd: data.totalCostUsd,
		durationMs: data.durationMs,
		apiDurationMs: data.apiDurationMs,
		turns,
		model,
		modelUsage: data.modelUsage,
	});
}

/**
 * Parse task markers from agent result string
 */
export function parseResultMarkers(result: string): TaskMarkers {
	return parseTaskMarkers(result);
}

/**
 * Update execution state with markers from result
 */
export function updateStateWithMarkers(state: ExecutionState, markers: TaskMarkers): void {
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
}

/**
 * Default disallowed tools for agent execution
 */
export const DISALLOWED_GIT_PUSH_TOOLS = [
	"Bash(git push)",
	"Bash(git push *)",
	"Bash(git push -*)",
	"Bash(git remote push)",
];

/**
 * Legacy thinking token cap (no longer applied)
 *
 * Opus 4.6 uses adaptive thinking which self-selects reasoning depth.
 * Hardcoded caps hinder this. On Claude Max (flat rate), removing the cap
 * has zero cost implication. Kept for reference only.
 */
export const LEGACY_MAX_THINKING_TOKENS = 16000;

/**
 * Hook callback matcher structure (matches SDK's HookCallbackMatcher)
 */
export interface HookCallbackMatcher {
	matcher?: string;
	hooks: SDKHookCallback[];
	timeout?: number;
}

/**
 * Parameters for building query options
 */
export interface QueryOptionsParams {
	modelName: string;
	workingDirectory: string;
	maxTurns: number;
	stopHooks: HookCallbackMatcher[];
	/** Max thinking tokens (undefined = no cap, let adaptive thinking work) */
	maxThinkingTokens?: number;
	/** PreToolUse hooks for security auditing */
	preToolUseHooks?: HookCallbackMatcher[];
	/** Use SDK systemPrompt preset (experimental) */
	useSystemPromptPreset?: boolean;
	/** Task context to append to system prompt when using preset */
	taskContextForPrompt?: string;
}

/**
 * Build query options for SDK agent execution
 *
 * Note: We use type assertions for hooks because the SDK's internal types
 * (HookCallbackMatcher, HookCallback, HookInput) are not exported directly,
 * and our compatible types don't match structurally. The runtime behavior is correct.
 */
export function buildQueryOptions(params: QueryOptionsParams): Record<string, unknown> {
	const {
		modelName,
		workingDirectory,
		maxTurns,
		stopHooks,
		maxThinkingTokens,
		preToolUseHooks,
		useSystemPromptPreset,
		taskContextForPrompt,
	} = params;

	// Build hooks object only if we have any hooks
	const hasStopHooks = stopHooks.length > 0;
	const hasPreToolUseHooks = preToolUseHooks && preToolUseHooks.length > 0;
	const hooks =
		hasStopHooks || hasPreToolUseHooks
			? {
					...(hasStopHooks ? { Stop: stopHooks } : {}),
					...(hasPreToolUseHooks ? { PreToolUse: preToolUseHooks } : {}),
				}
			: undefined;

	// Build system prompt config if using preset
	const systemPrompt: SystemPromptConfig | undefined = useSystemPromptPreset
		? { type: "preset", preset: "claude_code", append: taskContextForPrompt }
		: undefined;

	return {
		model: modelName,
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
		settingSources: ["project"],
		cwd: workingDirectory,
		maxTurns,
		disallowedTools: DISALLOWED_GIT_PUSH_TOOLS,
		maxThinkingTokens,
		systemPrompt,
		hooks,
	};
}

/**
 * Build query params based on whether we're resuming or starting fresh
 */
/**
 * Query parameters for SDK agent execution
 * Uses Record<string, unknown> for options to allow SDK type checking at runtime
 */
export type QueryParamsResult =
	| { prompt: string; options: Record<string, unknown> }
	| { resume: string; prompt: string; options: Record<string, unknown> };

/**
 * Build query parameters for SDK agent execution
 */
export function buildQueryParams(
	canResume: boolean,
	sessionId: string | null | undefined,
	resumePrompt: string | undefined,
	prompt: string,
	queryOptions: Record<string, unknown>,
): QueryParamsResult {
	if (canResume && sessionId && resumePrompt) {
		return { resume: sessionId, prompt: resumePrompt, options: queryOptions };
	}
	return { prompt, options: queryOptions };
}

/**
 * Capture decision points from agent output
 */
export function captureDecisionsFromOutput(
	result: string,
	taskId: string,
	parseAgentOutputForDecisions: (
		result: string,
		taskId: string,
	) => Array<{
		question: string;
		context: string;
		options?: string[];
	}>,
	captureDecision: (
		taskId: string,
		question: string,
		context: string,
		options: string[],
		stateDir: string,
	) => { id: string; category: string },
	stateDir: string,
): void {
	try {
		const decisions = parseAgentOutputForDecisions(result, taskId);
		for (const d of decisions) {
			const captured = captureDecision(taskId, d.question, d.context, d.options ?? [], stateDir);
			sessionLogger.debug(
				{ decisionId: captured.id, category: captured.category },
				"Captured decision point from agent output",
			);
		}
	} catch {
		// Non-critical - continue without decision capture
	}
}
