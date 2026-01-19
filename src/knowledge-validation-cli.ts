#!/usr/bin/env node
/**
 * Knowledge Validation CLI - Standalone validator for knowledge.json files
 *
 * Validates all knowledge.json files in .undercity directory structure.
 * Used by:
 * - CI/CD pipeline (.github/workflows/ci.yml)
 * - Pre-commit hooks (via verification-cli.ts)
 * - Manual runs (pnpm validate:knowledge)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatValidationIssues, validateKnowledgeBase } from "./knowledge-validator.js";

interface ValidationTarget {
	path: string;
	displayPath: string;
}

/**
 * Find all knowledge.json files to validate
 */
function findKnowledgeFiles(cwd: string): ValidationTarget[] {
	const targets: ValidationTarget[] = [];

	// Primary knowledge.json in .undercity
	const primaryPath = join(cwd, ".undercity", "knowledge.json");
	if (existsSync(primaryPath)) {
		targets.push({
			path: primaryPath,
			displayPath: ".undercity/knowledge.json",
		});
	}

	// Knowledge files in worktrees (if any)
	// Pattern: .undercity/worktrees/*/knowledge.json
	const worktreesDir = join(cwd, ".undercity", "worktrees");
	if (existsSync(worktreesDir)) {
		try {
			const entries = readdirSync(worktreesDir);
			for (const entry of entries) {
				const worktreePath = join(worktreesDir, entry, "knowledge.json");
				if (existsSync(worktreePath) && statSync(worktreePath).isFile()) {
					targets.push({
						path: worktreePath,
						displayPath: `.undercity/worktrees/${entry}/knowledge.json`,
					});
				}
			}
		} catch {
			// Ignore worktree scanning errors
		}
	}

	return targets;
}

/**
 * Validate a single knowledge.json file
 */
function validateKnowledgeFile(target: ValidationTarget): {
	valid: boolean;
	errorCount: number;
	warningCount: number;
	output: string[];
} {
	const output: string[] = [];

	try {
		const content = readFileSync(target.path, "utf-8");
		const parsed = JSON.parse(content);

		const result = validateKnowledgeBase(parsed);

		const errors = result.issues.filter((i) => i.severity === "error");
		const warnings = result.issues.filter((i) => i.severity === "warning");

		if (result.valid) {
			output.push(`✓ ${target.displayPath} - Valid (${parsed.learnings?.length || 0} learnings)`);
			if (warnings.length > 0) {
				output.push(`  ⚠ ${warnings.length} warnings (non-blocking)`);
			}
		} else {
			output.push(`✗ ${target.displayPath} - Invalid`);
			const formatted = formatValidationIssues(result);
			output.push(...formatted.map((line) => `  ${line}`));
		}

		return {
			valid: result.valid,
			errorCount: errors.length,
			warningCount: warnings.length,
			output,
		};
	} catch (error) {
		output.push(`✗ ${target.displayPath} - Failed to parse`);
		if (error instanceof SyntaxError) {
			output.push(`  Parse error: ${error.message}`);
		} else {
			output.push(`  Error: ${String(error)}`);
		}
		return {
			valid: false,
			errorCount: 1,
			warningCount: 0,
			output,
		};
	}
}

/**
 * Main validation function
 */
async function main() {
	const cwd = process.cwd();

	console.log("Knowledge Base Validation");
	console.log("=========================\n");

	const targets = findKnowledgeFiles(cwd);

	if (targets.length === 0) {
		console.log("No knowledge.json files found (this is OK for new repos)");
		console.log("✓ Validation passed (no files to check)");
		process.exit(0);
	}

	console.log(`Found ${targets.length} knowledge file(s) to validate:\n`);

	let allValid = true;
	let totalErrors = 0;
	let totalWarnings = 0;

	for (const target of targets) {
		const result = validateKnowledgeFile(target);
		console.log(result.output.join("\n"));
		console.log(""); // blank line between files

		if (!result.valid) {
			allValid = false;
		}
		totalErrors += result.errorCount;
		totalWarnings += result.warningCount;
	}

	// Summary
	console.log("=========================");
	if (allValid) {
		console.log(`✓ All knowledge files valid`);
		if (totalWarnings > 0) {
			console.log(`  (${totalWarnings} non-blocking warnings)`);
		}
		process.exit(0);
	} else {
		console.error(`✗ Validation failed: ${totalErrors} errors across ${targets.length} file(s)`);
		console.error("\nFix the issues above before committing.");
		process.exit(1);
	}
}

main().catch((error) => {
	console.error("Validation error:", error);
	process.exit(1);
});
