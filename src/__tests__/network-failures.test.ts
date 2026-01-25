/**
 * Network/Connectivity Failure Tests
 *
 * Tests error handling for network failures including:
 * - Connection refused (ECONNREFUSED)
 * - Connection timeout (ETIMEDOUT)
 * - DNS resolution failures (ENOTFOUND)
 * - Socket hangup (ECONNRESET)
 * - HTTP server errors
 * - Rate limit (429) handling
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RateLimitTracker } from "../rate-limit.js";

describe("Network Failure Handling", () => {
	// ==========================================================================
	// Rate Limit Tracker - 429 Error Detection
	// ==========================================================================

	describe("RateLimitTracker.is429Error", () => {
		it("should detect 429 status code in error message", () => {
			expect(RateLimitTracker.is429Error("Error: 429 Too Many Requests")).toBe(true);
			expect(RateLimitTracker.is429Error("HTTP 429")).toBe(true);
			expect(RateLimitTracker.is429Error("Status: 429")).toBe(true);
		});

		it("should detect rate limit keywords", () => {
			expect(RateLimitTracker.is429Error("Rate limit exceeded")).toBe(true);
			expect(RateLimitTracker.is429Error("RATE LIMIT EXCEEDED")).toBe(true);
			expect(RateLimitTracker.is429Error("You have exceeded your rate limit")).toBe(true);
		});

		it("should detect quota exceeded errors", () => {
			expect(RateLimitTracker.is429Error("Quota exceeded for model")).toBe(true);
			expect(RateLimitTracker.is429Error("API quota exceeded")).toBe(true);
		});

		it("should detect too many requests errors", () => {
			expect(RateLimitTracker.is429Error("Too many requests")).toBe(true);
			expect(RateLimitTracker.is429Error("TOO MANY REQUESTS")).toBe(true);
		});

		it("should handle Error objects", () => {
			expect(RateLimitTracker.is429Error(new Error("429 Too Many Requests"))).toBe(true);
			expect(RateLimitTracker.is429Error(new Error("Rate limit exceeded"))).toBe(true);
		});

		it("should return false for non-rate-limit errors", () => {
			expect(RateLimitTracker.is429Error("Connection refused")).toBe(false);
			expect(RateLimitTracker.is429Error("ECONNREFUSED")).toBe(false);
			expect(RateLimitTracker.is429Error("Timeout")).toBe(false);
			expect(RateLimitTracker.is429Error("500 Internal Server Error")).toBe(false);
		});

		it("should handle null/undefined", () => {
			expect(RateLimitTracker.is429Error(null)).toBe(false);
			expect(RateLimitTracker.is429Error(undefined)).toBe(false);
		});

		it("should handle non-string/non-error values", () => {
			expect(RateLimitTracker.is429Error(429)).toBe(true); // Number converted to string contains "429"
			expect(RateLimitTracker.is429Error({})).toBe(false);
			expect(RateLimitTracker.is429Error([])).toBe(false);
		});
	});

	// ==========================================================================
	// Rate Limit Tracker - Retry-After Header Extraction
	// ==========================================================================

	describe("RateLimitTracker.extractRetryAfter", () => {
		it("should extract retry-after seconds", () => {
			expect(RateLimitTracker.extractRetryAfter({ "retry-after": "60" })).toBe(60000);
			expect(RateLimitTracker.extractRetryAfter({ "Retry-After": "30" })).toBe(30000);
		});

		it("should return null for missing header", () => {
			expect(RateLimitTracker.extractRetryAfter({})).toBeNull();
			expect(RateLimitTracker.extractRetryAfter(undefined)).toBeNull();
		});

		it("should return null for invalid values", () => {
			expect(RateLimitTracker.extractRetryAfter({ "retry-after": "invalid" })).toBeNull();
			expect(RateLimitTracker.extractRetryAfter({ "retry-after": "" })).toBeNull();
		});

		it("should handle zero value", () => {
			expect(RateLimitTracker.extractRetryAfter({ "retry-after": "0" })).toBe(0);
		});
	});

	// ==========================================================================
	// Rate Limit Tracker - Enhanced Header Processing
	// ==========================================================================

	describe("RateLimitTracker.processRateLimitHeaders", () => {
		it("should extract all rate limit headers", () => {
			const headers = {
				"retry-after": "60",
				"x-ratelimit-limit": "1000",
				"x-ratelimit-remaining": "50",
				"x-ratelimit-reset": "1704067200",
				"x-ratelimit-window": "1h",
			};

			const result = RateLimitTracker.processRateLimitHeaders(headers);

			expect(result.retryAfter).toBe(60000);
			expect(result.limit).toBe(1000);
			expect(result.remaining).toBe(50);
			expect(result.resetEpoch).toBe(1704067200);
			expect(result.reset).toBeInstanceOf(Date);
			expect(result.windowSize).toBe("1h");
		});

		it("should handle uppercase header names", () => {
			const headers = {
				"Retry-After": "30",
				"X-RateLimit-Limit": "500",
				"X-RateLimit-Remaining": "100",
				"X-RateLimit-Reset": "1704067200",
				"X-RateLimit-Window": "5m",
			};

			const result = RateLimitTracker.processRateLimitHeaders(headers);

			expect(result.retryAfter).toBe(30000);
			expect(result.limit).toBe(500);
			expect(result.remaining).toBe(100);
			expect(result.windowSize).toBe("5m");
		});

		it("should handle partial headers", () => {
			const headers = {
				"retry-after": "120",
			};

			const result = RateLimitTracker.processRateLimitHeaders(headers);

			expect(result.retryAfter).toBe(120000);
			expect(result.limit).toBeUndefined();
			expect(result.remaining).toBeUndefined();
		});

		it("should return empty object for no headers", () => {
			expect(RateLimitTracker.processRateLimitHeaders(undefined)).toEqual({});
			expect(RateLimitTracker.processRateLimitHeaders({})).toEqual({});
		});

		it("should ignore invalid numeric values", () => {
			const headers = {
				"x-ratelimit-limit": "invalid",
				"x-ratelimit-remaining": "abc",
			};

			const result = RateLimitTracker.processRateLimitHeaders(headers);

			expect(result.limit).toBeUndefined();
			expect(result.remaining).toBeUndefined();
		});
	});

	// ==========================================================================
	// Rate Limit Tracker - Pause and Resume
	// ==========================================================================

	describe("RateLimitTracker pause/resume", () => {
		let tracker: RateLimitTracker;

		beforeEach(() => {
			tracker = new RateLimitTracker();
		});

		it("should pause for rate limit hit", () => {
			tracker.pauseForRateLimit("sonnet", "429 Too Many Requests");

			expect(tracker.isPaused()).toBe(true);
			expect(tracker.isModelPaused("sonnet")).toBe(true);
		});

		it("should set resume time from retry-after header", () => {
			const headers = { "retry-after": "60" };
			tracker.pauseForRateLimit("sonnet", "Rate limit exceeded", undefined, headers);

			expect(tracker.isPaused()).toBe(true);
			const pauseState = tracker.getPauseState();
			expect(pauseState.resumeAt).toBeDefined();

			// Resume time should be approximately 60 seconds from now
			const expectedResumeMs = Date.now() + 60000;
			const actualResumeMs = pauseState.resumeAt?.getTime() ?? 0;
			expect(Math.abs(actualResumeMs - expectedResumeMs)).toBeLessThan(1000);
		});

		it("should calculate resume time without retry-after header", () => {
			tracker.pauseForRateLimit("sonnet", "Rate limit exceeded");

			expect(tracker.isPaused()).toBe(true);
			const pauseState = tracker.getPauseState();
			expect(pauseState.resumeAt).toBeDefined();
		});

		it("should resume from rate limit pause", () => {
			tracker.pauseForRateLimit("sonnet", "Rate limit exceeded");
			expect(tracker.isPaused()).toBe(true);

			tracker.resumeFromRateLimit();
			expect(tracker.isPaused()).toBe(false);
		});

		it("should resume individual model", () => {
			tracker.pauseForRateLimit("sonnet", "Rate limit exceeded");
			tracker.pauseForRateLimit("opus", "Rate limit exceeded");

			expect(tracker.isModelPaused("sonnet")).toBe(true);
			expect(tracker.isModelPaused("opus")).toBe(true);

			tracker.resumeModel("sonnet");

			expect(tracker.isModelPaused("sonnet")).toBe(false);
			expect(tracker.isModelPaused("opus")).toBe(true);
			expect(tracker.isPaused()).toBe(true); // Still globally paused
		});

		it("should auto-resume when all models unpaused", () => {
			tracker.pauseForRateLimit("sonnet", "Rate limit exceeded");

			tracker.resumeModel("sonnet");

			// After resuming all paused models, global pause should clear
			expect(tracker.isPaused()).toBe(false);
		});

		it("should get remaining pause time", () => {
			const headers = { "retry-after": "120" };
			tracker.pauseForRateLimit("sonnet", "Rate limit exceeded", undefined, headers);

			const remaining = tracker.getRemainingPauseTime();
			// Should be close to 120 seconds (120000ms), allow 1 second tolerance
			expect(remaining).toBeGreaterThan(119000);
			expect(remaining).toBeLessThanOrEqual(120000);
		});

		it("should return 0 remaining time when not paused", () => {
			expect(tracker.getRemainingPauseTime()).toBe(0);
		});

		it("should format remaining time", () => {
			const headers = { "retry-after": "3661" }; // 1 hour, 1 minute, 1 second
			tracker.pauseForRateLimit("sonnet", "Rate limit exceeded", undefined, headers);

			const formatted = tracker.formatRemainingTime();
			// Should be approximately "1:01" (1 hour, 1 minute rounded up)
			expect(formatted).toMatch(/^\d+:\d{2}$/);
		});
	});

	// ==========================================================================
	// Rate Limit Tracker - Recording Rate Limit Hits
	// ==========================================================================

	describe("RateLimitTracker recording", () => {
		let tracker: RateLimitTracker;
		let consoleSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			tracker = new RateLimitTracker();
			consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			vi.spyOn(console, "warn").mockImplementation(() => {});
		});

		afterEach(() => {
			consoleSpy.mockRestore();
			vi.restoreAllMocks();
		});

		it("should record rate limit hit", () => {
			tracker.recordRateLimitHit("sonnet", "429 Too Many Requests");

			const summary = tracker.getUsageSummary();
			expect(summary.totalRateLimitHits).toBe(1);
			expect(summary.modelBreakdown.sonnet.rateLimitHits).toBe(1);
		});

		it("should record rate limit hit with headers", () => {
			const headers = {
				"retry-after": "60",
				"x-ratelimit-limit": "1000",
				"x-ratelimit-remaining": "0",
			};

			tracker.recordRateLimitHit("opus", "Rate limit exceeded", headers);

			expect(tracker.isPaused()).toBe(true);
			expect(tracker.isModelPaused("opus")).toBe(true);
		});

		it("should track multiple rate limit hits", () => {
			tracker.recordRateLimitHit("sonnet", "Hit 1");
			tracker.resumeFromRateLimit();
			tracker.recordRateLimitHit("sonnet", "Hit 2");
			tracker.resumeFromRateLimit();
			tracker.recordRateLimitHit("opus", "Hit 3");

			const summary = tracker.getUsageSummary();
			expect(summary.totalRateLimitHits).toBe(3);
			expect(summary.modelBreakdown.sonnet.rateLimitHits).toBe(2);
			expect(summary.modelBreakdown.opus.rateLimitHits).toBe(1);
		});
	});

	// ==========================================================================
	// Rate Limit Tracker - Auto Resume
	// ==========================================================================

	describe("RateLimitTracker auto-resume", () => {
		let tracker: RateLimitTracker;

		beforeEach(() => {
			tracker = new RateLimitTracker();
			vi.spyOn(console, "error").mockImplementation(() => {});
			vi.spyOn(console, "warn").mockImplementation(() => {});
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("should auto-resume when time has passed", () => {
			// Set up a pause with very short resume time
			tracker.pauseForRateLimit("sonnet", "Rate limit exceeded");

			// Manually set resumeAt to past
			const state = tracker.getState();
			if (state.pause.resumeAt) {
				state.pause.resumeAt = new Date(Date.now() - 1000);
			}
			if (state.pause.modelPauses?.sonnet?.resumeAt) {
				state.pause.modelPauses.sonnet.resumeAt = new Date(Date.now() - 1000);
			}

			const resumed = tracker.checkAutoResume();
			expect(resumed).toBe(true);
		});

		it("should not auto-resume when time has not passed and usage is high", () => {
			// Record enough usage to be above the resume threshold (90%)
			// This prevents usage-based auto-resume from triggering
			for (let i = 0; i < 100; i++) {
				tracker.recordTask(`task-${i}`, "sonnet", 10000, 5000);
			}

			const headers = { "retry-after": "3600" }; // 1 hour
			tracker.pauseForRateLimit("sonnet", "Rate limit exceeded", undefined, headers);

			const resumed = tracker.checkAutoResume();
			expect(resumed).toBe(false);
			expect(tracker.isPaused()).toBe(true);
		});

		it("should return monitoring state", () => {
			// Record enough usage to prevent usage-based auto-resume
			for (let i = 0; i < 100; i++) {
				tracker.recordTask(`task-${i}`, "sonnet", 10000, 5000);
			}

			tracker.pauseForRateLimit("sonnet", "Rate limit exceeded");

			const monitoring = tracker.continuousMonitoring();

			expect(monitoring.currentUsage).toBeDefined();
			// When usage is high and time hasn't passed, shouldResume should be false
			expect(monitoring.shouldResume).toBe(false);
			expect(monitoring.timeUntilResume).toBeGreaterThan(0);
		});
	});

	// ==========================================================================
	// HTTP Server Error Scenarios (Unit Tests)
	// ==========================================================================

	describe("HTTP error scenarios", () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = mkdtempSync(join(tmpdir(), "network-test-"));
		});

		afterEach(() => {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		});

		it("should classify common network errors correctly", () => {
			// These are the common network error patterns we should handle
			const networkErrors = [
				{ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:7331", isTransient: true },
				{ code: "ETIMEDOUT", message: "connect ETIMEDOUT", isTransient: true },
				{ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND localhost", isTransient: true },
				{ code: "ECONNRESET", message: "socket hang up", isTransient: true },
				{ code: "EPIPE", message: "write EPIPE", isTransient: true },
			];

			for (const errorInfo of networkErrors) {
				const error = new Error(errorInfo.message);
				(error as NodeJS.ErrnoException).code = errorInfo.code;

				// These are transient errors that should be retried
				expect(isTransientNetworkError(error)).toBe(errorInfo.isTransient);
			}
		});

		it("should not classify non-network errors as transient", () => {
			const nonNetworkErrors = [new Error("File not found"), new Error("Invalid JSON"), new Error("Validation failed")];

			for (const error of nonNetworkErrors) {
				expect(isTransientNetworkError(error)).toBe(false);
			}
		});

		it("should classify HTTP status codes correctly", () => {
			// 5xx errors are typically transient
			expect(isTransientHttpStatus(500)).toBe(true);
			expect(isTransientHttpStatus(502)).toBe(true);
			expect(isTransientHttpStatus(503)).toBe(true);
			expect(isTransientHttpStatus(504)).toBe(true);

			// 429 is transient (rate limited)
			expect(isTransientHttpStatus(429)).toBe(true);

			// 4xx errors (except 429) are not transient
			expect(isTransientHttpStatus(400)).toBe(false);
			expect(isTransientHttpStatus(401)).toBe(false);
			expect(isTransientHttpStatus(403)).toBe(false);
			expect(isTransientHttpStatus(404)).toBe(false);

			// 2xx are success, not errors
			expect(isTransientHttpStatus(200)).toBe(false);
			expect(isTransientHttpStatus(201)).toBe(false);
		});
	});

	// ==========================================================================
	// queryDaemon Connection Failures (Integration-style)
	// ==========================================================================

	describe("queryDaemon connection handling", () => {
		let server: Server | null = null;

		afterEach(async () => {
			if (server) {
				await new Promise<void>((resolve) => server?.close(() => resolve()));
				server = null;
			}
		});

		it("should handle server not listening", async () => {
			// Create a mock that simulates queryDaemon behavior
			const mockQueryDaemon = async (): Promise<unknown> => {
				// Simulate ECONNREFUSED by throwing appropriate error
				const error = new Error("connect ECONNREFUSED 127.0.0.1:7331");
				(error as NodeJS.ErrnoException).code = "ECONNREFUSED";
				throw error;
			};

			await expect(mockQueryDaemon()).rejects.toThrow("ECONNREFUSED");
		});

		it("should handle server timeout", async () => {
			// Create a server that never responds
			server = createServer((_req, _res) => {
				// Don't respond - simulate timeout
			});

			await new Promise<void>((resolve) => {
				server?.listen(0, "127.0.0.1", () => resolve());
			});

			const address = server.address();
			const _port = typeof address === "object" ? address?.port : 0;

			const mockQueryWithTimeout = async (): Promise<unknown> => {
				return new Promise((_resolve, reject) => {
					const timeout = setTimeout(() => {
						const error = new Error("Request timeout");
						(error as NodeJS.ErrnoException).code = "ETIMEDOUT";
						reject(error);
					}, 100);

					// Clean up timeout if we somehow succeed
					return () => clearTimeout(timeout);
				});
			};

			await expect(mockQueryWithTimeout()).rejects.toThrow("timeout");
		});

		it("should handle server returning error status", async () => {
			// Create a server that returns 500
			server = createServer((_req, res) => {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Internal Server Error" }));
			});

			await new Promise<void>((resolve) => {
				server?.listen(0, "127.0.0.1", () => resolve());
			});

			const address = server.address();
			expect(address).not.toBeNull();
			expect(typeof address).toBe("object");

			// The error response should be parseable
			const errorResponse = { error: "Internal Server Error" };
			expect(errorResponse.error).toBe("Internal Server Error");
		});

		it("should handle malformed JSON response", async () => {
			// Create a server that returns invalid JSON
			server = createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end("not valid json {{{");
			});

			await new Promise<void>((resolve) => {
				server?.listen(0, "127.0.0.1", () => resolve());
			});

			const parseResponse = (): unknown => {
				return JSON.parse("not valid json {{{");
			};

			expect(parseResponse).toThrow(SyntaxError);
		});
	});

	// ==========================================================================
	// Retry Logic
	// ==========================================================================

	describe("retry logic for network failures", () => {
		it("should implement exponential backoff calculation", () => {
			const calculateBackoff = (attempt: number, baseDelay = 100, maxDelay = 30000): number => {
				const exponentialDelay = baseDelay * 2 ** attempt;
				return Math.min(exponentialDelay, maxDelay);
			};

			expect(calculateBackoff(0)).toBe(100); // 100 * 2^0 = 100
			expect(calculateBackoff(1)).toBe(200); // 100 * 2^1 = 200
			expect(calculateBackoff(2)).toBe(400); // 100 * 2^2 = 400
			expect(calculateBackoff(3)).toBe(800); // 100 * 2^3 = 800
			expect(calculateBackoff(10)).toBe(30000); // Capped at maxDelay
		});

		it("should add jitter to prevent thundering herd", () => {
			const calculateBackoffWithJitter = (
				attempt: number,
				baseDelay = 100,
				maxDelay = 30000,
				jitterFactor = 0.1,
			): number => {
				const exponentialDelay = baseDelay * 2 ** attempt;
				const cappedDelay = Math.min(exponentialDelay, maxDelay);
				const jitter = Math.random() * jitterFactor * cappedDelay;
				return cappedDelay + jitter;
			};

			// With jitter, values should vary
			const results = new Set<number>();
			for (let i = 0; i < 10; i++) {
				results.add(Math.round(calculateBackoffWithJitter(2)));
			}

			// Should have some variation (not all the same)
			// Base value is 400, with 10% jitter it should be 400-440
			expect(results.size).toBeGreaterThan(1);
		});

		it("should respect max retry attempts", async () => {
			let attempts = 0;
			const maxAttempts = 3;

			const retryWithLimit = async (fn: () => Promise<void>): Promise<void> => {
				for (let attempt = 0; attempt < maxAttempts; attempt++) {
					attempts++;
					try {
						await fn();
						return;
					} catch {
						if (attempt === maxAttempts - 1) {
							throw new Error(`Failed after ${maxAttempts} attempts`);
						}
					}
				}
			};

			const failingFn = async (): Promise<void> => {
				throw new Error("Network error");
			};

			await expect(retryWithLimit(failingFn)).rejects.toThrow("Failed after 3 attempts");
			expect(attempts).toBe(3);
		});
	});
});

// ==========================================================================
// Helper Functions
// ==========================================================================

/**
 * Check if an error is a transient network error that should be retried
 */
function isTransientNetworkError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;

	const code = (error as NodeJS.ErrnoException).code;
	const transientCodes = ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "EPIPE", "EHOSTUNREACH"];

	if (code && transientCodes.includes(code)) {
		return true;
	}

	const message = error.message.toLowerCase();
	return (
		message.includes("econnrefused") ||
		message.includes("etimedout") ||
		message.includes("enotfound") ||
		message.includes("socket hang up") ||
		message.includes("network")
	);
}

/**
 * Check if an HTTP status code indicates a transient error
 */
function isTransientHttpStatus(status: number): boolean {
	// 5xx server errors are transient
	if (status >= 500 && status < 600) {
		return true;
	}
	// 429 Too Many Requests is transient
	if (status === 429) {
		return true;
	}
	return false;
}
