/**
 * Tests for MCP Protocol Handler
 *
 * Tests the Model Context Protocol (MCP) JSON-RPC 2.0 implementation for knowledge tools.
 * Validates tool discovery, request handling, error cases, and integration with knowledge module.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addLearning } from "../knowledge.js";
import {
	handleMCPRequest,
	JSONRPCErrorCode,
	type JSONRPCErrorResponse,
	type JSONRPCRequest,
	type JSONRPCSuccessResponse,
	MCPProtocolHandler,
} from "../mcp-protocol.js";
import { knowledgeTools } from "../mcp-tools.js";

describe("mcp-protocol.ts", () => {
	let tempDir: string;
	let handler: MCPProtocolHandler;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
		handler = new MCPProtocolHandler(tempDir);
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ==========================================================================
	// Tool Discovery Tests
	// ==========================================================================

	describe("Tool Discovery", () => {
		it("should list all available tools", () => {
			const tools = handler.listTools();

			// Should include both knowledge tools and oracle tools
			expect(tools.length).toBe(5); // 4 knowledge + 1 oracle

			// Verify knowledge tools are included
			const knowledgeToolNames = knowledgeTools.map((t) => t.name);
			const toolNames = tools.map((t) => t.name);
			for (const name of knowledgeToolNames) {
				expect(toolNames).toContain(name);
			}

			// Verify oracle tool is included
			expect(toolNames).toContain("oracle_search");
		});

		it("should include knowledge_search tool", () => {
			const tools = handler.listTools();
			const searchTool = tools.find((t) => t.name === "knowledge_search");

			expect(searchTool).toBeDefined();
			expect(searchTool?.description).toContain("Search");
			expect(searchTool?.inputSchema.properties.query).toBeDefined();
		});

		it("should include knowledge_add tool", () => {
			const tools = handler.listTools();
			const addTool = tools.find((t) => t.name === "knowledge_add");

			expect(addTool).toBeDefined();
			expect(addTool?.description).toContain("Add");
			expect(addTool?.inputSchema.properties.taskId).toBeDefined();
		});

		it("should include knowledge_stats tool", () => {
			const tools = handler.listTools();
			const statsTool = tools.find((t) => t.name === "knowledge_stats");

			expect(statsTool).toBeDefined();
			expect(statsTool?.description).toContain("statistics");
		});

		it("should include knowledge_mark_used tool", () => {
			const tools = handler.listTools();
			const markUsedTool = tools.find((t) => t.name === "knowledge_mark_used");

			expect(markUsedTool).toBeDefined();
			expect(markUsedTool?.description).toContain("Mark learnings");
		});
	});

	// ==========================================================================
	// JSON-RPC Request Handling Tests
	// ==========================================================================

	describe("JSON-RPC Request Handling", () => {
		it("should handle tools/list request", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
			};

			const response = (await handler.handleRequest(request)) as JSONRPCSuccessResponse;

			expect(response.jsonrpc).toBe("2.0");
			expect(response.id).toBe(1);
			expect(Array.isArray(response.result)).toBe(true);
		});

		it("should reject invalid JSON-RPC version", async () => {
			const request = {
				jsonrpc: "1.0",
				id: 1,
				method: "tools/list",
			} as unknown as JSONRPCRequest;

			const response = (await handler.handleRequest(request)) as JSONRPCErrorResponse;

			expect(response.error.code).toBe(JSONRPCErrorCode.INVALID_REQUEST);
			expect(response.error.message).toContain("JSON-RPC version");
		});

		it("should return error for unknown method", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 1,
				method: "unknown/method",
			};

			const response = (await handler.handleRequest(request)) as JSONRPCErrorResponse;

			expect(response.error.code).toBe(JSONRPCErrorCode.METHOD_NOT_FOUND);
			expect(response.error.message).toContain("Method not found");
		});

		it("should handle tools/call for knowledge_search", async () => {
			// Add some test data first
			addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "Use Zod for validation",
					keywords: ["zod", "validation"],
				},
				tempDir,
			);

			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: {
					name: "knowledge_search",
					arguments: {
						query: "validation",
						maxResults: 5,
					},
				},
			};

			const response = (await handler.handleRequest(request)) as JSONRPCSuccessResponse;

			expect(response.jsonrpc).toBe("2.0");
			expect(response.id).toBe(2);
			expect(response.result).toBeDefined();

			const result = response.result as { learnings: unknown[] };
			expect(result.learnings).toBeDefined();
		});

		it("should return error for missing tool name", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: {
					arguments: { query: "test" },
				},
			};

			const response = (await handler.handleRequest(request)) as JSONRPCErrorResponse;

			expect(response.error.code).toBe(JSONRPCErrorCode.INVALID_PARAMS);
			expect(response.error.message).toContain("tool name");
		});

		it("should handle string IDs in requests", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: "string-id-123",
				method: "tools/list",
			};

			const response = (await handler.handleRequest(request)) as JSONRPCSuccessResponse;

			expect(response.id).toBe("string-id-123");
		});
	});

	// ==========================================================================
	// Knowledge Search Tool Tests
	// ==========================================================================

	describe("Knowledge Search Tool", () => {
		beforeEach(() => {
			// Add test learnings
			addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "Use Zod for API validation",
					keywords: ["zod", "validation", "api"],
				},
				tempDir,
			);

			addLearning(
				{
					taskId: "task-2",
					category: "gotcha",
					content: "ESM imports need .js extension",
					keywords: ["esm", "import", "extension"],
				},
				tempDir,
			);
		});

		it("should search and return relevant learnings", async () => {
			const result = await handler.handleToolCall("knowledge_search", {
				query: "validation api",
				maxResults: 5,
			});

			const searchResult = result as { learnings: unknown[]; query: string };
			expect(searchResult.query).toBe("validation api");
			expect(searchResult.learnings).toBeDefined();
			expect(Array.isArray(searchResult.learnings)).toBe(true);
		});

		it("should validate query parameter is string", async () => {
			await expect(
				handler.handleToolCall("knowledge_search", {
					query: 123,
					maxResults: 5,
				}),
			).rejects.toThrow("query must be a string");
		});

		it("should validate maxResults is number", async () => {
			await expect(
				handler.handleToolCall("knowledge_search", {
					query: "test",
					maxResults: "five",
				}),
			).rejects.toThrow("maxResults must be a number");
		});

		it("should validate maxResults range", async () => {
			await expect(
				handler.handleToolCall("knowledge_search", {
					query: "test",
					maxResults: 25,
				}),
			).rejects.toThrow("between 1 and 20");
		});

		it("should use default maxResults if not provided", async () => {
			const result = await handler.handleToolCall("knowledge_search", {
				query: "test",
			});

			const searchResult = result as { maxResults: number };
			expect(searchResult.maxResults).toBe(5);
		});
	});

	// ==========================================================================
	// Knowledge Add Tool Tests
	// ==========================================================================

	describe("Knowledge Add Tool", () => {
		it("should add a new learning", async () => {
			const result = await handler.handleToolCall("knowledge_add", {
				taskId: "task-123",
				category: "pattern",
				content: "Test learning content",
				keywords: ["test", "learning"],
			});

			const addResult = result as { success: boolean; learning: { id: string } };
			expect(addResult.success).toBe(true);
			expect(addResult.learning.id).toMatch(/^learn-/);
		});

		it("should validate taskId is string", async () => {
			await expect(
				handler.handleToolCall("knowledge_add", {
					taskId: 123,
					category: "pattern",
					content: "Test",
					keywords: ["test"],
				}),
			).rejects.toThrow("taskId must be a string");
		});

		it("should validate category is valid enum", async () => {
			await expect(
				handler.handleToolCall("knowledge_add", {
					taskId: "task-1",
					category: "invalid-category",
					content: "Test",
					keywords: ["test"],
				}),
			).rejects.toThrow("category must be one of");
		});

		it("should validate content is string", async () => {
			await expect(
				handler.handleToolCall("knowledge_add", {
					taskId: "task-1",
					category: "pattern",
					content: 123,
					keywords: ["test"],
				}),
			).rejects.toThrow("content must be a string");
		});

		it("should validate keywords is array of strings", async () => {
			await expect(
				handler.handleToolCall("knowledge_add", {
					taskId: "task-1",
					category: "pattern",
					content: "Test",
					keywords: "not-an-array",
				}),
			).rejects.toThrow("keywords must be an array");
		});

		it("should accept valid structured data", async () => {
			const result = await handler.handleToolCall("knowledge_add", {
				taskId: "task-1",
				category: "pattern",
				content: "Test with structured data",
				keywords: ["test"],
				structured: {
					file: "src/test.ts",
					pattern: "const x = 1;",
					approach: "Simple approach",
				},
			});

			const addResult = result as { success: boolean };
			expect(addResult.success).toBe(true);
		});

		it("should validate structured.file is string if provided", async () => {
			await expect(
				handler.handleToolCall("knowledge_add", {
					taskId: "task-1",
					category: "pattern",
					content: "Test",
					keywords: ["test"],
					structured: {
						file: 123,
					},
				}),
			).rejects.toThrow("structured.file must be a string");
		});
	});

	// ==========================================================================
	// Knowledge Stats Tool Tests
	// ==========================================================================

	describe("Knowledge Stats Tool", () => {
		it("should return stats for empty knowledge base", async () => {
			const result = await handler.handleToolCall("knowledge_stats", {});

			const stats = result as { totalLearnings: number };
			expect(stats.totalLearnings).toBe(0);
		});

		it("should return stats after adding learnings", async () => {
			addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "Test 1",
					keywords: ["test"],
				},
				tempDir,
			);

			addLearning(
				{
					taskId: "task-2",
					category: "fact",
					content: "Test 2",
					keywords: ["test"],
				},
				tempDir,
			);

			const result = await handler.handleToolCall("knowledge_stats", {});

			const stats = result as {
				totalLearnings: number;
				byCategory: Record<string, number>;
				avgConfidence: number;
			};
			expect(stats.totalLearnings).toBe(2);
			expect(stats.byCategory.pattern).toBe(1);
			expect(stats.byCategory.fact).toBe(1);
			expect(stats.avgConfidence).toBeGreaterThan(0);
		});

		it("should round avgConfidence to 2 decimal places", async () => {
			addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "Test",
					keywords: ["test"],
				},
				tempDir,
			);

			const result = await handler.handleToolCall("knowledge_stats", {});

			const stats = result as { avgConfidence: number };
			const decimalPlaces = stats.avgConfidence.toString().split(".")[1]?.length || 0;
			expect(decimalPlaces).toBeLessThanOrEqual(2);
		});
	});

	// ==========================================================================
	// Knowledge Mark Used Tool Tests
	// ==========================================================================

	describe("Knowledge Mark Used Tool", () => {
		let learningId: string;

		beforeEach(async () => {
			const learning = addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "Test learning",
					keywords: ["test"],
				},
				tempDir,
			);
			learningId = learning.id;
		});

		it("should mark learning as used successfully", async () => {
			const result = await handler.handleToolCall("knowledge_mark_used", {
				learningIds: [learningId],
				taskSuccess: true,
			});

			const markResult = result as { success: boolean; updated: number; taskSuccess: boolean };
			expect(markResult.success).toBe(true);
			expect(markResult.updated).toBe(1);
			expect(markResult.taskSuccess).toBe(true);
		});

		it("should mark learning as used with failure", async () => {
			const result = await handler.handleToolCall("knowledge_mark_used", {
				learningIds: [learningId],
				taskSuccess: false,
			});

			const markResult = result as { taskSuccess: boolean };
			expect(markResult.taskSuccess).toBe(false);
		});

		it("should validate learningIds is array of strings", async () => {
			await expect(
				handler.handleToolCall("knowledge_mark_used", {
					learningIds: "not-an-array",
					taskSuccess: true,
				}),
			).rejects.toThrow("learningIds must be an array");
		});

		it("should validate taskSuccess is boolean", async () => {
			await expect(
				handler.handleToolCall("knowledge_mark_used", {
					learningIds: [learningId],
					taskSuccess: "yes",
				}),
			).rejects.toThrow("taskSuccess must be a boolean");
		});

		it("should handle multiple learning IDs", async () => {
			const learning2 = addLearning(
				{
					taskId: "task-2",
					category: "fact",
					content: "Test 2",
					keywords: ["test"],
				},
				tempDir,
			);

			const result = await handler.handleToolCall("knowledge_mark_used", {
				learningIds: [learningId, learning2.id],
				taskSuccess: true,
			});

			const markResult = result as { updated: number };
			expect(markResult.updated).toBe(2);
		});

		it("should handle empty learningIds array", async () => {
			const result = await handler.handleToolCall("knowledge_mark_used", {
				learningIds: [],
				taskSuccess: true,
			});

			const markResult = result as { updated: number };
			expect(markResult.updated).toBe(0);
		});
	});

	// ==========================================================================
	// Unknown Tool Tests
	// ==========================================================================

	describe("Unknown Tool Handling", () => {
		it("should throw error for unknown tool", async () => {
			await expect(handler.handleToolCall("unknown_tool", {})).rejects.toThrow("Unknown tool");
		});
	});

	// ==========================================================================
	// handleMCPRequest Tests
	// ==========================================================================

	describe("handleMCPRequest", () => {
		it("should parse and handle valid JSON-RPC request", async () => {
			const request = {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
			};

			const responseStr = await handleMCPRequest(JSON.stringify(request), tempDir);
			const response = JSON.parse(responseStr) as JSONRPCSuccessResponse;

			expect(response.jsonrpc).toBe("2.0");
			expect(response.id).toBe(1);
			expect(response.result).toBeDefined();
		});

		it("should return parse error for invalid JSON", async () => {
			const responseStr = await handleMCPRequest("invalid json", tempDir);
			const response = JSON.parse(responseStr) as JSONRPCErrorResponse;

			expect(response.error.code).toBe(JSONRPCErrorCode.PARSE_ERROR);
			expect(response.id).toBeNull();
		});

		it("should handle internal errors gracefully", async () => {
			const request = {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "knowledge_search",
					arguments: {
						query: "test",
						maxResults: 999,
					},
				},
			};

			const responseStr = await handleMCPRequest(JSON.stringify(request), tempDir);
			const response = JSON.parse(responseStr) as JSONRPCErrorResponse;

			expect(response.error.code).toBe(JSONRPCErrorCode.INTERNAL_ERROR);
		});
	});

	// ==========================================================================
	// Integration Tests
	// ==========================================================================

	describe("Integration: Full MCP Workflow", () => {
		it("should support complete tool workflow", async () => {
			// 1. List tools
			const listRequest: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
			};
			const listResponse = (await handler.handleRequest(listRequest)) as JSONRPCSuccessResponse;
			expect(Array.isArray(listResponse.result)).toBe(true);

			// 2. Add a learning
			const addRequest: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: {
					name: "knowledge_add",
					arguments: {
						taskId: "task-integration",
						category: "pattern",
						content: "Integration test learning",
						keywords: ["integration", "test"],
					},
				},
			};
			const addResponse = (await handler.handleRequest(addRequest)) as JSONRPCSuccessResponse;
			const addResult = addResponse.result as { success: boolean; learning: { id: string } };
			expect(addResult.success).toBe(true);

			// 3. Search for the learning
			const searchRequest: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: {
					name: "knowledge_search",
					arguments: {
						query: "integration test",
						maxResults: 5,
					},
				},
			};
			const searchResponse = (await handler.handleRequest(searchRequest)) as JSONRPCSuccessResponse;
			const searchResult = searchResponse.result as { learnings: Array<{ id: string }> };
			expect(searchResult.learnings.length).toBeGreaterThan(0);

			// 4. Mark as used
			const markRequest: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: {
					name: "knowledge_mark_used",
					arguments: {
						learningIds: [addResult.learning.id],
						taskSuccess: true,
					},
				},
			};
			const markResponse = (await handler.handleRequest(markRequest)) as JSONRPCSuccessResponse;
			const markResult = markResponse.result as { success: boolean };
			expect(markResult.success).toBe(true);

			// 5. Get stats
			const statsRequest: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: {
					name: "knowledge_stats",
					arguments: {},
				},
			};
			const statsResponse = (await handler.handleRequest(statsRequest)) as JSONRPCSuccessResponse;
			const statsResult = statsResponse.result as { totalLearnings: number };
			expect(statsResult.totalLearnings).toBeGreaterThan(0);
		});
	});
});
