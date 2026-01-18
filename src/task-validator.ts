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
