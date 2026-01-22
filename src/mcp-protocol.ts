/**
 * MCP Protocol Handler
 *
 * Implements Model Context Protocol (MCP) JSON-RPC 2.0 for knowledge tools.
 * Bridges incoming tool requests to knowledge module functions and returns
 * formatted responses following the MCP specification.
 *
 * Protocol: JSON-RPC 2.0
 * - Request: { jsonrpc: "2.0", id, method, params? }
 * - Response: { jsonrpc: "2.0", id, result } | { jsonrpc: "2.0", id, error }
 * - Notification: { jsonrpc: "2.0", method, params? } (no id, no response)
 *
 * @see https://modelcontextprotocol.io/specification/2025-11-25
 * @see https://www.jsonrpc.org/specification
 */

import {
	addLearning,
	findRelevantLearnings,
	getKnowledgeStats,
	type LearningCategory,
	markLearningsUsed,
} from "./knowledge.js";
import { serverLogger } from "./logger.js";
import { knowledgeTools, type MCPTool, oracleTools } from "./mcp-tools.js";
import { type OracleCard, UndercityOracle } from "./oracle.js";

const _MCP_VERSION = "2025-11-25";
const JSONRPC_VERSION = "2.0";

/**
 * JSON-RPC 2.0 Request
 */
export interface JSONRPCRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 Success Response
 */
export interface JSONRPCSuccessResponse {
	jsonrpc: "2.0";
	id: string | number;
	result: unknown;
}

/**
 * JSON-RPC 2.0 Error Response
 */
export interface JSONRPCErrorResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	error: {
		code: number;
		message: string;
		data?: unknown;
	};
}

/**
 * JSON-RPC 2.0 error codes
 */
export const JSONRPCErrorCode = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
} as const;

/**
 * MCP Protocol Handler
 */
export class MCPProtocolHandler {
	private stateDir: string;
	private oracle: UndercityOracle;

	constructor(stateDir: string = ".undercity") {
		this.stateDir = stateDir;
		this.oracle = new UndercityOracle();
	}

	/**
	 * List all available tools (MCP tools/list method)
	 */
	listTools(): MCPTool[] {
		return [...knowledgeTools, ...oracleTools];
	}

	/**
	 * Handle a tool call request
	 */
	async handleToolCall(toolName: string, params: Record<string, unknown>): Promise<unknown> {
		serverLogger.debug({ toolName, params }, "MCP tool call");

		switch (toolName) {
			case "knowledge_search":
				return this.handleKnowledgeSearch(params);
			case "knowledge_add":
				return this.handleKnowledgeAdd(params);
			case "knowledge_stats":
				return this.handleKnowledgeStats(params);
			case "knowledge_mark_used":
				return this.handleKnowledgeMarkUsed(params);
			case "oracle_search":
				return this.handleOracleSearch(params);
			default:
				throw new Error(`Unknown tool: ${toolName}`);
		}
	}

	/**
	 * Handle knowledge search request
	 */
	private handleKnowledgeSearch(params: Record<string, unknown>): unknown {
		const query = params.query;
		const maxResults = params.maxResults ?? 5;

		if (typeof query !== "string") {
			throw new Error("Invalid params: query must be a string");
		}

		if (typeof maxResults !== "number" || maxResults < 1 || maxResults > 20) {
			throw new Error("Invalid params: maxResults must be a number between 1 and 20");
		}

		const learnings = findRelevantLearnings(query, maxResults, this.stateDir);

		return {
			query,
			maxResults,
			count: learnings.length,
			learnings: learnings.map((l) => ({
				id: l.id,
				taskId: l.taskId,
				category: l.category,
				content: l.content,
				keywords: l.keywords,
				confidence: l.confidence,
				usedCount: l.usedCount,
				successCount: l.successCount,
				structured: l.structured,
			})),
		};
	}

	/**
	 * Handle knowledge add request
	 */
	private handleKnowledgeAdd(params: Record<string, unknown>): unknown {
		const { taskId, category, content, keywords, structured } = params;

		if (typeof taskId !== "string") {
			throw new Error("Invalid params: taskId must be a string");
		}

		if (!["pattern", "gotcha", "preference", "fact"].includes(category as string)) {
			throw new Error("Invalid params: category must be one of: pattern, gotcha, preference, fact");
		}

		if (typeof content !== "string") {
			throw new Error("Invalid params: content must be a string");
		}

		if (!Array.isArray(keywords) || !keywords.every((k) => typeof k === "string")) {
			throw new Error("Invalid params: keywords must be an array of strings");
		}

		// Validate structured data if provided
		if (structured !== undefined) {
			if (typeof structured !== "object" || structured === null) {
				throw new Error("Invalid params: structured must be an object");
			}

			const struct = structured as Record<string, unknown>;
			if (struct.file !== undefined && typeof struct.file !== "string") {
				throw new Error("Invalid params: structured.file must be a string");
			}
			if (struct.pattern !== undefined && typeof struct.pattern !== "string") {
				throw new Error("Invalid params: structured.pattern must be a string");
			}
			if (struct.approach !== undefined && typeof struct.approach !== "string") {
				throw new Error("Invalid params: structured.approach must be a string");
			}
		}

		const result = addLearning(
			{
				taskId,
				category: category as LearningCategory,
				content,
				keywords: keywords as string[],
				structured: structured as
					| {
							file?: string;
							pattern?: string;
							approach?: string;
					  }
					| undefined,
			},
			this.stateDir,
		);

		return {
			success: true,
			added: result.added,
			noveltyScore: result.noveltyScore,
			learning: {
				id: result.learning.id,
				taskId: result.learning.taskId,
				category: result.learning.category,
				content: result.learning.content,
				keywords: result.learning.keywords,
				confidence: result.learning.confidence,
				createdAt: result.learning.createdAt,
			},
		};
	}

	/**
	 * Handle knowledge stats request
	 */
	private handleKnowledgeStats(_params: Record<string, unknown>): unknown {
		const stats = getKnowledgeStats(this.stateDir);

		return {
			totalLearnings: stats.totalLearnings,
			byCategory: stats.byCategory,
			avgConfidence: Math.round(stats.avgConfidence * 100) / 100,
			mostUsed: stats.mostUsed,
		};
	}

	/**
	 * Handle knowledge mark used request
	 */
	private handleKnowledgeMarkUsed(params: Record<string, unknown>): unknown {
		const { learningIds, taskSuccess } = params;

		if (!Array.isArray(learningIds) || !learningIds.every((id) => typeof id === "string")) {
			throw new Error("Invalid params: learningIds must be an array of strings");
		}

		if (typeof taskSuccess !== "boolean") {
			throw new Error("Invalid params: taskSuccess must be a boolean");
		}

		markLearningsUsed(learningIds as string[], taskSuccess, this.stateDir);

		return {
			success: true,
			updated: learningIds.length,
			taskSuccess,
		};
	}

	/**
	 * Handle oracle search request
	 */
	private handleOracleSearch(params: Record<string, unknown>): unknown {
		const { query, category } = params;

		if (typeof query !== "string") {
			throw new Error("Invalid params: query must be a string");
		}

		// Validate category if provided
		if (category !== undefined) {
			const validCategories = ["questioning", "action", "perspective", "disruption", "exploration"];
			if (typeof category !== "string" || !validCategories.includes(category)) {
				throw new Error(`Invalid params: category must be one of: ${validCategories.join(", ")}`);
			}
		}

		const cards = this.oracle.searchCards(query, category as OracleCard["category"] | undefined);

		return {
			query,
			category: category ?? null,
			count: cards.length,
			cards: cards.map((card) => ({
				text: card.text,
				category: card.category,
				loreContext: card.loreContext ?? null,
			})),
		};
	}

	/**
	 * Handle JSON-RPC 2.0 request
	 */
	async handleRequest(request: JSONRPCRequest): Promise<JSONRPCSuccessResponse | JSONRPCErrorResponse> {
		try {
			// Validate JSON-RPC version
			if (request.jsonrpc !== JSONRPC_VERSION) {
				return this.errorResponse(request.id, JSONRPCErrorCode.INVALID_REQUEST, "Invalid JSON-RPC version");
			}

			// Handle different methods
			let result: unknown;

			if (request.method === "tools/list") {
				result = this.listTools();
			} else if (request.method === "tools/call") {
				const params = request.params ?? {};
				const toolName = params.name;

				if (typeof toolName !== "string") {
					return this.errorResponse(request.id, JSONRPCErrorCode.INVALID_PARAMS, "Missing tool name");
				}

				const toolParams = (params.arguments as Record<string, unknown>) ?? {};
				result = await this.handleToolCall(toolName, toolParams);
			} else {
				return this.errorResponse(request.id, JSONRPCErrorCode.METHOD_NOT_FOUND, `Method not found: ${request.method}`);
			}

			return this.successResponse(request.id, result);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Internal error";
			serverLogger.error({ error, request }, "MCP request error");
			return this.errorResponse(request.id, JSONRPCErrorCode.INTERNAL_ERROR, message);
		}
	}

	/**
	 * Create a success response
	 */
	private successResponse(id: string | number, result: unknown): JSONRPCSuccessResponse {
		return {
			jsonrpc: JSONRPC_VERSION,
			id,
			result,
		};
	}

	/**
	 * Create an error response
	 */
	private errorResponse(
		id: string | number | null,
		code: number,
		message: string,
		data?: unknown,
	): JSONRPCErrorResponse {
		return {
			jsonrpc: JSONRPC_VERSION,
			id,
			error: {
				code,
				message,
				data,
			},
		};
	}
}

/**
 * Parse and handle MCP request from raw body
 */
export async function handleMCPRequest(body: string, stateDir?: string): Promise<string> {
	try {
		const request = JSON.parse(body) as JSONRPCRequest;
		const handler = new MCPProtocolHandler(stateDir);
		const response = await handler.handleRequest(request);
		return JSON.stringify(response);
	} catch (_error) {
		// Parse error
		const errorResponse: JSONRPCErrorResponse = {
			jsonrpc: JSONRPC_VERSION,
			id: null,
			error: {
				code: JSONRPCErrorCode.PARSE_ERROR,
				message: "Parse error",
			},
		};
		return JSON.stringify(errorResponse);
	}
}
