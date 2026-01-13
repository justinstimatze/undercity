/**
 * Fast Path Handler - Bypass LLM for trivial mechanical tasks
 *
 * Uses ast-grep for structural code transformations that don't require
 * intelligence - just correct pattern matching and replacement.
 *
 * Benefits:
 * - Speed: <1s vs 30-60s for LLM
 * - Cost: 0 tokens vs ~2K tokens
 * - Reliability: AST-guaranteed correctness
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sessionLogger } from "./logger.js";

const logger = sessionLogger.child({ module: "fast-path" });

/**
 * Result of fast-path execution
 */
export interface FastPathResult {
	handled: boolean;
	success?: boolean;
	filesChanged?: string[];
	error?: string;
}

/**
 * Pattern definitions for common trivial tasks
 */
interface TaskPattern {
	/** Regex to match task description */
	match: RegExp;
	/** Function to extract parameters from task */
	extract: (task: string, match: RegExpMatchArray) => Record<string, string> | null;
	/** Function to generate ast-grep command */
	execute: (params: Record<string, string>, cwd: string) => FastPathResult;
}

/**
 * Check if ast-grep is available
 */
function isAstGrepAvailable(): boolean {
	try {
		execSync("ast-grep --version", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Run ast-grep with a pattern and replacement
 */
function runAstGrep(
	pattern: string,
	replacement: string,
	language: string,
	cwd: string,
	files?: string[],
): { success: boolean; filesChanged: string[]; error?: string } {
	try {
		// Build the command
		const fileArgs = files?.length ? files.map((f) => `"${f}"`).join(" ") : ".";

		// Use ast-grep's rewrite mode
		// Note: ast-grep uses YAML rules for complex rewrites, but for simple cases we can use --pattern and --rewrite
		const cmd = `ast-grep --pattern '${pattern}' --rewrite '${replacement}' --lang ${language} ${fileArgs} --update-all 2>&1`;

		logger.debug({ cmd, cwd }, "Running ast-grep");
		const output = execSync(cmd, { cwd, encoding: "utf-8", timeout: 30000 });

		// Parse output to find changed files
		const changedFiles: string[] = [];
		const lines = output.split("\n");
		for (const line of lines) {
			if (line.includes("rewritten") || line.includes("Updated")) {
				const match = line.match(/(\S+\.(?:ts|tsx|js|jsx))/);
				if (match) changedFiles.push(match[1]);
			}
		}

		return { success: true, filesChanged: changedFiles };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { success: false, filesChanged: [], error: msg };
	}
}

/**
 * Rename a symbol across files using ast-grep
 */
function executeRename(params: Record<string, string>, cwd: string): FastPathResult {
	const { oldName, newName, file } = params;

	if (!oldName || !newName) {
		return { handled: true, success: false, error: "Missing oldName or newName" };
	}

	// For TypeScript, we need to handle different contexts:
	// - Function declarations: function oldName() → function newName()
	// - Function calls: oldName() → newName()
	// - Identifiers: oldName → newName

	const patterns = [
		// Function/method calls
		{ pattern: `${oldName}($$$ARGS)`, replacement: `${newName}($$$ARGS)` },
		// Variable/function declarations (identifier pattern)
		{ pattern: oldName, replacement: newName },
	];

	const filesChanged: string[] = [];
	const targetFiles = file ? [file] : undefined;

	for (const { pattern, replacement } of patterns) {
		const result = runAstGrep(pattern, replacement, "typescript", cwd, targetFiles);
		if (result.filesChanged.length > 0) {
			filesChanged.push(...result.filesChanged);
		}
	}

	// Dedupe
	const uniqueFiles = [...new Set(filesChanged)];

	if (uniqueFiles.length === 0) {
		return { handled: true, success: false, error: `No occurrences of '${oldName}' found` };
	}

	logger.info({ oldName, newName, filesChanged: uniqueFiles }, "Rename completed via ast-grep");
	return { handled: true, success: true, filesChanged: uniqueFiles };
}

/**
 * Update a string literal value
 */
function executeUpdateValue(params: Record<string, string>, cwd: string): FastPathResult {
	const { file, oldValue, newValue } = params;

	if (!file || !oldValue || !newValue) {
		return { handled: true, success: false, error: "Missing file, oldValue, or newValue" };
	}

	if (!existsSync(`${cwd}/${file}`)) {
		return { handled: true, success: false, error: `File not found: ${file}` };
	}

	// For simple string replacements, just use file I/O (faster than ast-grep for literals)
	try {
		const content = readFileSync(`${cwd}/${file}`, "utf-8");
		if (!content.includes(oldValue)) {
			return { handled: true, success: false, error: `Value '${oldValue}' not found in ${file}` };
		}

		const newContent = content.replace(new RegExp(escapeRegExp(oldValue), "g"), newValue);
		writeFileSync(`${cwd}/${file}`, newContent);

		logger.info({ file, oldValue, newValue }, "Value updated via fast-path");
		return { handled: true, success: true, filesChanged: [file] };
	} catch (error) {
		return { handled: true, success: false, error: String(error) };
	}
}

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Task patterns we can handle via fast-path
 */
const TASK_PATTERNS: TaskPattern[] = [
	{
		// "Rename X to Y" or "Rename X to Y in file.ts"
		match: /rename\s+(\w+)\s+to\s+(\w+)(?:\s+in\s+([\w./]+))?/i,
		extract: (_, match) => ({
			oldName: match[1],
			newName: match[2],
			file: match[3] || "",
		}),
		execute: executeRename,
	},
	{
		// "Change/Update X to Y in file.ts"
		match: /(?:change|update)\s+["']?([^"']+)["']?\s+to\s+["']?([^"']+)["']?\s+in\s+([\w./]+)/i,
		extract: (_, match) => ({
			oldValue: match[1],
			newValue: match[2],
			file: match[3],
		}),
		execute: executeUpdateValue,
	},
	{
		// "In file.ts, rename X to Y"
		match: /in\s+([\w./]+),?\s+rename\s+(\w+)\s+to\s+(\w+)/i,
		extract: (_, match) => ({
			file: match[1],
			oldName: match[2],
			newName: match[3],
		}),
		execute: executeRename,
	},
];

/**
 * Attempt to handle a task via fast-path
 *
 * Returns { handled: false } if task doesn't match any patterns
 * Returns { handled: true, success: bool, ... } if attempted
 */
export function tryFastPath(task: string, cwd: string = process.cwd()): FastPathResult {
	// Check if ast-grep is available
	if (!isAstGrepAvailable()) {
		logger.debug("ast-grep not available, skipping fast-path");
		return { handled: false };
	}

	// Try each pattern
	for (const pattern of TASK_PATTERNS) {
		const match = task.match(pattern.match);
		if (match) {
			const params = pattern.extract(task, match);
			if (params) {
				logger.info({ task: task.substring(0, 50), pattern: pattern.match.source }, "Attempting fast-path");
				return pattern.execute(params, cwd);
			}
		}
	}

	return { handled: false };
}

/**
 * Check if a task might be fast-path eligible (for routing decisions)
 */
export function isFastPathCandidate(task: string): boolean {
	const taskLower = task.toLowerCase();

	// Keywords that suggest mechanical transformations
	const mechanicalKeywords = ["rename", "change to", "update to", "replace with"];

	return mechanicalKeywords.some((kw) => taskLower.includes(kw));
}
