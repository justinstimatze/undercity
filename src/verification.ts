/**
 * Verification module - Code quality and correctness checks
 *
 * Provides comprehensive verification using local tools:
 * - Git diff analysis
 * - TypeScript typecheck
 * - Biome lint
 * - Tests
 * - Spell check
 * - CodeScene code health (optional)
 *
 * Commands are configurable via project profile (.undercity/profile.json).
 * Falls back to pnpm if no profile exists.
 */

import { execSync } from "node:child_process";
import { formatErrorsForAgent, getCache, parseTypeScriptErrors } from "./cache.js";
import {
	TIMEOUT_BUILD_STEP_MS,
	TIMEOUT_HEAVY_CMD_MS,
	TIMEOUT_LINT_FIX_MS,
	TIMEOUT_TEST_SUITE_MS,
} from "./constants.js";
import { sessionLogger } from "./logger.js";
import { Persistence } from "./persistence.js";

const logger = sessionLogger.child({ module: "verification" });

/**
 * Get verification commands from profile or use defaults
 */
function getVerificationCommands(workingDirectory: string): {
	typecheck: string;
	test: string;
	lint: string;
	spell: string;
	qualityCheck: string;
} {
	try {
		const persistence = new Persistence(`${workingDirectory}/.undercity`);
		const profile = persistence.getProfile();

		if (profile) {
			// Use profile commands, with fallbacks for optional ones
			return {
				typecheck: profile.commands.typecheck,
				test: profile.commands.test,
				lint: profile.commands.lint,
				spell: "pnpm spell", // Spell check not yet in profile
				qualityCheck: "pnpm quality:check", // Quality check not yet in profile
			};
		}
	} catch (_error: unknown) {
		// Profile not available, use defaults
	}

	// Default commands (pnpm-based)
	// Note: use 'pnpm check' not 'pnpm lint' to match CI (biome check vs biome lint)
	return {
		typecheck: "pnpm typecheck",
		test: "pnpm test --run",
		lint: "pnpm check",
		spell: "pnpm spell",
		qualityCheck: "pnpm quality:check",
	};
}

import type { ErrorCategory } from "./types.js";

/**
 * Timing data for profiling
 */
export interface VerificationTiming {
	format?: number;
	security?: number;
	spell?: number;
	knowledgeValidation?: number;
	gitDiff?: number;
	typecheck?: number;
	lint?: number;
	tests?: number;
	build?: number;
	codeHealth?: number;
	total: number;
}

/**
 * Verification result
 */
export interface VerificationResult {
	passed: boolean;
	typecheckPassed: boolean;
	testsPassed: boolean;
	lintPassed: boolean;
	spellPassed: boolean;
	codeHealthPassed: boolean;
	knowledgeValidationPassed: boolean;
	filesChanged: number;
	linesChanged: number;
	issues: string[];
	/** Detailed feedback for the agent to act on */
	feedback: string;
	/** True if passed but has non-blocking warnings (spell, code health) */
	hasWarnings: boolean;
	/** Timing data for profiling (if enabled) */
	timing?: VerificationTiming;
}

/**
 * Verify work using comprehensive local tools
 *
 * Uses the full suite of local verification:
 * - Git diff (what changed)
 * - TypeScript typecheck (type safety)
 * - Biome lint (code quality)
 * - Tests (correctness)
 * - CodeScene (code health) - optional
 * - Spell check - optional
 *
 * Returns detailed feedback the agent can act on.
 */
export interface VerifyWorkOptions {
	runTypecheck?: boolean;
	runTests?: boolean;
	workingDirectory?: string;
	baseCommit?: string;
	profile?: boolean;
	/** Skip optional checks (spell, security, code health) for trivial tasks */
	skipOptionalChecks?: boolean;
	/** Skip auto-format/lint-fix step */
	skipAutoFix?: boolean;
	/** Stop tests on first failure (faster feedback during retries) */
	bailOnTestFailure?: boolean;
}

export async function verifyWork(opts: VerifyWorkOptions = {}): Promise<VerificationResult> {
	const runTypecheck = opts.runTypecheck ?? true;
	const runTestsOpt = opts.runTests ?? true;
	const cwd = opts.workingDirectory ?? process.cwd();
	const baseCommitOpt = opts.baseCommit;
	const profileOpt = opts.profile ?? false;
	const skipOptionalChecks = opts.skipOptionalChecks ?? false;
	const skipAutoFix = opts.skipAutoFix ?? false;
	const bailOnTestFailure = opts.bailOnTestFailure ?? false;
	const issues: string[] = [];
	const feedbackParts: string[] = [];
	let typecheckPassed = true;
	let testsPassed = true;
	let lintPassed = true;
	let spellPassed = true;

	// Timing for profiling
	const timing: VerificationTiming = { total: 0 };
	const totalStart = Date.now();

	// Get commands from profile or use defaults
	const commands = getVerificationCommands(cwd);

	// Auto-fix lint/format issues before verification (worktrees don't have pre-commit hooks)
	// Use check:fix (not format:fix) to include import organization
	let stepStart = Date.now();
	if (!skipAutoFix) {
		try {
			execSync("pnpm check:fix 2>&1", { encoding: "utf-8", cwd, timeout: TIMEOUT_LINT_FIX_MS });
			feedbackParts.push("✓ Auto-fixed lint/format issues");
		} catch (_error: unknown) {
			// check:fix may not be available in all projects, continue
		}
	}
	if (profileOpt) timing.format = Date.now() - stepStart;

	// Security scan (mirrors pre-commit hook) - skip for trivial tasks
	stepStart = Date.now();
	if (!skipOptionalChecks) {
		try {
			execSync("bash ./scripts/security-scan.sh 2>&1", { encoding: "utf-8", cwd, timeout: TIMEOUT_LINT_FIX_MS });
			feedbackParts.push("✓ Security scan passed");
		} catch (error: unknown) {
			const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
			// Security issues are blocking
			if (output.includes("secret") || output.includes("leak")) {
				issues.push("Security scan failed - potential secrets detected");
				feedbackParts.push("✗ SECURITY: Potential secrets detected in code. Remove before committing.");
			}
			// If script doesn't exist, continue (non-fatal)
		}
	}
	if (profileOpt) timing.security = Date.now() - stepStart;

	// Spell check - skip for trivial tasks
	stepStart = Date.now();
	if (!skipOptionalChecks) {
		try {
			// Only run spell check on typescript and markdown files
			execSync(`${commands.spell} 2>&1`, { encoding: "utf-8", cwd, timeout: TIMEOUT_LINT_FIX_MS });
			feedbackParts.push("✓ Spell check passed");
		} catch (error: unknown) {
			// Spell errors are non-blocking - just log a warning
			const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
			const spellingErrors = output.split("\n").filter((line) => line.includes("spelling error"));
			const errorCount = spellingErrors.length;
			// Only mark as failed if there are actual spelling errors to fix
			if (errorCount > 0) {
				spellPassed = false;
				logger.warn({ errorCount, errors: spellingErrors.slice(0, 5) }, "Spelling issues detected (non-blocking)");
				feedbackParts.push(`⚠ Spelling issues (${errorCount}) - non-blocking`);
			} else {
				// Spell command failed but no actionable errors - treat as passed
				feedbackParts.push("✓ Spell check passed");
			}
		}
	}
	if (profileOpt) timing.spell = Date.now() - stepStart;

	// Knowledge validation - validate knowledge.json integrity
	stepStart = Date.now();
	let knowledgeValidationPassed = true;
	if (!skipOptionalChecks) {
		try {
			// Run knowledge validation CLI
			execSync("pnpm exec tsx src/knowledge-validation-cli.ts 2>&1", {
				encoding: "utf-8",
				cwd,
				timeout: TIMEOUT_HEAVY_CMD_MS,
			});
			feedbackParts.push("✓ Knowledge validation passed");
		} catch (error: unknown) {
			// Knowledge validation is blocking if files exist and are invalid
			const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
			// If no files found, that's OK (new repos)
			if (output.includes("No knowledge.json files found")) {
				feedbackParts.push("✓ Knowledge validation passed (no files)");
			} else {
				// Actual validation errors - this is blocking
				knowledgeValidationPassed = false;
				issues.push("Knowledge validation failed");
				// Extract error summary
				const errorLines = output
					.split("\n")
					.filter((l) => l.includes("✗") || l.includes("error"))
					.slice(0, 5);
				feedbackParts.push(`✗ KNOWLEDGE VALIDATION FAILED:\n${errorLines.join("\n")}`);
				logger.error({ output: output.slice(0, 500) }, "Knowledge validation failed");
			}
		}
	}
	if (profileOpt) timing.knowledgeValidation = Date.now() - stepStart;

	let codeHealthPassed = true;
	let filesChanged = 0;
	let linesChanged = 0;

	// 1. Check what changed
	stepStart = Date.now();
	// Check: uncommitted changes, untracked files, AND committed changes since base
	// This handles: agent left changes uncommitted, created new files, OR already committed
	let changedFiles: string[] = [];
	let untrackedFiles: string[] = [];
	try {
		// First check uncommitted changes (modified files)
		let diffStat = execSync("git diff --stat HEAD 2>/dev/null || git diff --stat", {
			encoding: "utf-8",
			cwd,
		});

		// Also check for untracked files (new files) - git diff misses these!
		const statusOutput = execSync("git status --porcelain 2>/dev/null || true", {
			encoding: "utf-8",
			cwd,
		});
		untrackedFiles = statusOutput
			.split("\n")
			.filter((line) => line.startsWith("??"))
			.map((line) => line.slice(3).trim())
			.filter((f) => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js") || f.endsWith(".json"));

		// If no uncommitted changes and no untracked files, check committed changes since base
		if (!diffStat.trim() && untrackedFiles.length === 0) {
			try {
				// Compare HEAD to baseCommit if provided, otherwise fall back to HEAD~1
				const compareRef = baseCommitOpt || "HEAD~1";
				diffStat = execSync(`git diff --stat ${compareRef} HEAD 2>/dev/null || true`, {
					encoding: "utf-8",
					cwd,
				});
			} catch (_error: unknown) {
				// Ignore errors (e.g., no parent commit or invalid base)
			}
		}

		// Parse diff stat for file count
		const filesMatch = diffStat.match(/(\d+) files? changed/);
		if (filesMatch) {
			filesChanged = parseInt(filesMatch[1], 10);
		}

		// Add untracked files to the count
		filesChanged += untrackedFiles.length;

		// Parse for lines changed
		const insertions = diffStat.match(/(\d+) insertions?/);
		const deletions = diffStat.match(/(\d+) deletions?/);
		linesChanged = (insertions ? parseInt(insertions[1], 10) : 0) + (deletions ? parseInt(deletions[1], 10) : 0);

		// Get list of changed files (modified + untracked)
		const diffNames = execSync("git diff --name-only HEAD 2>/dev/null || git diff --name-only", {
			encoding: "utf-8",
			cwd,
		});
		changedFiles = [...diffNames.trim().split("\n").filter(Boolean), ...untrackedFiles];
	} catch (_error: unknown) {
		issues.push("No changes detected");
		feedbackParts.push("ERROR: No file changes were made. The task may not have been completed.");
	}
	if (profileOpt) timing.gitDiff = Date.now() - stepStart;

	// 2. Run typecheck, lint, and tests IN PARALLEL (they're independent)
	// This significantly reduces verification time vs running sequentially
	const parallelStart = Date.now();

	// Define parallel check functions
	const runTypecheckTask = async (): Promise<{
		passed: boolean;
		feedback: string[];
		issues: string[];
		duration: number;
	}> => {
		const start = Date.now();
		const feedback: string[] = [];
		const taskIssues: string[] = [];
		let passed = true;

		if (!runTypecheck) {
			return { passed, feedback, issues: taskIssues, duration: Date.now() - start };
		}

		try {
			execSync(`${commands.typecheck} 2>&1`, { encoding: "utf-8", cwd, timeout: TIMEOUT_BUILD_STEP_MS });
			feedback.push("✓ Typecheck passed");
		} catch (error: unknown) {
			passed = false;
			const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);

			// Parse into structured errors (more compact than raw output)
			const structuredErrors = parseTypeScriptErrors(output);
			taskIssues.push(`Typecheck failed (${structuredErrors.length} errors)`);

			// Format errors with suggestions
			const formattedErrors = formatErrorsForAgent(structuredErrors);
			feedback.push(`✗ TYPECHECK FAILED:\n${formattedErrors}`);

			// Check cache for previous fixes
			const cache = getCache();
			for (const err of structuredErrors.slice(0, 3)) {
				const similarFixes = cache.findSimilarFixes(err.message);
				if (similarFixes.length > 0) {
					feedback.push(`  💡 Similar error was fixed before: ${similarFixes[0].fix.slice(0, 50)}...`);
				}
			}
		}
		return { passed, feedback, issues: taskIssues, duration: Date.now() - start };
	};

	const runLintTask = async (): Promise<{
		passed: boolean;
		feedback: string[];
		issues: string[];
		duration: number;
	}> => {
		const start = Date.now();
		const feedback: string[] = [];
		const taskIssues: string[] = [];
		let passed = true;

		try {
			execSync(`${commands.lint} 2>&1`, { encoding: "utf-8", cwd, timeout: TIMEOUT_BUILD_STEP_MS });
			feedback.push("✓ Lint passed");
		} catch (error: unknown) {
			passed = false;
			const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);

			// Count lint issues
			const issueCount = (output.match(/✖|error|warning/gi) || []).length;
			taskIssues.push(`Lint issues (${issueCount})`);

			// Extract first few issues
			const lines = output
				.split("\n")
				.filter((l) => l.includes("error") || l.includes("warning"))
				.slice(0, 3);
			feedback.push(`⚠ LINT ISSUES:\n${lines.join("\n")}`);
		}
		return { passed, feedback, issues: taskIssues, duration: Date.now() - start };
	};

	const runTestsTask = async (): Promise<{
		passed: boolean;
		feedback: string[];
		issues: string[];
		duration: number;
	}> => {
		const start = Date.now();
		const feedback: string[] = [];
		const taskIssues: string[] = [];
		let passed = true;

		if (!runTestsOpt || !changedFiles.some((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
			return { passed, feedback, issues: taskIssues, duration: Date.now() - start };
		}

		// Check if any test files exist before running tests
		// This avoids vitest's exit code 1 on empty test suites
		// Only skip if we explicitly confirm no test files exist (not on error/empty check)
		let hasConfirmedNoTestFiles = false;
		try {
			// Use git ls-files with explicit patterns - only trust if command succeeds
			const lsOutput = execSync("git ls-files 2>/dev/null", { encoding: "utf-8", cwd }).trim();
			if (lsOutput) {
				// Git ls-files worked - check if any test files exist
				const testFilePatterns = /\.(test|spec)\.(ts|tsx|js|jsx)$|__tests__\//;
				const hasTestFiles = lsOutput.split("\n").some((f) => testFilePatterns.test(f));
				if (!hasTestFiles) {
					hasConfirmedNoTestFiles = true;
				}
			}
		} catch (_error: unknown) {
			// Git command failed - don't skip tests, let the test runner decide
		}

		if (hasConfirmedNoTestFiles) {
			feedback.push("✓ Tests passed (no test files in project)");
			return { passed, feedback, issues: taskIssues, duration: Date.now() - start };
		}

		try {
			// Run tests with short timeout - we just want to know if they pass
			// Set UNDERCITY_VERIFICATION to skip integration tests
			// Add --bail for faster feedback during retries (stop on first failure)
			const testCommand = bailOnTestFailure ? `${commands.test} --bail` : commands.test;
			execSync(`${testCommand} 2>&1`, {
				encoding: "utf-8",
				cwd,
				timeout: TIMEOUT_TEST_SUITE_MS,
				env: { ...process.env, UNDERCITY_VERIFICATION: "true" },
			});
			feedback.push("✓ Tests passed");
		} catch (error: unknown) {
			const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);

			// Check if failure is due to no test files existing - treat as pass
			// vitest: "No test files found, exiting with code 1" or just exits with nothing
			// jest: "No tests found"
			// Also check for empty output which vitest sometimes does
			if (
				output.includes("No test files found") ||
				output.includes("No tests found") ||
				output.includes("no test files") ||
				(output.trim().length < 50 && !output.includes("FAIL") && !output.includes("Error"))
			) {
				feedback.push("✓ Tests passed (no test files)");
				return { passed, feedback, issues: taskIssues, duration: Date.now() - start };
			}

			passed = false;

			// Extract failed test info
			const failedMatch = output.match(/(\d+) failed/);
			const failedCount = failedMatch ? failedMatch[1] : "some";
			taskIssues.push(`Tests failed (${failedCount})`);

			// Find the FAIL lines
			const failLines = output
				.split("\n")
				.filter((l) => l.includes("FAIL") || l.includes("AssertionError"))
				.slice(0, 3);
			feedback.push(`✗ TESTS FAILED:\n${failLines.join("\n")}`);
		}
		return { passed, feedback, issues: taskIssues, duration: Date.now() - start };
	};

	// INVARIANT: Typecheck, lint, and tests run in parallel for ~3x speedup.
	// Each check is independent; all errors collected regardless of individual failures.
	const [typecheckResult, lintResult, testsResult] = await Promise.all([
		runTypecheckTask(),
		runLintTask(),
		runTestsTask(),
	]);

	// Collect results
	typecheckPassed = typecheckResult.passed;
	lintPassed = lintResult.passed;
	testsPassed = testsResult.passed;

	// Add feedback in consistent order (typecheck → lint → tests)
	feedbackParts.push(...typecheckResult.feedback);
	feedbackParts.push(...lintResult.feedback);
	feedbackParts.push(...testsResult.feedback);

	issues.push(...typecheckResult.issues);
	issues.push(...lintResult.issues);
	issues.push(...testsResult.issues);

	if (profileOpt) {
		timing.typecheck = typecheckResult.duration;
		timing.lint = lintResult.duration;
		timing.tests = testsResult.duration;
		const parallelDuration = Date.now() - parallelStart;
		const sequentialWouldBe = typecheckResult.duration + lintResult.duration + testsResult.duration;
		if (sequentialWouldBe > 0) {
			logger.debug(
				{ parallelDuration, sequentialWouldBe, savedMs: sequentialWouldBe - parallelDuration },
				"Parallel verification saved time",
			);
		}
	}

	// 3. Run build (after parallel checks - uses compiled output)
	stepStart = Date.now();
	let buildPassed = true;
	try {
		execSync("pnpm build 2>&1", { encoding: "utf-8", cwd, timeout: TIMEOUT_BUILD_STEP_MS });
		feedbackParts.push("✓ Build passed");
	} catch (error: unknown) {
		buildPassed = false;
		const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
		issues.push("Build failed");
		// Extract first few error lines
		const errorLines = output
			.split("\n")
			.filter((l) => l.includes("error") || l.includes("Error"))
			.slice(0, 3);
		feedbackParts.push(`✗ BUILD FAILED:\n${errorLines.join("\n")}`);
	}
	if (profileOpt) timing.build = Date.now() - stepStart;

	// 6. CodeScene code health (optional, nice to have) - skip for trivial tasks
	stepStart = Date.now();
	if (!skipOptionalChecks) {
		try {
			// Only check changed files to be fast
			if (changedFiles.length > 0 && changedFiles.length <= 5) {
				const tsFiles = changedFiles.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
				if (tsFiles.length > 0) {
					const result = execSync(`${commands.qualityCheck} 2>&1 || true`, {
						encoding: "utf-8",
						cwd,
						timeout: TIMEOUT_LINT_FIX_MS,
					});

					// Check for code health issues
					if (result.includes("Code Health:") && result.includes("problematic")) {
						codeHealthPassed = false;
						issues.push("Code health issues detected");
						feedbackParts.push("⚠ CODE HEALTH: Consider simplifying complex functions");
					} else {
						feedbackParts.push("✓ Code health OK");
					}
				}
			}
		} catch (_error: unknown) {
			// CodeScene check is optional, don't fail on errors
		}
	}
	if (profileOpt) timing.codeHealth = Date.now() - stepStart;

	// Calculate total time
	if (profileOpt) {
		timing.total = Date.now() - totalStart;
		logger.info(
			{
				timing,
				breakdown: `format=${timing.format}ms security=${timing.security}ms spell=${timing.spell}ms knowledge=${timing.knowledgeValidation}ms git=${timing.gitDiff}ms typecheck=${timing.typecheck}ms lint=${timing.lint}ms tests=${timing.tests}ms build=${timing.build}ms health=${timing.codeHealth}ms`,
			},
			`Verification completed in ${timing.total}ms`,
		);
	}

	// Build final feedback
	const feedback = feedbackParts.join("\n");

	// Pass if: changes were made AND all critical checks passed (including knowledge validation)
	const passed =
		filesChanged > 0 && typecheckPassed && buildPassed && testsPassed && lintPassed && knowledgeValidationPassed;

	// Warnings are non-blocking issues that the agent could fix
	const hasWarnings = passed && (!spellPassed || !codeHealthPassed);

	return {
		passed,
		typecheckPassed,
		testsPassed,
		lintPassed,
		spellPassed,
		codeHealthPassed,
		knowledgeValidationPassed,
		filesChanged,
		linesChanged,
		issues,
		feedback,
		hasWarnings,
		timing: profileOpt ? timing : undefined,
	};
}

/**
 * Context for granular no_changes categorization
 */
export interface CategorizeErrorsContext {
	/** Number of no-op edits (content already correct) */
	noOpEditCount?: number;
	/** Whether VAGUE_TASK was detected */
	isVagueTask?: boolean;
	/** Number of consecutive attempts with no writes */
	consecutiveNoWriteAttempts?: number;
}

/**
 * Exhaustive type guard to ensure all ErrorCategory enum values are handled.
 * This helper function uses a switch statement with a never type guard in the
 * default case to enforce compile-time checking. If a new ErrorCategory is added
 * without updating this function, TypeScript will produce a compile-time error.
 *
 * @param category - The ErrorCategory to validate
 * @returns true if the category is recognized
 * @throws Error if an unhandled category is encountered (should never happen at runtime)
 *
 * @example
 * ```typescript
 * // This ensures all ErrorCategory values are explicitly handled:
 * assertExhaustiveErrorCategory("lint"); // true
 * assertExhaustiveErrorCategory("typecheck"); // true
 * // If a new category is added to ErrorCategory enum, TypeScript will error here
 * ```
 */
function assertExhaustiveErrorCategory(category: ErrorCategory): boolean {
	switch (category) {
		case "lint":
		case "typecheck":
		case "build":
		case "test":
		case "spell":
		case "no_changes":
		case "no_changes_complete":
		case "no_changes_mismatch":
		case "no_changes_confused":
		case "unknown":
			return true;
		default: {
			// Never type guard: if this line is reached, it means a new ErrorCategory
			// was added without updating this switch statement. TypeScript will error
			// at compile time if category is not of type 'never'.
			const _exhaustiveCheck: never = category;
			throw new Error(`Unhandled error category: ${_exhaustiveCheck}`);
		}
	}
}

/**
 * Categorize errors from verification for tracking.
 *
 * Returns an array of error categories based on verification results. Multiple
 * categories can be returned as they are independent (e.g., both "lint" and
 * "typecheck" failures can occur). The no_changes variants are mutually exclusive.
 *
 * This function is protected by exhaustive type checking via assertExhaustiveErrorCategory,
 * which ensures all ErrorCategory enum values are handled at compile time.
 *
 * @param verification - Verification result containing pass/fail status for each check
 * @param context - Optional context for granular no_changes categorization
 * @returns Array of error categories (empty array returns ["unknown"])
 *
 * @example
 * ```typescript
 * // Single failure
 * const result1 = categorizeErrors({ typecheckPassed: false, ... });
 * // Returns: ["typecheck"]
 *
 * // Multiple failures
 * const result2 = categorizeErrors({ typecheckPassed: false, testsPassed: false, ... });
 * // Returns: ["typecheck", "test"]
 *
 * // Granular no_changes categorization
 * const result3 = categorizeErrors(
 *   { filesChanged: 0, ... },
 *   { isVagueTask: true }
 * );
 * // Returns: ["no_changes_mismatch"]
 * ```
 */
export function categorizeErrors(verification: VerificationResult, context?: CategorizeErrorsContext): ErrorCategory[] {
	const categories: ErrorCategory[] = [];

	if (!verification.lintPassed) categories.push("lint");
	if (!verification.spellPassed) categories.push("spell");
	if (!verification.typecheckPassed) categories.push("typecheck");
	if (!verification.testsPassed) categories.push("test");

	// Granular no_changes categorization
	if (verification.filesChanged === 0) {
		if (context?.isVagueTask) {
			// VAGUE_TASK detected - architectural mismatch
			categories.push("no_changes_mismatch");
		} else if (context?.noOpEditCount && context.noOpEditCount > 0) {
			// Agent made no-op edits (content already correct) - task may be complete
			categories.push("no_changes_complete");
		} else if (context?.consecutiveNoWriteAttempts && context.consecutiveNoWriteAttempts >= 2) {
			// Multiple attempts with no writes - agent is confused
			categories.push("no_changes_confused");
		} else {
			// Generic fallback
			categories.push("no_changes");
		}
	}

	// Check for build issues (typecheck passed but build failed)
	if (verification.typecheckPassed && verification.issues.some((i) => i.toLowerCase().includes("build"))) {
		categories.push("build");
	}

	// Validate that all returned categories are handled (compile-time exhaustiveness check)
	for (const category of categories) {
		assertExhaustiveErrorCategory(category);
	}

	return categories.length > 0 ? categories : ["unknown"];
}

// ============================================================================
// BASELINE VERIFICATION
// ============================================================================

interface BaselineCache {
	commit: string;
	verifiedAt: number;
	passed: boolean;
}

interface BaselineResult {
	passed: boolean;
	feedback: string;
	cached: boolean;
}

const BASELINE_CACHE_FILE = ".undercity/baseline-cache.json";
const BASELINE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Verify that the main branch is in a good state before running tasks.
 * Uses caching to avoid re-running checks on the same commit.
 * Only runs typecheck (fast) - not full tests.
 */
export async function verifyBaseline(cwd: string = process.cwd()): Promise<BaselineResult> {
	const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
	const { join, dirname } = await import("node:path");

	// Get current HEAD commit
	let currentCommit: string;
	try {
		currentCommit = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
	} catch (_error: unknown) {
		return { passed: true, feedback: "Not a git repo, skipping baseline check", cached: false };
	}

	const cachePath = join(cwd, BASELINE_CACHE_FILE);

	// Check cache
	try {
		if (existsSync(cachePath)) {
			const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as BaselineCache;
			if (cached && cached.commit === currentCommit && Date.now() - cached.verifiedAt < BASELINE_CACHE_TTL) {
				if (cached.passed) {
					return { passed: true, feedback: "Baseline previously verified", cached: true };
				}
				// Cached failure - still fail but note it's cached
				return { passed: false, feedback: "Baseline previously failed (cached)", cached: true };
			}
		}
	} catch (_error: unknown) {
		// No cache or invalid cache - continue with verification
	}

	// Run typecheck only (fast baseline check)
	const commands = getVerificationCommands(cwd);
	const feedbackParts: string[] = [];
	let passed = true;

	try {
		execSync(`${commands.typecheck} 2>&1`, { encoding: "utf-8", cwd, timeout: TIMEOUT_BUILD_STEP_MS });
		feedbackParts.push("✓ Typecheck passed");
	} catch (error: unknown) {
		passed = false;
		const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
		const tsErrors = parseTypeScriptErrors(output);
		if (tsErrors.length > 0) {
			const errorSummary = formatErrorsForAgent(tsErrors);
			feedbackParts.push(`✗ Typecheck failed:\n${errorSummary}`);
		} else {
			feedbackParts.push(`✗ Typecheck failed: ${output.slice(0, 500)}`);
		}
	}

	// Cache result
	try {
		const dir = dirname(cachePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(cachePath, JSON.stringify({ commit: currentCommit, verifiedAt: Date.now(), passed }));
	} catch (_error: unknown) {
		// Cache write failure is non-fatal
		logger.warn("Failed to write baseline cache");
	}

	return { passed, feedback: feedbackParts.join("\n"), cached: false };
}
