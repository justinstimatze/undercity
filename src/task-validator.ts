/**
 * Task Validator
 *
 * Pre-flight validation for tasks before execution.
 * Catches issues like non-existent paths, invalid references, etc.
 * Can auto-fix common path mistakes when similar files exist elsewhere.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface ValidationIssue {
	type: "missing_directory" | "missing_file" | "invalid_path" | "ambiguous_target" | "path_corrected";
	severity: "error" | "warning" | "info";
	message: string;
	suggestion?: string;
	autoFix?: {
		originalPath: string;
		correctedPath: string;
	};
}

export interface TaskValidationResult {
	valid: boolean;
	issues: ValidationIssue[];
	extractedPaths: string[];
	/** If auto-fixes were applied, the corrected objective */
	correctedObjective?: string;
}

/**
 * Extract file paths from a task objective
 * Looks for patterns like:
 * - "In src/foo/bar.ts, ..."
 * - "src/foo/bar.ts"
 * - "the file src/foo/bar.ts"
 * - "modify src/foo/bar.ts"
 */
export function extractPathsFromObjective(objective: string): string[] {
	const paths: string[] = [];

	// Pattern 1: "In path/to/file.ext, ..." or "in path/to/file.ext"
	const inPattern = /\b[Ii]n\s+([\w./-]+\.\w+)/g;
	for (const match of objective.matchAll(inPattern)) {
		paths.push(match[1]);
	}

	// Pattern 2: Explicit file paths with extensions
	// Matches: src/foo/bar.ts, ./foo/bar.js, path/to/file.md
	const filePattern = /\b((?:\.\/|src\/|lib\/|test\/|docs\/)?[\w./-]+\.\w{1,5})\b/g;
	for (const match of objective.matchAll(filePattern)) {
		const path = match[1];
		// Filter out common false positives
		if (
			!path.includes("...") &&
			!path.match(/^\d+\.\d+/) && // Version numbers like 1.0
			!path.match(/^[a-z]+\.[a-z]+$/i) && // Domain-like patterns
			path.includes("/") // Must have directory separator
		) {
			paths.push(path);
		}
	}

	// Pattern 3: Directory paths mentioned explicitly
	// "in the src/config/ directory" or "create src/services/"
	// Only match paths that explicitly end with / or have "directory" nearby
	const dirPattern = /\b((?:src|lib|test|docs)\/[\w/-]+)\/\s|directory\s+["']?((?:src|lib|test|docs)\/[\w/-]+)/gi;
	for (const match of objective.matchAll(dirPattern)) {
		const dirPath = match[1] || match[2];
		if (dirPath && !dirPath.match(/\.\w+$/) && !paths.includes(dirPath)) {
			paths.push(dirPath);
		}
	}

	// Deduplicate
	return [...new Set(paths)];
}

/**
 * Find similar files in the repository using git ls-files
 */
function findSimilarFiles(filename: string, repoRoot: string): string[] {
	try {
		const name = basename(filename);
		const ext = name.includes(".") ? name.split(".").pop() : "";

		// Search for files with same name or similar patterns
		const output = execSync(`git ls-files`, {
			cwd: repoRoot,
			encoding: "utf-8",
			timeout: 5000,
		});

		const allFiles = output.split("\n").filter(Boolean);
		const matches: Array<{ path: string; score: number }> = [];

		for (const file of allFiles) {
			const fileBase = basename(file);
			let score = 0;

			// Exact filename match
			if (fileBase === name) {
				score = 100;
			}
			// Same extension and similar name
			else if (ext && file.endsWith(`.${ext}`)) {
				// Check for partial name match
				const namePart = name.replace(`.${ext}`, "").toLowerCase();
				const filePart = fileBase.replace(`.${ext}`, "").toLowerCase();

				if (filePart.includes(namePart) || namePart.includes(filePart)) {
					score = 70;
				} else if (filePart.split(/[-_]/).some((p: string) => namePart.includes(p))) {
					score = 50;
				}
			}

			if (score > 0) {
				matches.push({ path: file, score });
			}
		}

		// Sort by score descending
		return matches.sort((a, b) => b.score - a.score).map((m) => m.path);
	} catch {
		return [];
	}
}

/**
 * Try to find the correct path for a misreferenced file
 */
function findCorrectPath(incorrectPath: string, repoRoot: string): string | null {
	const filename = basename(incorrectPath);

	// Find similar files
	const similar = findSimilarFiles(filename, repoRoot);

	if (similar.length > 0) {
		// Return the best match if it exists
		const bestMatch = similar[0];
		if (existsSync(join(repoRoot, bestMatch))) {
			return bestMatch;
		}
	}

	// Check if the file exists with a different directory structure
	// e.g., src/config/foo.ts -> src/foo.ts or src/types/foo.ts
	const parts = incorrectPath.split("/");
	if (parts.length > 2) {
		// Try skipping intermediate directories
		const alternatives = [
			`src/${filename}`, // Direct in src
			`src/types/${filename}`, // In types if it looks like a type file
			`src/utils/${filename}`, // In utils
		];

		for (const alt of alternatives) {
			if (existsSync(join(repoRoot, alt))) {
				return alt;
			}
		}
	}

	return null;
}

/**
 * Validate a single path reference
 */
function validatePath(path: string, repoRoot: string): ValidationIssue | null {
	const fullPath = join(repoRoot, path);
	const parentDir = dirname(fullPath);

	// Check if path has a file extension (it's a file reference)
	const hasExtension = /\.\w+$/.test(path);

	if (hasExtension) {
		// For files, check if parent directory exists
		if (!existsSync(parentDir)) {
			// Try to find the correct path
			const correctPath = findCorrectPath(path, repoRoot);

			if (correctPath) {
				return {
					type: "path_corrected",
					severity: "info",
					message: `Path "${path}" corrected to "${correctPath}"`,
					autoFix: {
						originalPath: path,
						correctedPath: correctPath,
					},
				};
			}

			// Find the first missing directory in the chain
			const parts = path.split("/");
			let missingAt = "";
			let checkPath = repoRoot;
			for (let i = 0; i < parts.length - 1; i++) {
				checkPath = join(checkPath, parts[i]);
				if (!existsSync(checkPath)) {
					missingAt = parts.slice(0, i + 1).join("/");
					break;
				}
			}

			// Check for similar files to suggest
			const similar = findSimilarFiles(basename(path), repoRoot);
			const suggestion =
				similar.length > 0
					? `Did you mean "${similar[0]}"?`
					: `Create the directory first, or update task to use an existing path like "src/"`;

			return {
				type: "missing_directory",
				severity: "error",
				message: `Directory "${missingAt || dirname(path)}" does not exist`,
				suggestion,
			};
		}
		// File itself doesn't need to exist (might be created)
	} else {
		// For directories, check if they exist
		if (!existsSync(fullPath)) {
			return {
				type: "missing_directory",
				severity: "warning",
				message: `Directory "${path}" does not exist`,
				suggestion: `Task may need to create this directory, or use an existing path`,
			};
		}
	}

	return null;
}

/**
 * Validate a task objective before execution
 * If autoFix is true, will attempt to correct invalid paths
 */
export function validateTask(
	objective: string,
	repoRoot: string = process.cwd(),
	autoFix: boolean = true,
): TaskValidationResult {
	const extractedPaths = extractPathsFromObjective(objective);
	const issues: ValidationIssue[] = [];
	let correctedObjective = objective;
	let hasCorrections = false;

	for (const path of extractedPaths) {
		const issue = validatePath(path, repoRoot);
		if (issue) {
			issues.push(issue);

			// Apply auto-fix if available
			if (autoFix && issue.autoFix) {
				correctedObjective = correctedObjective.replace(issue.autoFix.originalPath, issue.autoFix.correctedPath);
				hasCorrections = true;
			}
		}
	}

	// Check for ambiguous targets (multiple different directories mentioned)
	const directories = extractedPaths.map((p) => dirname(p)).filter((d) => d !== ".");
	const uniqueDirs = [...new Set(directories)];
	if (uniqueDirs.length > 2) {
		issues.push({
			type: "ambiguous_target",
			severity: "warning",
			message: `Task references ${uniqueDirs.length} different directories - may be too broad`,
			suggestion: "Consider breaking into smaller tasks targeting specific directories",
		});
	}

	return {
		valid: !issues.some((i) => i.severity === "error"),
		issues,
		extractedPaths,
		correctedObjective: hasCorrections ? correctedObjective : undefined,
	};
}

/**
 * Validate and optionally fix a task, updating the task board if corrections made
 */
export async function validateAndFixTask(
	task: { id: string; objective: string },
	repoRoot: string = process.cwd(),
): Promise<TaskValidationResult & { wasFixed: boolean }> {
	const result = validateTask(task.objective, repoRoot, true);

	if (result.correctedObjective && result.correctedObjective !== task.objective) {
		// Import dynamically to avoid circular dependency
		const { updateTaskFields } = await import("./task.js");
		try {
			updateTaskFields({ id: task.id, objective: result.correctedObjective });
			return { ...result, wasFixed: true };
		} catch {
			// If update fails, return result without fixing
			return { ...result, wasFixed: false };
		}
	}

	return { ...result, wasFixed: false };
}

/**
 * Batch validate multiple tasks
 */
export function validateTasks(
	tasks: Array<{ id: string; objective: string }>,
	repoRoot: string = process.cwd(),
): Map<string, TaskValidationResult> {
	const results = new Map<string, TaskValidationResult>();

	for (const task of tasks) {
		results.set(task.id, validateTask(task.objective, repoRoot));
	}

	return results;
}

/**
 * Format validation issues for display
 */
export function formatValidationIssues(taskId: string, result: TaskValidationResult): string[] {
	if (result.issues.length === 0) return [];

	const lines: string[] = [];
	for (const issue of result.issues) {
		const prefix = issue.severity === "error" ? "✗" : "⚠";
		lines.push(`${prefix} ${taskId}: ${issue.message}`);
		if (issue.suggestion) {
			lines.push(`  → ${issue.suggestion}`);
		}
	}
	return lines;
}

// ==========================================================================
// Task Clarity Assessment
// ==========================================================================

/**
 * Result of task clarity assessment
 */
export interface ClarityAssessment {
	/** Overall clarity level */
	clarity: "clear" | "vague" | "needs_context";
	/** Confidence in assessment (0-1) */
	confidence: number;
	/** Specific issues found */
	issues: string[];
	/** Suggestions to improve clarity */
	suggestions: string[];
}

/** Generic action verbs that need specifics */
const VAGUE_VERBS = [
	/^improve\b/i,
	/^fix\b/i,
	/^update\b/i,
	/^better\b/i,
	/^enhance\b/i,
	/^optimize\b/i,
	/^refactor\b/i,
	/^clean\s*up\b/i,
	/^make\b.*\bbetter\b/i,
];

/** Patterns indicating compound/multiple objectives */
const COMPOUND_PATTERNS = [
	/\band\s+also\b/i,
	/\bplus\b/i,
	/\badditionally\b/i,
	/\bfurthermore\b/i,
	/,\s*and\s+/i, // "do X, and Y"
];

/** Patterns indicating clear, specific tasks */
const SPECIFICITY_INDICATORS = [
	/\bin\s+\S+\.\w+/i, // "In src/file.ts"
	/\bfunction\s+\w+/i, // "function doThing"
	/\bclass\s+\w+/i, // "class MyClass"
	/\bmethod\s+\w+/i, // "method getName"
	/\bcomponent\s+\w+/i, // "component Button"
	/\btest\s+(?:for|that|when)/i, // "test for X" or "test that Y"
	/\berror\s*:?\s*.{10,}/i, // "error: ..." with message
	/TS\d{4}/i, // TypeScript error code
	/line\s+\d+/i, // "line 42"
	/\bwhen\s+.{10,}/i, // "when X happens"
	/\breturn\s+/i, // "return X"
];

/**
 * Assess the clarity of a task objective
 * Determines if a task is specific enough for autonomous execution
 */
export function assessTaskClarity(objective: string): ClarityAssessment {
	const issues: string[] = [];
	const suggestions: string[] = [];
	let clarityScore = 1.0; // Start at max, deduct for issues

	const trimmedObjective = objective.trim();
	const wordCount = trimmedObjective.split(/\s+/).length;

	// Check 1: Too short
	if (wordCount < 5) {
		issues.push("Task objective is very short");
		suggestions.push("Add more detail about what specifically needs to be done");
		clarityScore -= 0.3;
	} else if (wordCount < 10) {
		// Mildly short, only a warning
		clarityScore -= 0.1;
	}

	// Check 2: Starts with vague verb without specifics
	for (const pattern of VAGUE_VERBS) {
		if (pattern.test(trimmedObjective)) {
			// Check if there are specificity indicators that make it acceptable
			const hasSpecifics = SPECIFICITY_INDICATORS.some((sp) => sp.test(trimmedObjective));
			if (!hasSpecifics) {
				issues.push(`Starts with generic verb "${trimmedObjective.split(/\s+/)[0]}" without specific target`);
				suggestions.push('Specify the file, function, or component to modify (e.g., "In src/auth.ts, improve...")');
				clarityScore -= 0.25;
			}
			break;
		}
	}

	// Check 3: Compound objectives
	for (const pattern of COMPOUND_PATTERNS) {
		if (pattern.test(trimmedObjective)) {
			issues.push("Contains multiple objectives that should be separate tasks");
			suggestions.push("Split into separate tasks, each with a single clear objective");
			clarityScore -= 0.2;
			break;
		}
	}

	// Check 4: No file path or target for code tasks
	// Skip this check for non-code tasks (research, docs, etc.)
	const isCodeTask = /\b(add|fix|update|implement|refactor|change|modify|remove|delete)\b/i.test(trimmedObjective);
	const hasFilePath = /\.\w{1,5}\b/.test(trimmedObjective) || /\bsrc\/|\blib\/|\btest\//.test(trimmedObjective);
	const hasFunctionName = /\bfunction\s+\w+|\bclass\s+\w+|\bmethod\s+\w+|\b\w+\(\)/.test(trimmedObjective);

	if (isCodeTask && !hasFilePath && !hasFunctionName && wordCount < 15) {
		issues.push("No specific file or function mentioned for code change");
		suggestions.push("Specify the target file or function (e.g., 'In src/utils.ts, ...')");
		clarityScore -= 0.15;
	}

	// Check 5: Positive indicators (boost clarity)
	let specificityBoost = 0;
	for (const pattern of SPECIFICITY_INDICATORS) {
		if (pattern.test(trimmedObjective)) {
			specificityBoost += 0.1;
		}
	}
	clarityScore = Math.min(1.0, clarityScore + specificityBoost);

	// Determine final clarity level
	let clarity: "clear" | "vague" | "needs_context";
	if (clarityScore >= 0.7) {
		clarity = "clear";
	} else if (clarityScore >= 0.4) {
		clarity = "needs_context";
	} else {
		clarity = "vague";
	}

	return {
		clarity,
		confidence: Math.max(0, Math.min(1, clarityScore)),
		issues,
		suggestions,
	};
}

/**
 * Format clarity assessment for display
 */
export function formatClarityAssessment(taskId: string, assessment: ClarityAssessment): string[] {
	if (assessment.clarity === "clear") {
		return [];
	}

	const lines: string[] = [];
	const prefix = assessment.clarity === "vague" ? "⚠" : "?";
	lines.push(`${prefix} ${taskId}: Task may be too ${assessment.clarity === "vague" ? "vague" : "ambiguous"}`);

	for (const issue of assessment.issues) {
		lines.push(`  - ${issue}`);
	}

	if (assessment.suggestions.length > 0) {
		lines.push("  Suggestions:");
		for (const suggestion of assessment.suggestions) {
			lines.push(`    → ${suggestion}`);
		}
	}

	return lines;
}
