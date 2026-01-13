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
	} catch {
		// Profile not available, use defaults
	}

	// Default commands (pnpm-based)
	return {
		typecheck: "pnpm typecheck",
		test: "pnpm test --run",
		lint: "pnpm lint",
		spell: "pnpm spell",
		qualityCheck: "pnpm quality:check",
	};
}

import type { ErrorCategory } from "./types.js";

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
	filesChanged: number;
	linesChanged: number;
	issues: string[];
	/** Detailed feedback for the agent to act on */
	feedback: string;
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
export async function verifyWork(
	runTypecheck: boolean = true,
	runTests: boolean = true,
	workingDirectory: string = process.cwd(),
	baseCommit?: string,
): Promise<VerificationResult> {
	const issues: string[] = [];
	const feedbackParts: string[] = [];
	let typecheckPassed = true;
	let testsPassed = true;
	let lintPassed = true;
	let spellPassed = true;

	// Get commands from profile or use defaults
	const commands = getVerificationCommands(workingDirectory);

	// Auto-format code before verification (worktrees don't have pre-commit hooks)
	try {
		execSync("pnpm format:fix 2>&1", { encoding: "utf-8", cwd: workingDirectory, timeout: 30000 });
		feedbackParts.push("✓ Auto-formatted code");
	} catch {
		// Format:fix may not be available in all projects, continue
	}

	// Security scan (mirrors pre-commit hook)
	try {
		execSync("bash ./scripts/security-scan.sh 2>&1", { encoding: "utf-8", cwd: workingDirectory, timeout: 30000 });
		feedbackParts.push("✓ Security scan passed");
	} catch (error) {
		const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
		// Security issues are blocking
		if (output.includes("secret") || output.includes("leak")) {
			issues.push("Security scan failed - potential secrets detected");
			feedbackParts.push("✗ SECURITY: Potential secrets detected in code. Remove before committing.");
		}
		// If script doesn't exist, continue (non-fatal)
	}

	try {
		// Only run spell check on typescript and markdown files
		execSync(`${commands.spell} 2>&1`, { encoding: "utf-8", cwd: workingDirectory, timeout: 30000 });
		feedbackParts.push("✓ Spell check passed");
	} catch (error) {
		// Spell errors are non-blocking - just log a warning
		spellPassed = false;
		const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
		const spellingErrors = output.split("\n").filter((line) => line.includes("spelling error"));
		const errorCount = spellingErrors.length;
		logger.warn({ errorCount, errors: spellingErrors.slice(0, 5) }, "Spelling issues detected (non-blocking)");
		feedbackParts.push(`⚠ Spelling issues (${errorCount}) - non-blocking`);
	}
	let codeHealthPassed = true;
	let filesChanged = 0;
	let linesChanged = 0;

	// 1. Check what changed
	// Check: uncommitted changes, untracked files, AND committed changes since base
	// This handles: agent left changes uncommitted, created new files, OR already committed
	let changedFiles: string[] = [];
	let untrackedFiles: string[] = [];
	try {
		// First check uncommitted changes (modified files)
		let diffStat = execSync("git diff --stat HEAD 2>/dev/null || git diff --stat", {
			encoding: "utf-8",
			cwd: workingDirectory,
		});

		// Also check for untracked files (new files) - git diff misses these!
		const statusOutput = execSync("git status --porcelain 2>/dev/null || true", {
			encoding: "utf-8",
			cwd: workingDirectory,
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
				const compareRef = baseCommit || "HEAD~1";
				diffStat = execSync(`git diff --stat ${compareRef} HEAD 2>/dev/null || true`, {
					encoding: "utf-8",
					cwd: workingDirectory,
				});
			} catch {
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
			cwd: workingDirectory,
		});
		changedFiles = [...diffNames.trim().split("\n").filter(Boolean), ...untrackedFiles];
	} catch {
		issues.push("No changes detected");
		feedbackParts.push("ERROR: No file changes were made. The task may not have been completed.");
	}

	// 2. Run typecheck (critical - must pass)
	if (runTypecheck) {
		try {
			execSync(`${commands.typecheck} 2>&1`, { encoding: "utf-8", cwd: workingDirectory, timeout: 60000 });
			feedbackParts.push("✓ Typecheck passed");
		} catch (error) {
			typecheckPassed = false;
			const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);

			// Parse into structured errors (more compact than raw output)
			const structuredErrors = parseTypeScriptErrors(output);
			issues.push(`Typecheck failed (${structuredErrors.length} errors)`);

			// Format errors with suggestions
			const formattedErrors = formatErrorsForAgent(structuredErrors);
			feedbackParts.push(`✗ TYPECHECK FAILED:\n${formattedErrors}`);

			// Check cache for previous fixes
			const cache = getCache();
			for (const err of structuredErrors.slice(0, 3)) {
				const similarFixes = cache.findSimilarFixes(err.message);
				if (similarFixes.length > 0) {
					feedbackParts.push(`  💡 Similar error was fixed before: ${similarFixes[0].fix.slice(0, 50)}...`);
				}
			}
		}
	}

	// 3. Run lint check (important for code quality)
	try {
		execSync(`${commands.lint} 2>&1`, { encoding: "utf-8", cwd: workingDirectory, timeout: 60000 });
		feedbackParts.push("✓ Lint passed");
	} catch (error) {
		lintPassed = false;
		const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);

		// Count lint issues
		const issueCount = (output.match(/✖|error|warning/gi) || []).length;
		issues.push(`Lint issues (${issueCount})`);

		// Extract first few issues
		const lines = output
			.split("\n")
			.filter((l) => l.includes("error") || l.includes("warning"))
			.slice(0, 3);
		feedbackParts.push(`⚠ LINT ISSUES:\n${lines.join("\n")}`);
	}

	// 4. Run tests if enabled and tests exist for changed files
	if (runTests && changedFiles.some((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
		try {
			// Run tests with short timeout - we just want to know if they pass
			execSync(`${commands.test} 2>&1`, { encoding: "utf-8", cwd: workingDirectory, timeout: 120000 });
			feedbackParts.push("✓ Tests passed");
		} catch (error) {
			testsPassed = false;
			const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);

			// Extract failed test info
			const failedMatch = output.match(/(\d+) failed/);
			const failedCount = failedMatch ? failedMatch[1] : "some";
			issues.push(`Tests failed (${failedCount})`);

			// Find the FAIL lines
			const failLines = output
				.split("\n")
				.filter((l) => l.includes("FAIL") || l.includes("AssertionError"))
				.slice(0, 3);
			feedbackParts.push(`✗ TESTS FAILED:\n${failLines.join("\n")}`);
		}
	}

	// 5. Run build (mirrors pre-commit hook - ensures code compiles)
	let buildPassed = true;
	try {
		execSync("pnpm build 2>&1", { encoding: "utf-8", cwd: workingDirectory, timeout: 60000 });
		feedbackParts.push("✓ Build passed");
	} catch (error) {
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

	// 6. CodeScene code health (optional, nice to have)
	try {
		// Only check changed files to be fast
		if (changedFiles.length > 0 && changedFiles.length <= 5) {
			const tsFiles = changedFiles.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
			if (tsFiles.length > 0) {
				const result = execSync(`${commands.qualityCheck} 2>&1 || true`, {
					encoding: "utf-8",
					cwd: workingDirectory,
					timeout: 30000,
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
	} catch {
		// CodeScene check is optional, don't fail on errors
	}

	// Build final feedback
	const feedback = feedbackParts.join("\n");

	// Pass if: changes were made AND typecheck passed AND build passed (lint/tests are warnings)
	const passed = filesChanged > 0 && typecheckPassed && buildPassed;

	return {
		passed,
		typecheckPassed,
		testsPassed,
		lintPassed,
		spellPassed,
		codeHealthPassed,
		filesChanged,
		linesChanged,
		issues,
		feedback,
	};
}

/**
 * Categorize errors from verification for tracking
 */
export function categorizeErrors(verification: VerificationResult): ErrorCategory[] {
	const categories: ErrorCategory[] = [];

	if (!verification.lintPassed) categories.push("lint");
	if (!verification.spellPassed) categories.push("spell");
	if (!verification.typecheckPassed) categories.push("typecheck");
	if (!verification.testsPassed) categories.push("test");
	if (verification.filesChanged === 0) categories.push("no_changes");

	// Check for build issues (typecheck passed but build failed)
	if (verification.typecheckPassed && verification.issues.some((i) => i.toLowerCase().includes("build"))) {
		categories.push("build");
	}

	return categories.length > 0 ? categories : ["unknown"];
}
