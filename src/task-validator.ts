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
 * Common language/technology names that should NOT be extracted as paths
 * These often appear in patterns like "in TypeScript" or "in Python"
 */
const LANGUAGE_KEYWORDS = new Set([
	"typescript",
	"javascript",
	"python",
	"rust",
	"go",
	"java",
	"ruby",
	"php",
	"swift",
	"kotlin",
	"scala",
	"elixir",
	"haskell",
	"clojure",
	"react",
	"vue",
	"angular",
	"node",
	"deno",
	"bun",
]);

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
	// Must contain a "/" to be a path, otherwise it might be "in TypeScript"
	const inPattern = /\b[Ii]n\s+([\w./-]+\.\w+)/g;
	for (const match of objective.matchAll(inPattern)) {
		const candidate = match[1];
		// Must contain "/" to be a path, and not be a language keyword
		if (candidate.includes("/") && !LANGUAGE_KEYWORDS.has(candidate.toLowerCase())) {
			paths.push(candidate);
		}
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
 * Known output directories that tasks are allowed to create
 * These are directories where agents create output (research docs, code, etc.)
 */
const ALLOWED_OUTPUT_DIRECTORIES = [
	// Documentation directories
	"docs/research",
	"docs/design",
	"docs/",
	".undercity/research",
	"research",
	"output",
	"generated",
	// Source code directories (agents can create new modules)
	"src/",
	"lib/",
	"test/",
	"tests/",
	"__tests__/",
];

/**
 * Check if a path is in an allowed output directory
 */
function isInAllowedOutputDir(path: string): boolean {
	return ALLOWED_OUTPUT_DIRECTORIES.some((dir) => path.startsWith(dir) || path.startsWith(`./${dir}`));
}

/**
 * Validate a single path reference
 * @param isCreationTask If true, treat missing directories as warnings (task will create them)
 */
function validatePath(path: string, repoRoot: string, isCreationTask: boolean = false): ValidationIssue | null {
	const fullPath = join(repoRoot, path);
	const parentDir = dirname(fullPath);

	// Check if path has a file extension (it's a file reference)
	const hasExtension = /\.\w+$/.test(path);

	if (hasExtension) {
		// For files, check if parent directory exists
		if (!existsSync(parentDir)) {
			// If this is a creation task or in an allowed output directory, treat as warning
			if (isCreationTask || isInAllowedOutputDir(path)) {
				return {
					type: "missing_directory",
					severity: "warning",
					message: `Directory "${dirname(path)}" does not exist yet`,
					suggestion: `Task will create this directory (allowed output path)`,
				};
			}

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
 * Patterns that indicate a task is creating new files/content
 * These patterns should match anywhere in the objective, including after prefixes like "Design:"
 */
const CREATION_TASK_PATTERNS = [
	/^\[research\]/i,
	/\bresearch\b/i,
	/\bcreate\b/i, // Matches "Create" anywhere, including "Design: Create..."
	/\bgenerate\b/i,
	/\bwrite\s+(?:a\s+)?(?:new\s+)?(?:design|doc|report|spec)/i,
	/\bsave\s+(?:to|in)\b/i,
	/\boutput\s+(?:to|in)\b/i,
	/\binitial(?:ize)?\b/i, // "initial schema", "initialize project"
	/\bscaffold\b/i,
	/\bbootstrap\b/i,
	/\bnew\s+(?:file|module|component|schema|project)/i,
	/\bsetup\b/i,
	/\bdesign:/i, // Tasks with "Design:" prefix are design/creation tasks
];

/**
 * Check if a task objective indicates file/directory creation
 */
function isCreationTask(objective: string): boolean {
	return CREATION_TASK_PATTERNS.some((pattern) => pattern.test(objective));
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

	// Detect if this is a creation/research task that may need to create directories
	const isCreation = isCreationTask(objective);

	for (const path of extractedPaths) {
		const issue = validatePath(path, repoRoot, isCreation);
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
// Task Board Validation
// ==========================================================================

/**
 * Validation severity levels
 */
export type ValidationSeverity = "error" | "warning" | "info";

/**
 * Validation error categories
 */
export type ValidationCategory =
	| "missing_field"
	| "invalid_enum"
	| "invalid_date"
	| "invalid_reference"
	| "orphaned_subtask"
	| "circular_dependency"
	| "inconsistent_state"
	| "empty_value";

/**
 * Detailed validation report for a single task
 */
export interface TaskValidationReport {
	taskId: string;
	severity: ValidationSeverity;
	category: ValidationCategory;
	message: string;
	suggestion?: string;
	field?: string;
}

/**
 * Overall validation report for task board
 */
export interface BoardValidationReport {
	valid: boolean;
	totalTasks: number;
	validTasks: number;
	invalidTasks: number;
	issues: TaskValidationReport[];
	statistics: {
		byCategory: Record<ValidationCategory, number>;
		bySeverity: Record<ValidationSeverity, number>;
	};
}

/**
 * Valid task statuses
 */
const VALID_STATUSES = new Set([
	"pending",
	"in_progress",
	"complete",
	"failed",
	"blocked",
	"duplicate",
	"canceled",
	"obsolete",
]);

/**
 * Validate a single task object
 * Returns array of validation issues
 */
export function validateTaskObject(task: unknown, allTasks: unknown[]): TaskValidationReport[] {
	const issues: TaskValidationReport[] = [];

	// Type guard: ensure task is an object
	if (typeof task !== "object" || task === null) {
		issues.push({
			taskId: "unknown",
			severity: "error",
			category: "missing_field",
			message: "Task is not an object",
			suggestion: "Remove this invalid entry from tasks.json",
		});
		return issues;
	}

	const t = task as Record<string, unknown>;
	const taskId = typeof t.id === "string" ? t.id : "unknown";

	// Required fields validation
	if (typeof t.id !== "string") {
		issues.push({
			taskId,
			severity: "error",
			category: "missing_field",
			field: "id",
			message: "Task missing required field: id",
			suggestion: "Add a unique task ID or remove this task",
		});
	} else if (t.id.trim().length === 0) {
		issues.push({
			taskId,
			severity: "error",
			category: "empty_value",
			field: "id",
			message: "Task ID is empty",
			suggestion: "Add a unique task ID or remove this task",
		});
	}

	if (typeof t.objective !== "string") {
		issues.push({
			taskId,
			severity: "error",
			category: "missing_field",
			field: "objective",
			message: "Task missing required field: objective",
			suggestion: "Add a task objective or remove this task",
		});
	} else if (t.objective.trim().length === 0) {
		issues.push({
			taskId,
			severity: "error",
			category: "empty_value",
			field: "objective",
			message: "Task objective is empty",
			suggestion: "Add a meaningful objective or remove this task",
		});
	}

	if (typeof t.status !== "string") {
		issues.push({
			taskId,
			severity: "error",
			category: "missing_field",
			field: "status",
			message: "Task missing required field: status",
			suggestion: "Set task status to 'pending' or remove this task",
		});
	} else if (!VALID_STATUSES.has(t.status)) {
		issues.push({
			taskId,
			severity: "error",
			category: "invalid_enum",
			field: "status",
			message: `Invalid task status: "${t.status}"`,
			suggestion: `Use one of: ${[...VALID_STATUSES].join(", ")}`,
		});
	}

	// Date validation
	if (t.createdAt) {
		if (typeof t.createdAt !== "string") {
			issues.push({
				taskId,
				severity: "warning",
				category: "invalid_date",
				field: "createdAt",
				message: "createdAt is not a string",
				suggestion: "Should be ISO 8601 date string",
			});
		} else {
			const date = new Date(t.createdAt);
			if (Number.isNaN(date.getTime())) {
				issues.push({
					taskId,
					severity: "warning",
					category: "invalid_date",
					field: "createdAt",
					message: "createdAt is not a valid date",
					suggestion: "Use ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)",
				});
			}
		}
	} else {
		issues.push({
			taskId,
			severity: "warning",
			category: "missing_field",
			field: "createdAt",
			message: "Task missing createdAt timestamp",
			suggestion: "Add current timestamp or remove this task",
		});
	}

	if (t.startedAt && typeof t.startedAt === "string") {
		const date = new Date(t.startedAt);
		if (Number.isNaN(date.getTime())) {
			issues.push({
				taskId,
				severity: "warning",
				category: "invalid_date",
				field: "startedAt",
				message: "startedAt is not a valid date",
			});
		}
	}

	if (t.completedAt && typeof t.completedAt === "string") {
		const date = new Date(t.completedAt);
		if (Number.isNaN(date.getTime())) {
			issues.push({
				taskId,
				severity: "warning",
				category: "invalid_date",
				field: "completedAt",
				message: "completedAt is not a valid date",
			});
		}
	}

	// Dependency validation
	if (t.dependsOn && Array.isArray(t.dependsOn)) {
		for (const depId of t.dependsOn) {
			if (typeof depId !== "string") {
				issues.push({
					taskId,
					severity: "warning",
					category: "invalid_reference",
					field: "dependsOn",
					message: "dependsOn contains non-string task ID",
				});
				continue;
			}

			// Check if dependency exists
			const depExists = allTasks.some((otherTask) => {
				return (
					typeof otherTask === "object" && otherTask !== null && (otherTask as Record<string, unknown>).id === depId
				);
			});

			if (!depExists) {
				issues.push({
					taskId,
					severity: "error",
					category: "invalid_reference",
					field: "dependsOn",
					message: `Task depends on non-existent task: ${depId}`,
					suggestion: "Remove invalid dependency or add the missing task",
				});
			}
		}
	}

	// Parent/subtask consistency validation
	if (t.parentId && typeof t.parentId === "string") {
		// Check if parent exists
		const parent = allTasks.find((otherTask) => {
			return (
				typeof otherTask === "object" && otherTask !== null && (otherTask as Record<string, unknown>).id === t.parentId
			);
		});

		if (!parent) {
			issues.push({
				taskId,
				severity: "error",
				category: "orphaned_subtask",
				field: "parentId",
				message: `Orphaned subtask: parent task ${t.parentId} not found`,
				suggestion: "Remove parentId field or add the missing parent task",
			});
		} else {
			// Check if parent references this subtask
			const parentObj = parent as Record<string, unknown>;
			const subtaskIds = parentObj.subtaskIds;
			if (Array.isArray(subtaskIds) && !subtaskIds.includes(t.id)) {
				issues.push({
					taskId,
					severity: "warning",
					category: "inconsistent_state",
					field: "parentId",
					message: "Parent task does not reference this subtask in its subtaskIds",
					suggestion: "Update parent's subtaskIds array or remove parentId",
				});
			}
		}
	}

	if (t.subtaskIds && Array.isArray(t.subtaskIds)) {
		for (const subtaskId of t.subtaskIds) {
			if (typeof subtaskId !== "string") {
				issues.push({
					taskId,
					severity: "warning",
					category: "invalid_reference",
					field: "subtaskIds",
					message: "subtaskIds contains non-string task ID",
				});
				continue;
			}

			// Check if subtask exists
			const subtask = allTasks.find((otherTask) => {
				return (
					typeof otherTask === "object" && otherTask !== null && (otherTask as Record<string, unknown>).id === subtaskId
				);
			});

			if (!subtask) {
				issues.push({
					taskId,
					severity: "error",
					category: "invalid_reference",
					field: "subtaskIds",
					message: `Task references non-existent subtask: ${subtaskId}`,
					suggestion: "Remove invalid subtask ID or add the missing subtask",
				});
			} else {
				// Check if subtask references this task as parent
				const subtaskObj = subtask as Record<string, unknown>;
				if (subtaskObj.parentId !== t.id) {
					issues.push({
						taskId,
						severity: "warning",
						category: "inconsistent_state",
						field: "subtaskIds",
						message: `Subtask ${subtaskId} does not reference this task as its parent`,
						suggestion: "Update subtask's parentId field",
					});
				}
			}
		}
	}

	return issues;
}

/**
 * Detect circular dependencies in task graph
 */
function detectCircularDependencies(tasks: unknown[]): TaskValidationReport[] {
	const issues: TaskValidationReport[] = [];
	const visited = new Set<string>();
	const recursionStack = new Set<string>();

	function visit(taskId: string, path: string[]): boolean {
		if (recursionStack.has(taskId)) {
			// Found a cycle
			const cycleStart = path.indexOf(taskId);
			const cycle = [...path.slice(cycleStart), taskId].join(" -> ");
			issues.push({
				taskId,
				severity: "error",
				category: "circular_dependency",
				message: `Circular dependency detected: ${cycle}`,
				suggestion: "Remove one of the dependencies in the cycle",
			});
			return true;
		}

		if (visited.has(taskId)) {
			return false; // Already processed
		}

		visited.add(taskId);
		recursionStack.add(taskId);

		// Find this task and check its dependencies
		const task = tasks.find((t) => {
			return typeof t === "object" && t !== null && (t as Record<string, unknown>).id === taskId;
		});

		if (task && typeof task === "object") {
			const t = task as Record<string, unknown>;
			const deps = t.dependsOn;
			if (Array.isArray(deps)) {
				for (const depId of deps) {
					if (typeof depId === "string") {
						visit(depId, [...path, taskId]);
					}
				}
			}
		}

		recursionStack.delete(taskId);
		return false;
	}

	// Check all tasks
	for (const task of tasks) {
		if (typeof task === "object" && task !== null) {
			const t = task as Record<string, unknown>;
			if (typeof t.id === "string" && !visited.has(t.id)) {
				visit(t.id, []);
			}
		}
	}

	return issues;
}

/**
 * Validate entire task board
 * Returns detailed validation report with statistics
 */
export function validateTaskBoard(tasks: unknown[]): BoardValidationReport {
	const issues: TaskValidationReport[] = [];

	// Validate each task
	for (const task of tasks) {
		const taskIssues = validateTaskObject(task, tasks);
		issues.push(...taskIssues);
	}

	// Detect circular dependencies
	const circularIssues = detectCircularDependencies(tasks);
	issues.push(...circularIssues);

	// Compute statistics
	const byCategory: Record<ValidationCategory, number> = {
		missing_field: 0,
		invalid_enum: 0,
		invalid_date: 0,
		invalid_reference: 0,
		orphaned_subtask: 0,
		circular_dependency: 0,
		inconsistent_state: 0,
		empty_value: 0,
	};

	const bySeverity: Record<ValidationSeverity, number> = {
		error: 0,
		warning: 0,
		info: 0,
	};

	for (const issue of issues) {
		byCategory[issue.category]++;
		bySeverity[issue.severity]++;
	}

	// Count valid vs invalid tasks
	const invalidTaskIds = new Set(issues.filter((i) => i.severity === "error").map((i) => i.taskId));
	const validTasks = tasks.length - invalidTaskIds.size;

	return {
		valid: issues.filter((i) => i.severity === "error").length === 0,
		totalTasks: tasks.length,
		validTasks,
		invalidTasks: invalidTaskIds.size,
		issues,
		statistics: {
			byCategory,
			bySeverity,
		},
	};
}

/**
 * Format board validation report for display
 */
export function formatBoardValidationReport(report: BoardValidationReport): string[] {
	const lines: string[] = [];

	if (report.valid) {
		lines.push(`✓ Task board is valid (${report.totalTasks} tasks, no errors)`);
		if (report.statistics.bySeverity.warning > 0) {
			lines.push(`  ⚠ ${report.statistics.bySeverity.warning} warnings found`);
		}
		return lines;
	}

	// Summary
	lines.push(`✗ Task board validation failed`);
	lines.push(`  Total tasks: ${report.totalTasks}`);
	lines.push(`  Valid: ${report.validTasks}`);
	lines.push(`  Invalid: ${report.invalidTasks}`);
	lines.push(`  Errors: ${report.statistics.bySeverity.error}`);
	lines.push(`  Warnings: ${report.statistics.bySeverity.warning}`);
	lines.push("");

	// Group issues by severity and category
	const errors = report.issues.filter((i) => i.severity === "error");
	const warnings = report.issues.filter((i) => i.severity === "warning");

	if (errors.length > 0) {
		lines.push("Errors:");
		for (const issue of errors.slice(0, 10)) {
			// Limit to first 10
			lines.push(`  ✗ ${issue.taskId}: ${issue.message}`);
			if (issue.suggestion) {
				lines.push(`    → ${issue.suggestion}`);
			}
		}
		if (errors.length > 10) {
			lines.push(`  ... and ${errors.length - 10} more errors`);
		}
		lines.push("");
	}

	if (warnings.length > 0) {
		lines.push("Warnings:");
		for (const issue of warnings.slice(0, 5)) {
			// Limit to first 5
			lines.push(`  ⚠ ${issue.taskId}: ${issue.message}`);
			if (issue.suggestion) {
				lines.push(`    → ${issue.suggestion}`);
			}
		}
		if (warnings.length > 5) {
			lines.push(`  ... and ${warnings.length - 5} more warnings`);
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
	/** True if task is fundamentally too vague to proceed - should be blocked */
	tooVague?: boolean;
	/** Reason why task is too vague (if tooVague is true) */
	tooVagueReason?: string;
}

/** Patterns for tasks that are fundamentally too vague to proceed */
const FUNDAMENTALLY_VAGUE_PATTERNS = [
	/^Phase\s+\d+:/i, // "Phase 5: ..." without context
	/^Step\s+\d+:/i, // "Step 3: ..." without context
	/comprehensive\s+\w+\s+suite/i, // "comprehensive test suite" without target
	/^implement\s+.*\s+system$/i, // "implement X system" without specifics
	/^create\s+.*\s+(module|feature)$/i, // "create X module" without details
	/^build\s+.*\s+(infrastructure|architecture)$/i, // Too high-level
	/^design\s+and\s+implement/i, // Multi-phase task
	/^research\s+and\s+(implement|build|create)/i, // Multi-phase task
];

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

	// Check 0: Fundamentally vague patterns that should be blocked immediately
	for (const pattern of FUNDAMENTALLY_VAGUE_PATTERNS) {
		if (pattern.test(trimmedObjective)) {
			const matchedPart = trimmedObjective.match(pattern)?.[0] || "vague pattern";
			return {
				clarity: "vague",
				confidence: 0.9,
				issues: [`Task matches vague pattern: "${matchedPart}"`],
				suggestions: [
					"Specify the exact target (file, module, or feature)",
					"Define concrete acceptance criteria",
					"Break down into specific, actionable subtasks",
				],
				tooVague: true,
				tooVagueReason: `Matches vague pattern: ${pattern.source}`,
			};
		}
	}

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
