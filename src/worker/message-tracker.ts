/**
 * Worker Message Tracker
 *
 * Extracted message tracking logic from TaskWorker to reduce complexity.
 * Handles parsing SDK messages for task markers and write operations.
 */

import { sessionLogger } from "../logger.js";

/**
 * Task markers that can appear in agent output
 */
export interface TaskMarkers {
	taskAlreadyComplete?: string;
	invalidTarget?: string;
	needsDecomposition?: string;
}

/**
 * Pending write tool awaiting result
 */
export interface PendingWriteTool {
	name: string;
	filePath?: string;
}

/**
 * Write tracking state (mutable, owned by caller)
 */
export interface WriteTrackingState {
	writeCount: number;
	consecutiveNoWriteAttempts: number;
	noOpEditCount: number;
	writesPerFile: Map<string, number>;
}

/**
 * Result of processing a tool result
 */
export interface ToolResultOutcome {
	succeeded: boolean;
	isNoOp: boolean;
	filePath: string;
	fileWriteCount: number;
}

/**
 * Content block from assistant message
 */
interface AssistantContentBlock {
	type: string;
	text?: string;
	name?: string;
	id?: string;
	input?: { file_path?: string };
}

/**
 * Content block from user message (tool result)
 */
interface ToolResultBlock {
	type: string;
	tool_use_id?: string;
	content?: string | Array<string | { text?: string }>;
	is_error?: boolean;
}

/**
 * Parse task markers from text content
 */
export function parseTaskMarkers(text: string): TaskMarkers {
	const markers: TaskMarkers = {};

	const completeMatch = text.match(/TASK_ALREADY_COMPLETE:\s*(.+?)(?:\n|$)/i);
	if (completeMatch) {
		markers.taskAlreadyComplete = completeMatch[1].trim();
	}

	const invalidMatch = text.match(/INVALID_TARGET:\s*(.+?)(?:\n|$)/i);
	if (invalidMatch) {
		markers.invalidTarget = invalidMatch[1].trim();
	}

	const decompMatch = text.match(/NEEDS_DECOMPOSITION:\s*(.+?)(?:\n|$)/i);
	if (decompMatch) {
		markers.needsDecomposition = decompMatch[1].trim();
	}

	return markers;
}

/**
 * Extract write tool requests from assistant message content
 */
export function extractWriteToolRequests(content: AssistantContentBlock[]): Map<string, PendingWriteTool> {
	const pending = new Map<string, PendingWriteTool>();
	const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"];

	for (const block of content) {
		if (block.type === "tool_use" && block.name && block.id) {
			if (WRITE_TOOLS.includes(block.name)) {
				const filePath = block.input?.file_path;
				pending.set(block.id, { name: block.name, filePath });
				sessionLogger.debug({ tool: block.name, filePath, toolId: block.id }, "Write tool requested");
			}
		}
	}

	return pending;
}

/**
 * Normalize tool result content to string
 */
function normalizeToolResultContent(content: ToolResultBlock["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content.map((c) => (typeof c === "string" ? c : c.text || "")).join("");
	}
	return "";
}

/**
 * Determine if write tool succeeded based on result content
 */
function didWriteSucceed(isError: boolean, contentStr: string): boolean {
	if (isError) return false;

	// Only count as error if it's a tool_use_error, not just contains "error" in success message
	const contentHasError =
		contentStr.includes("<tool_use_error>") ||
		(contentStr.toLowerCase().includes("error") && !contentStr.toLowerCase().includes("successfully"));

	return !contentHasError;
}

/**
 * Check if edit was a no-op (content already correct)
 */
function isNoOpEdit(contentStr: string): boolean {
	return (
		contentStr.includes("exactly the same") ||
		contentStr.includes("No changes to make") ||
		contentStr.includes("already exists")
	);
}

/**
 * Process a tool result block and update write tracking state
 *
 * @returns Outcome if this was a tracked write tool, null otherwise
 */
export function processToolResult(
	block: ToolResultBlock,
	pendingWriteTools: Map<string, PendingWriteTool>,
	state: WriteTrackingState,
	maxWritesPerFile: number,
): ToolResultOutcome | null {
	if (block.type !== "tool_result" || !block.tool_use_id) {
		return null;
	}

	const pendingTool = pendingWriteTools.get(block.tool_use_id);
	if (!pendingTool) {
		return null;
	}

	pendingWriteTools.delete(block.tool_use_id);

	const isError = block.is_error === true;
	const contentStr = normalizeToolResultContent(block.content);
	const succeeded = didWriteSucceed(isError, contentStr);
	const filePath = pendingTool.filePath || "unknown";

	if (succeeded) {
		state.writeCount++;
		state.consecutiveNoWriteAttempts = 0;

		const fileWriteCount = (state.writesPerFile.get(filePath) || 0) + 1;
		state.writesPerFile.set(filePath, fileWriteCount);

		sessionLogger.debug(
			{
				tool: pendingTool.name,
				filePath: pendingTool.filePath,
				writeCount: state.writeCount,
				fileWriteCount,
			},
			`Write succeeded (total: ${state.writeCount}, file: ${fileWriteCount})`,
		);

		// Check for file thrashing
		if (fileWriteCount >= maxWritesPerFile) {
			sessionLogger.warn(
				{
					filePath,
					writeCount: fileWriteCount,
					maxAllowed: maxWritesPerFile,
				},
				"File thrashing detected - too many writes to same file without progress",
			);
		}

		return { succeeded: true, isNoOp: false, filePath, fileWriteCount };
	}

	// Handle failure case
	const noOp = isNoOpEdit(contentStr);
	if (noOp) {
		state.noOpEditCount++;
		sessionLogger.debug(
			{
				tool: pendingTool.name,
				filePath: pendingTool.filePath,
				noOpCount: state.noOpEditCount,
			},
			"No-op edit detected (content already correct)",
		);
	} else {
		sessionLogger.debug(
			{
				tool: pendingTool.name,
				filePath: pendingTool.filePath,
				isError,
				contentPreview: contentStr.slice(0, 100),
			},
			"Write tool FAILED - not counting",
		);
	}

	return {
		succeeded: false,
		isNoOp: noOp,
		filePath,
		fileWriteCount: state.writesPerFile.get(filePath) || 0,
	};
}

/**
 * Process assistant message for task markers and write tool requests
 */
export function processAssistantMessage(
	content: AssistantContentBlock[],
	currentMarkers: TaskMarkers,
	pendingWriteTools: Map<string, PendingWriteTool>,
): TaskMarkers {
	const updatedMarkers = { ...currentMarkers };

	for (const block of content) {
		// Check text blocks for task markers
		if (block.type === "text" && block.text) {
			const parsed = parseTaskMarkers(block.text);

			if (parsed.taskAlreadyComplete && !updatedMarkers.taskAlreadyComplete) {
				updatedMarkers.taskAlreadyComplete = parsed.taskAlreadyComplete;
				sessionLogger.info({ reason: parsed.taskAlreadyComplete }, "Agent reported task already complete (streaming)");
			}

			if (parsed.invalidTarget && !updatedMarkers.invalidTarget) {
				updatedMarkers.invalidTarget = parsed.invalidTarget;
				sessionLogger.warn({ reason: parsed.invalidTarget }, "Agent reported invalid target (streaming)");
			}

			if (parsed.needsDecomposition && !updatedMarkers.needsDecomposition) {
				updatedMarkers.needsDecomposition = parsed.needsDecomposition;
				sessionLogger.info({ reason: parsed.needsDecomposition }, "Agent reported needs decomposition (streaming)");
			}
		}

		// Track write tool requests
		if (block.type === "tool_use" && block.name && block.id) {
			const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"];
			if (WRITE_TOOLS.includes(block.name)) {
				const filePath = block.input?.file_path;
				pendingWriteTools.set(block.id, { name: block.name, filePath });
				sessionLogger.debug({ tool: block.name, filePath, toolId: block.id }, "Write tool requested");
			}
		}
	}

	return updatedMarkers;
}

/**
 * Process user message for tool results
 */
export function processUserMessage(
	content: ToolResultBlock[],
	pendingWriteTools: Map<string, PendingWriteTool>,
	state: WriteTrackingState,
	maxWritesPerFile: number,
): ToolResultOutcome[] {
	const outcomes: ToolResultOutcome[] = [];

	for (const block of content) {
		const outcome = processToolResult(block, pendingWriteTools, state, maxWritesPerFile);
		if (outcome) {
			outcomes.push(outcome);
		}
	}

	return outcomes;
}
