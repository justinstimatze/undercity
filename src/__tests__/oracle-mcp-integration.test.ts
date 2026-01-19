import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JSONRPCRequest } from "../mcp-protocol.js";
import { MCPProtocolHandler } from "../mcp-protocol.js";

describe("Oracle MCP Integration", () => {
	let handler: MCPProtocolHandler;

	beforeEach(() => {
		handler = new MCPProtocolHandler(".undercity");
	});

	afterEach(() => {
		// Cleanup if needed
	});

	describe("Tool Discovery", () => {
		it("should list oracle_search tool in tools/list", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("result");
			if ("result" in response) {
				const tools = response.result as Array<{ name: string }>;
				const oracleTool = tools.find((t) => t.name === "oracle_search");

				expect(oracleTool).toBeDefined();
				expect(oracleTool).toHaveProperty("description");
				expect(oracleTool).toHaveProperty("inputSchema");
			}
		});
	});

	describe("Oracle Search - Basic Queries", () => {
		it("should search oracle cards by keyword", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "assumption",
					},
				},
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("result");
			if ("result" in response) {
				const result = response.result as {
					query: string;
					count: number;
					cards: Array<{ text: string; category: string; loreContext: string | null }>;
				};

				expect(result.query).toBe("assumption");
				expect(result.count).toBeGreaterThan(0);
				expect(result.cards).toBeInstanceOf(Array);
				expect(result.cards[0]).toHaveProperty("text");
				expect(result.cards[0]).toHaveProperty("category");
			}
		});

		it("should search oracle cards case-insensitively", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "ASSUMPTION",
					},
				},
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("result");
			if ("result" in response) {
				const result = response.result as { count: number };
				expect(result.count).toBeGreaterThan(0);
			}
		});

		it("should return empty results for non-matching query", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "xyznonexistentkeyword123",
					},
				},
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("result");
			if ("result" in response) {
				const result = response.result as { count: number; cards: unknown[] };
				expect(result.count).toBe(0);
				expect(result.cards).toEqual([]);
			}
		});
	});

	describe("Oracle Search - Category Filtering", () => {
		it("should filter cards by category", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "",
						category: "questioning",
					},
				},
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("result");
			if ("result" in response) {
				const result = response.result as {
					category: string;
					count: number;
					cards: Array<{ category: string }>;
				};

				expect(result.category).toBe("questioning");
				expect(result.count).toBeGreaterThan(0);
				expect(result.cards.every((card) => card.category === "questioning")).toBe(true);
			}
		});

		it("should combine query and category filter", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 6,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "pattern",
						category: "exploration",
					},
				},
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("result");
			if ("result" in response) {
				const result = response.result as {
					count: number;
					cards: Array<{ category: string; text: string; loreContext: string | null }>;
				};

				// Should only return cards that match both query and category
				expect(result.cards.every((card) => card.category === "exploration")).toBe(true);
				expect(
					result.cards.every(
						(card) =>
							card.text.toLowerCase().includes("pattern") || card.loreContext?.toLowerCase().includes("pattern"),
					),
				).toBe(true);
			}
		});

		it("should reject invalid category", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 7,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "test",
						category: "invalid_category",
					},
				},
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("error");
			if ("error" in response) {
				expect(response.error.message).toContain("category must be one of");
			}
		});
	});

	describe("Oracle Search - Multiple Keywords", () => {
		it("should match cards with any keyword in multi-word query", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 8,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "error test",
					},
				},
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("result");
			if ("result" in response) {
				const result = response.result as {
					count: number;
					cards: Array<{ text: string; loreContext: string | null }>;
				};

				expect(result.count).toBeGreaterThan(0);
				// Each card should contain at least one of the keywords
				expect(
					result.cards.every(
						(card) =>
							card.text.toLowerCase().includes("error") ||
							card.text.toLowerCase().includes("test") ||
							card.loreContext?.toLowerCase().includes("error") ||
							card.loreContext?.toLowerCase().includes("test"),
					),
				).toBe(true);
			}
		});
	});

	describe("Oracle Search - Response Format", () => {
		it("should return well-formed JSON-RPC response", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 9,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "assumption",
					},
				},
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("jsonrpc", "2.0");
			expect(response).toHaveProperty("id", 9);
			expect(response).toHaveProperty("result");
		});

		it("should include all expected fields in card objects", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 10,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "assumption",
					},
				},
			};

			const response = await handler.handleRequest(request);

			if ("result" in response) {
				const result = response.result as {
					cards: Array<{ text: string; category: string; loreContext: string | null }>;
				};

				if (result.cards.length > 0) {
					const card = result.cards[0];
					expect(card).toHaveProperty("text");
					expect(card).toHaveProperty("category");
					expect(card).toHaveProperty("loreContext");
					expect(typeof card.text).toBe("string");
					expect(typeof card.category).toBe("string");
					// loreContext can be string or null
					expect(typeof card.loreContext === "string" || card.loreContext === null).toBe(true);
				}
			}
		});
	});

	describe("Oracle Search - Error Handling", () => {
		it("should reject missing query parameter", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 11,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {},
				},
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("error");
			if ("error" in response) {
				expect(response.error.message).toContain("query must be a string");
			}
		});

		it("should reject non-string query", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 12,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: 123,
					},
				},
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("error");
			if ("error" in response) {
				expect(response.error.message).toContain("query must be a string");
			}
		});
	});

	describe("Oracle Search - Edge Cases", () => {
		it("should handle empty query string", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 13,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "",
					},
				},
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("result");
			if ("result" in response) {
				const result = response.result as { count: number };
				// Empty query should return all cards
				expect(result.count).toBeGreaterThan(0);
			}
		});

		it("should handle whitespace-only query", async () => {
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 14,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "   ",
					},
				},
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("result");
			if ("result" in response) {
				const result = response.result as { count: number };
				// Whitespace-only query should be treated as empty
				expect(result.count).toBeGreaterThan(0);
			}
		});
	});
});
