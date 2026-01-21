/**
 * Worker Agent Execution Helpers
 *
 * Extracted helpers for executeAgent to reduce complexity.
 */

import type { TokenUsage, ModelTier } from "../types.js";
import { sessionLogger } from "../logger.js";
import { recordQueryResult } from "../live-metrics.js";
import { parseTaskMarkers, type TaskMarkers } from "./message-tracker.js";

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
	hooks?: {
		Stop: Array<{ hooks: Array<() => Promise<{ continue: boolean; reason?: string }>> }>;
	};
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
export function logSlowMessageGap(
	message: Record<string, unknown>,
	timing: MessageTiming,
): void {
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
}

/**
 * Extract data from SDK result message
 */
export function extractResultMessageData(message: Record<string, unknown>): ResultMessageData {
	const usageData = message.usage as Record<string, number> | undefined;
	const modelUsage = message.modelUsage as Record<string, Record<string, number>> | undefined;

	return {
		result: message.subtype === "success" ? (message.result as string) : "",
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
		isSuccess: message.subtype === "success",
	};
}

/**
 * Record query result to live metrics
 */
export function recordAgentQueryResult(
	data: ResultMessageData,
	turns: number,
	model: ModelTier,
): void {
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
export function updateStateWithMarkers(
	state: ExecutionState,
	markers: TaskMarkers,
): void {
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
