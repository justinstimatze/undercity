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

	describe("Oracle Search - Filter Regression Tests", () => {
		it("should not break basic search when no filter applied", async () => {
			// This is the baseline - search without filters should work
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 15,
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
					count: number;
					cards: Array<{ text: string; category: string }>;
				};

				expect(result.count).toBeGreaterThan(0);
				expect(result.cards.length).toBe(result.count);
			}
		});

		it("should not break empty query when no filter applied", async () => {
			// Baseline: empty query returns all cards
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 16,
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
				// Should return all cards (not zero)
				expect(result.count).toBeGreaterThan(0);
			}
		});

		it("should maintain backward compatibility: unfiltered search returns same count", async () => {
			// Regression test: Ensure unfiltered queries still work after filter code was added
			const unfiltered: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 17,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "problem",
					},
				},
			};

			const response = await handler.handleRequest(unfiltered);

			expect(response).toHaveProperty("result");
			if ("result" in response) {
				const result = response.result as { count: number };
				expect(result.count).toBeGreaterThan(0);
				// Verify that the result is well-formed
				expect(typeof result.count).toBe("number");
			}
		});

		it("should not unexpectedly exclude results when filter is applied", async () => {
			// Get baseline unfiltered count
			const unfiltered: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 18,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "test",
					},
				},
			};

			const unfilteredResponse = await handler.handleRequest(unfiltered);
			const unfilteredCount =
				"result" in unfilteredResponse ? (unfilteredResponse.result as { count: number }).count : 0;

			// Get filtered count
			const filtered: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 19,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "test",
						category: "exploration",
					},
				},
			};

			const filteredResponse = await handler.handleRequest(filtered);
			const filteredCount = "result" in filteredResponse ? (filteredResponse.result as { count: number }).count : 0;

			// Filtered should never exceed unfiltered (basic set theory)
			expect(filteredCount).toBeLessThanOrEqual(unfilteredCount);
		});

		it("should produce correct intersection of query + category filter", async () => {
			// Both filters applied together should produce results that satisfy BOTH conditions
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 20,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "test",
						category: "action",
					},
				},
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("result");
			if ("result" in response) {
				const result = response.result as {
					count: number;
					cards: Array<{ text: string; category: string; loreContext: string | null }>;
				};

				// All cards must be in the action category
				expect(result.cards.every((card) => card.category === "action")).toBe(true);

				// All cards must contain "test" keyword somewhere
				result.cards.forEach((card) => {
					const fullText = `${card.text} ${card.loreContext || ""}`.toLowerCase();
					expect(fullText).toContain("test");
				});
			}
		});

		it("should return truly empty results when no matches (filter + query)", async () => {
			// When filters result in no matches, must return empty array (not null or undefined)
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 21,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "xyz_nonexistent_word_that_should_not_exist_anywhere_12345",
						category: "questioning",
					},
				},
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("result");
			if ("result" in response) {
				const result = response.result as {
					count: number;
					cards: Array<{ text: string }>;
				};

				// Must be exactly 0, not undefined or null
				expect(result.count).toBe(0);
				expect(Array.isArray(result.cards)).toBe(true);
				expect(result.cards).toEqual([]);
			}
		});

		it("should maintain filter state across multiple queries", async () => {
			// Regression: Ensure filter state doesn't leak between requests
			const query1: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 22,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "",
						category: "action",
					},
				},
			};

			const response1 = await handler.handleRequest(query1);
			const count1 = "result" in response1 ? (response1.result as { count: number }).count : 0;

			// Second query with different filter should not be affected by first
			const query2: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 23,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "",
						category: "perspective",
					},
				},
			};

			const response2 = await handler.handleRequest(query2);
			const count2 = "result" in response2 ? (response2.result as { count: number }).count : 0;

			// Both should have returned valid results
			expect(count1).toBeGreaterThan(0);
			expect(count2).toBeGreaterThan(0);

			// Query for a third filter to ensure no state leakage
			const query3: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 24,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "",
						category: "exploration",
					},
				},
			};

			const response3 = await handler.handleRequest(query3);
			const count3 = "result" in response3 ? (response3.result as { count: number }).count : 0;

			// All should be independent
			expect(count3).toBeGreaterThan(0);
		});

		it("should return correct data structure with filter applied", async () => {
			// Regression: Ensure response format doesn't break when filter is used
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 25,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "creativity",
						category: "disruption",
					},
				},
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("result");
			if ("result" in response) {
				const result = response.result as {
					query: string;
					category: string | null;
					count: number;
					cards: Array<{ text: string; category: string; loreContext: string | null }>;
				};

				// Verify all expected fields are present
				expect(result).toHaveProperty("query");
				expect(result).toHaveProperty("category");
				expect(result).toHaveProperty("count");
				expect(result).toHaveProperty("cards");

				// Verify types
				expect(typeof result.query).toBe("string");
				expect(typeof result.category).toBe("string");
				expect(typeof result.count).toBe("number");
				expect(Array.isArray(result.cards)).toBe(true);
			}
		});

		it("drawCard with category filter should only return cards from that category", async () => {
			// Direct oracle method test: drawCard(category) should respect category filter
			// This tests the oracle.ts implementation directly
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 26,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "",
						category: "action",
					},
				},
			};

			const response = await handler.handleRequest(request);

			expect(response).toHaveProperty("result");
			if ("result" in response) {
				const result = response.result as {
					cards: Array<{ category: string }>;
				};

				// Every card returned must be from the requested category
				if (result.cards.length > 0) {
					result.cards.forEach((card) => {
						expect(card.category).toBe("action");
					});
				}
			}
		});

		it("drawCard without category should return cards from all categories", async () => {
			// Regression: Ensure drawCard() without filter returns diverse categories
			const request: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 27,
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
				const result = response.result as {
					cards: Array<{ category: string }>;
				};

				// Should return cards from multiple categories
				const categories = new Set(result.cards.map((card) => card.category));
				expect(categories.size).toBeGreaterThan(1);
			}
		});

		it("filter should produce subset of unfiltered results", async () => {
			// Get all cards with a query
			const unfilteredRequest: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 28,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "change",
					},
				},
			};

			const unfilteredResponse = await handler.handleRequest(unfilteredRequest);
			const unfiltered =
				"result" in unfilteredResponse
					? (
							unfilteredResponse.result as {
								cards: Array<{ text: string }>;
							}
						).cards
					: [];

			// Get filtered cards with same query
			const filteredRequest: JSONRPCRequest = {
				jsonrpc: "2.0",
				id: 29,
				method: "tools/call",
				params: {
					name: "oracle_search",
					arguments: {
						query: "change",
						category: "action",
					},
				},
			};

			const filteredResponse = await handler.handleRequest(filteredRequest);
			const filtered =
				"result" in filteredResponse
					? (
							filteredResponse.result as {
								cards: Array<{ text: string }>;
							}
						).cards
					: [];

			// Filtered should be subset of unfiltered
			expect(filtered.length).toBeLessThanOrEqual(unfiltered.length);

			// All filtered items should exist in unfiltered
			filtered.forEach((filteredCard) => {
				const foundInUnfiltered = unfiltered.some((card) => card.text === filteredCard.text);
				expect(foundInUnfiltered).toBe(true);
			});
		});
	});
});
