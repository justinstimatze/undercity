/**
 * MCP Tool Definitions
 *
 * Defines knowledge management tools for exposure through Model Context Protocol (MCP).
 * These tools allow Claude Code to discover, search, and manage accumulated learnings
 * from task history using the MCP JSON-RPC protocol.
 *
 * Tools:
 * - knowledge_search: Find relevant learnings by keywords
 * - knowledge_add: Add a new learning to the knowledge base
 * - knowledge_stats: Get statistics about the knowledge base
 * - knowledge_mark_used: Mark learnings as used with success/failure feedback
 *
 * @see https://modelcontextprotocol.io/specification/2025-11-25
 */

/**
 * MCP tool definition following JSON-RPC protocol
 */
export interface MCPTool {
	/** Unique tool name */
	name: string;
	/** Human-readable description */
	description: string;
	/** JSON Schema defining input parameters */
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
}

/**
 * Knowledge search tool - Find relevant learnings
 */
export const knowledgeSearchTool: MCPTool = {
	name: "knowledge_search",
	description:
		"Search the knowledge base for relevant learnings from previous tasks. Returns learnings ranked by keyword match and confidence score.",
	inputSchema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "Search query describing the task or problem (keywords will be extracted automatically)",
			},
			maxResults: {
				type: "number",
				description: "Maximum number of results to return (default: 5)",
				default: 5,
				minimum: 1,
				maximum: 20,
			},
		},
		required: ["query"],
	},
};

/**
 * Knowledge add tool - Add a new learning
 */
export const knowledgeAddTool: MCPTool = {
	name: "knowledge_add",
	description:
		"Add a new learning to the knowledge base from a completed task. Learnings are automatically deduplicated.",
	inputSchema: {
		type: "object",
		properties: {
			taskId: {
				type: "string",
				description: "ID of the task that produced this learning",
			},
			category: {
				type: "string",
				enum: ["pattern", "gotcha", "preference", "fact"],
				description:
					"Category: pattern (reusable approach), gotcha (edge case/warning), preference (style choice), fact (constant/config)",
			},
			content: {
				type: "string",
				description: "Natural language description of the learning (what was learned)",
			},
			keywords: {
				type: "array",
				items: { type: "string" },
				description: "Keywords for retrieval (lowercase, no stopwords)",
			},
			structured: {
				type: "object",
				description: "Optional structured data for code patterns",
				properties: {
					file: {
						type: "string",
						description: "File path where pattern applies",
					},
					pattern: {
						type: "string",
						description: "Code pattern or example",
					},
					approach: {
						type: "string",
						description: "Approach or strategy description",
					},
				},
			},
		},
		required: ["taskId", "category", "content", "keywords"],
	},
};

/**
 * Knowledge stats tool - Get knowledge base statistics
 */
export const knowledgeStatsTool: MCPTool = {
	name: "knowledge_stats",
	description:
		"Get statistics about the knowledge base including total learnings, category breakdown, average confidence, and most used learnings.",
	inputSchema: {
		type: "object",
		properties: {},
	},
};

/**
 * Knowledge mark used tool - Track learning usage
 */
export const knowledgeMarkUsedTool: MCPTool = {
	name: "knowledge_mark_used",
	description:
		"Mark learnings as used for a task with success/failure feedback. Updates confidence scores based on task outcome.",
	inputSchema: {
		type: "object",
		properties: {
			learningIds: {
				type: "array",
				items: { type: "string" },
				description: "Array of learning IDs that were used",
			},
			taskSuccess: {
				type: "boolean",
				description: "Whether the task succeeded (true) or failed (false)",
			},
		},
		required: ["learningIds", "taskSuccess"],
	},
};

/**
 * All available knowledge tools
 */
export const knowledgeTools: MCPTool[] = [
	knowledgeSearchTool,
	knowledgeAddTool,
	knowledgeStatsTool,
	knowledgeMarkUsedTool,
];
