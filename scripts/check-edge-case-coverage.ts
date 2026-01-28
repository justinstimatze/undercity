#!/usr/bin/env npx tsx
/**
 * Edge Case Coverage Checker
 *
 * Analyzes test files to calculate the ratio of edge case tests to total tests.
 * Edge case tests are identified by naming conventions in describe blocks and test names.
 *
 * Usage: npx tsx scripts/check-edge-case-coverage.ts [--threshold N] [--ci]
 *
 * Flags:
 *   --threshold N  Override default 40% threshold (0-100)
 *   --ci           Exit with code 1 if critical modules fail threshold
 *   --json         Output results as JSON
 *   --verbose      Show detailed test classification
 *
 * @example
 *   npx tsx scripts/check-edge-case-coverage.ts --threshold 40 --ci
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// =============================================================================
// Configuration
// =============================================================================

/**
 * Default edge case ratio threshold (40%)
 */
const DEFAULT_THRESHOLD = 40;

/**
 * Critical modules that must meet the threshold
 * These are identified by prefix matching against test file names
 */
const CRITICAL_MODULES = ["orchestrator", "worker"];

/**
 * Map of module prefixes to canonical module names
 * Handles cases like "task-scheduler.test.ts" -> "task-scheduler" instead of "task"
 */
const MODULE_NAME_OVERRIDES: Record<string, string> = {
	"task-scheduler": "task-scheduler",
};

/**
 * Patterns that identify edge case tests (case-insensitive)
 *
 * These patterns match common edge case test naming conventions:
 * - Boundary values (empty, null, undefined, zero, negative)
 * - Error conditions (invalid, error, fail, missing)
 * - Resource limits (timeout, exhaustion, max, min)
 * - Concurrency (race condition, concurrent)
 * - Edge scenarios (edge case, boundary, corner case)
 */
const EDGE_CASE_PATTERNS = [
	// Explicit edge case markers
	/edge\s*case/i,
	/boundary/i,
	/corner\s*case/i,

	// Null/undefined/empty handling
	/\bnull\b/i,
	/\bundefined\b/i,
	/\bempty\b/i,
	/\bmissing\b/i,

	// Boundary values
	/\bzero\b/i,
	/\bnegative\b/i,
	/\bmax\b/i,
	/\bmin\b/i,
	/\blimit\b/i,
	/\boverflow\b/i,
	/\bunderflow\b/i,

	// Error conditions
	/\binvalid\b/i,
	/\bmalformed\b/i,
	/\bcorrupt/i,
	/\bfail/i,
	/\berror\b/i,
	/\bexception\b/i,
	/\bthrow/i,
	/\breject/i,

	// Concurrency and timing
	/race\s*condition/i,
	/\bconcurrent\b/i,
	/\btimeout\b/i,
	/\bdeadlock\b/i,
	/\bstuck\b/i,
	/\bstale\b/i,

	// Resource exhaustion
	/resource\s*exhaust/i,
	/\bexhaust/i,
	/out\s*of\s*memory/i,
	/\bquota\b/i,

	// Recovery and resilience
	/\brecovery\b/i,
	/\bretry\b/i,
	/\brollback\b/i,
	/\bcleanup\b/i,

	// Special states
	/\bduplicate\b/i,
	/\bconflict\b/i,
	/\bcollision\b/i,
	/not\s*found/i,
	/\bno\s+\w+\s+found/i,
	/\balready\b/i,
];

// =============================================================================
// Types
// =============================================================================

interface TestInfo {
	name: string;
	line: number;
	isEdgeCase: boolean;
	matchedPattern?: string;
}

interface DescribeBlock {
	name: string;
	line: number;
	isEdgeCase: boolean;
	tests: TestInfo[];
}

interface ModuleAnalysis {
	module: string;
	testFiles: string[];
	totalTests: number;
	edgeCaseTests: number;
	ratio: number;
	passesThreshold: boolean;
	describes: DescribeBlock[];
}

interface AnalysisResult {
	timestamp: string;
	threshold: number;
	modules: ModuleAnalysis[];
	summary: {
		totalModules: number;
		passingModules: number;
		failingModules: number;
		criticalFailures: string[];
	};
}

// =============================================================================
// Test File Parsing
// =============================================================================

/**
 * Check if a test name/description matches edge case patterns
 */
function matchesEdgeCasePattern(text: string): string | null {
	for (const pattern of EDGE_CASE_PATTERNS) {
		if (pattern.test(text)) {
			return pattern.source;
		}
	}
	return null;
}

/**
 * Parse a test file and extract test information
 */
function parseTestFile(filePath: string): DescribeBlock[] {
	const content = readFileSync(filePath, "utf-8");
	const lines = content.split("\n");
	const describes: DescribeBlock[] = [];

	let currentDescribe: DescribeBlock | null = null;
	let describeStack: DescribeBlock[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + 1;

		// Match describe blocks: describe("...", () => {
		const describeMatch = line.match(/describe\s*\(\s*["'`]([^"'`]+)["'`]/);
		if (describeMatch) {
			const name = describeMatch[1];
			const matchedPattern = matchesEdgeCasePattern(name);
			const newDescribe: DescribeBlock = {
				name,
				line: lineNum,
				isEdgeCase: matchedPattern !== null,
				tests: [],
			};

			if (currentDescribe) {
				describeStack.push(currentDescribe);
			}
			currentDescribe = newDescribe;
			describes.push(newDescribe);
		}

		// Match test cases: it("...", () => { or test("...", () => {
		const testMatch = line.match(/(?:it|test)\s*\(\s*["'`]([^"'`]+)["'`]/);
		if (testMatch && currentDescribe) {
			const name = testMatch[1];
			const matchedPattern = matchesEdgeCasePattern(name);
			const isEdgeCase = matchedPattern !== null || currentDescribe.isEdgeCase;

			currentDescribe.tests.push({
				name,
				line: lineNum,
				isEdgeCase,
				matchedPattern: matchedPattern ?? (currentDescribe.isEdgeCase ? "parent describe" : undefined),
			});
		}

		// Handle closing braces (simplified - just pop stack when we see });)
		if (line.match(/^\s*\}\s*\)\s*;?\s*$/) && describeStack.length > 0) {
			currentDescribe = describeStack.pop() ?? null;
		}
	}

	return describes;
}

// =============================================================================
// Module Analysis
// =============================================================================

/**
 * Find all test files for a given module
 */
function findTestFilesForModule(testsDir: string, moduleName: string): string[] {
	if (!existsSync(testsDir)) {
		return [];
	}

	const files = readdirSync(testsDir);
	return files
		.filter((f) => {
			const fileModule = extractModuleName(f);
			return fileModule === moduleName;
		})
		.map((f) => join(testsDir, f));
}

/**
 * Analyze a module's test coverage for edge cases
 */
function analyzeModule(testsDir: string, moduleName: string, threshold: number): ModuleAnalysis {
	const testFiles = findTestFilesForModule(testsDir, moduleName);
	const allDescribes: DescribeBlock[] = [];

	for (const file of testFiles) {
		const describes = parseTestFile(file);
		allDescribes.push(...describes);
	}

	// Count total and edge case tests
	let totalTests = 0;
	let edgeCaseTests = 0;

	for (const describe of allDescribes) {
		for (const test of describe.tests) {
			totalTests++;
			if (test.isEdgeCase) {
				edgeCaseTests++;
			}
		}
	}

	const ratio = totalTests > 0 ? (edgeCaseTests / totalTests) * 100 : 0;

	return {
		module: moduleName,
		testFiles,
		totalTests,
		edgeCaseTests,
		ratio,
		passesThreshold: ratio >= threshold,
		describes: allDescribes,
	};
}

// =============================================================================
// Main Analysis
// =============================================================================

/**
 * Extract module name from test file name
 * Handles special cases like "task-scheduler.test.ts" -> "task-scheduler"
 */
function extractModuleName(fileName: string): string | null {
	if (!fileName.endsWith(".test.ts")) return null;

	// Check for exact matches first (e.g., "task-scheduler.test.ts")
	const exactMatch = fileName.replace(".test.ts", "");
	if (MODULE_NAME_OVERRIDES[exactMatch]) {
		return MODULE_NAME_OVERRIDES[exactMatch];
	}

	// For files like "orchestrator-error-scenarios.test.ts", extract "orchestrator"
	// For files like "worker-escalation-logic.test.ts", extract "worker"
	const match = fileName.match(/^([a-z]+)(?:-[a-z-]+)?\.test\.ts$/);
	if (match) {
		return match[1];
	}

	return null;
}

/**
 * Run the full edge case coverage analysis
 */
function runAnalysis(threshold: number): AnalysisResult {
	const testsDir = join(process.cwd(), "src", "__tests__");
	const modules: ModuleAnalysis[] = [];

	// Find all unique module prefixes from test files
	const moduleSet = new Set<string>();

	if (existsSync(testsDir)) {
		const files = readdirSync(testsDir);
		for (const file of files) {
			const moduleName = extractModuleName(file);
			if (moduleName) {
				moduleSet.add(moduleName);
			}
		}
	}

	// Analyze each module
	for (const moduleName of moduleSet) {
		const analysis = analyzeModule(testsDir, moduleName, threshold);
		if (analysis.totalTests > 0) {
			modules.push(analysis);
		}
	}

	// Sort by module name
	modules.sort((a, b) => a.module.localeCompare(b.module));

	// Calculate summary
	const criticalFailures = modules
		.filter((m) => CRITICAL_MODULES.includes(m.module) && !m.passesThreshold)
		.map((m) => m.module);

	return {
		timestamp: new Date().toISOString(),
		threshold,
		modules,
		summary: {
			totalModules: modules.length,
			passingModules: modules.filter((m) => m.passesThreshold).length,
			failingModules: modules.filter((m) => !m.passesThreshold).length,
			criticalFailures,
		},
	};
}

// =============================================================================
// Output Formatting
// =============================================================================

/**
 * Format results for human-readable output
 */
function formatResults(result: AnalysisResult, verbose: boolean): string {
	const lines: string[] = [];

	lines.push("Edge Case Coverage Report");
	lines.push("=".repeat(60));
	lines.push(`Generated: ${result.timestamp}`);
	lines.push(`Threshold: ${result.threshold}%`);
	lines.push("");

	// Module summary table
	lines.push("Module".padEnd(25) + "Total".padEnd(8) + "Edge".padEnd(8) + "Ratio".padEnd(10) + "Status");
	lines.push("-".repeat(60));

	for (const module of result.modules) {
		const isCritical = CRITICAL_MODULES.includes(module.module);
		const status = module.passesThreshold ? "PASS" : "FAIL";
		const criticalMark = isCritical ? " *" : "";

		lines.push(
			`${(module.module + criticalMark).padEnd(25)}${String(module.totalTests).padEnd(8)}${String(module.edgeCaseTests).padEnd(8)}${module.ratio.toFixed(1).padStart(5)}%    ${status}`,
		);
	}

	lines.push("-".repeat(60));
	lines.push("* = Critical module (must meet threshold)");
	lines.push("");

	// Summary
	lines.push("Summary");
	lines.push("-".repeat(30));
	lines.push(`Total modules analyzed: ${result.summary.totalModules}`);
	lines.push(`Passing: ${result.summary.passingModules}`);
	lines.push(`Failing: ${result.summary.failingModules}`);

	if (result.summary.criticalFailures.length > 0) {
		lines.push("");
		lines.push("CRITICAL FAILURES:");
		for (const module of result.summary.criticalFailures) {
			const analysis = result.modules.find((m) => m.module === module);
			if (analysis) {
				lines.push(
					`  - ${module}: ${analysis.ratio.toFixed(1)}% (need ${result.threshold}%, missing ${Math.ceil((result.threshold / 100) * analysis.totalTests - analysis.edgeCaseTests)} edge case tests)`,
				);
			}
		}
	}

	// Verbose output - show individual tests
	if (verbose) {
		lines.push("");
		lines.push("Detailed Test Classification");
		lines.push("=".repeat(60));

		for (const module of result.modules) {
			lines.push("");
			lines.push(`[${module.module}]`);

			for (const describe of module.describes) {
				lines.push(`  ${describe.name}${describe.isEdgeCase ? " [EDGE]" : ""}`);

				for (const test of describe.tests) {
					const marker = test.isEdgeCase ? "[E]" : "[ ]";
					const pattern = test.matchedPattern ? ` (${test.matchedPattern})` : "";
					lines.push(`    ${marker} ${test.name}${pattern}`);
				}
			}
		}
	}

	return lines.join("\n");
}

// =============================================================================
// CLI
// =============================================================================

function main(): void {
	const args = process.argv.slice(2);

	// Parse arguments
	let threshold = DEFAULT_THRESHOLD;
	let ciMode = false;
	let jsonOutput = false;
	let verbose = false;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--threshold" && args[i + 1]) {
			threshold = parseInt(args[i + 1], 10);
			if (Number.isNaN(threshold) || threshold < 0 || threshold > 100) {
				console.error("Error: Threshold must be a number between 0 and 100");
				process.exit(1);
			}
			i++;
		} else if (args[i] === "--ci") {
			ciMode = true;
		} else if (args[i] === "--json") {
			jsonOutput = true;
		} else if (args[i] === "--verbose") {
			verbose = true;
		} else if (args[i] === "--help") {
			console.log(`
Edge Case Coverage Checker

Usage: npx tsx scripts/check-edge-case-coverage.ts [options]

Options:
  --threshold N  Set minimum edge case ratio (default: ${DEFAULT_THRESHOLD}%)
  --ci           Exit with code 1 if critical modules fail
  --json         Output results as JSON
  --verbose      Show detailed test classification
  --help         Show this help message

Critical Modules (must meet threshold):
  ${CRITICAL_MODULES.join(", ")}

Edge Case Patterns:
  Tests are classified as edge cases if their name or parent describe
  block matches patterns like: empty, null, undefined, boundary, timeout,
  race condition, invalid, error, fail, max, min, zero, etc.
`);
			process.exit(0);
		}
	}

	// Run analysis
	const result = runAnalysis(threshold);

	// Output results
	if (jsonOutput) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(formatResults(result, verbose));
	}

	// Exit with error if CI mode and critical failures
	if (ciMode && result.summary.criticalFailures.length > 0) {
		console.error("");
		console.error(`CI FAILURE: ${result.summary.criticalFailures.length} critical module(s) below ${threshold}% threshold`);
		process.exit(1);
	}
}

main();
