import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Performance baseline configuration for regression detection.
 * Tests fail if performance degrades more than 20% from baseline.
 *
 * Baseline file: .vitest/performance-baseline.json
 * Update baseline: UPDATE_BASELINE=true pnpm test knowledge-extractor-performance.test.ts
 */
interface PerformanceBaseline {
	patternMatchingAvgLatencyMs: number;
	modelBasedAvgLatencyMs: number;
	patternMatchingThroughput: number;
	modelBasedThroughput: number;
	updatedAt: string;
}

const DEFAULT_BASELINE: PerformanceBaseline = {
	patternMatchingAvgLatencyMs: 50,
	modelBasedAvgLatencyMs: 1000,
	patternMatchingThroughput: 100,
	modelBasedThroughput: 5,
	updatedAt: new Date().toISOString(),
};

/**
 * Load performance baseline from file or use defaults
 */
function loadPerformanceBaseline(): PerformanceBaseline {
	const baselinePath = join(process.cwd(), ".vitest", "performance-baseline.json");
	try {
		if (existsSync(baselinePath)) {
			return JSON.parse(readFileSync(baselinePath, "utf-8"));
		}
	} catch {
		// Use defaults if file doesn't exist or is invalid
	}
	return DEFAULT_BASELINE;
}

// Load baseline for global access in tests
const performanceBaseline = loadPerformanceBaseline();

/**
 * Performance regression thresholds (20% degradation allowed)
 */
const REGRESSION_THRESHOLD = 1.2;

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["src/__tests__/**/*.test.ts"],
		// Performance test configuration
		testTimeout: 30000, // 30s timeout for performance tests
		hookTimeout: 10000,
		// Global setup for performance baseline
		globalSetup: [],
		// Environment variables for performance tests
		env: {
			PERFORMANCE_BASELINE_PATTERN_LATENCY: String(
				performanceBaseline.patternMatchingAvgLatencyMs * REGRESSION_THRESHOLD,
			),
			PERFORMANCE_BASELINE_MODEL_LATENCY: String(performanceBaseline.modelBasedAvgLatencyMs * REGRESSION_THRESHOLD),
			PERFORMANCE_BASELINE_PATTERN_THROUGHPUT: String(
				performanceBaseline.patternMatchingThroughput * (1 / REGRESSION_THRESHOLD),
			),
			PERFORMANCE_BASELINE_MODEL_THROUGHPUT: String(
				performanceBaseline.modelBasedThroughput * (1 / REGRESSION_THRESHOLD),
			),
		},
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "json-summary"],
			include: ["src/**/*.ts"],
			exclude: ["src/__tests__/**", "src/index.ts", "src/cli.ts", "src/commands/**"],
			// Coverage thresholds enforced at 70%
			thresholds: {
				lines: 70,
				functions: 70,
				branches: 70,
				statements: 70,
			},
		},
		// Type testing configuration for .test-d.ts files
		typecheck: {
			enabled: true,
			include: ["src/__tests__/**/*.test-d.ts"],
		},
	},
});
