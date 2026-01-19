/**
 * Local Caching for Token Savings
 *
 * Caches computed context to avoid redundant LLM processing:
 * - File content hashes (don't re-summarize unchanged files)
 * - Successful fixes (reuse solutions for similar errors)
 * - Dependency graphs (pre-computed relationships)
 *
 * All caching is local - no LLM tokens consumed.
 */

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Cache entry with hash and timestamp
 */
interface CacheEntry<T> {
	hash: string;
	timestamp: number;
	data: T;
}

/**
 * File summary cache - avoids re-reading unchanged files
 */
interface FileSummary {
	path: string;
	exports: string[];
	imports: string[];
	functions: string[];
	lineCount: number;
}

/**
 * Error fix cache - remember what fixed similar errors
 */
interface ErrorFix {
	errorPattern: string;
	file: string;
	fix: string;
	success: boolean;
}

/**
 * In-memory cache store
 */
class ContextCache {
	private fileHashes: Map<string, string> = new Map();
	private fileSummaries: Map<string, CacheEntry<FileSummary>> = new Map();
	private errorFixes: Map<string, ErrorFix[]> = new Map();
	private importGraph: Map<string, string[]> = new Map();
	private cacheDir: string;

	constructor(cwd: string = process.cwd()) {
		this.cacheDir = path.join(cwd, ".undercity", "cache");
		this.ensureCacheDir();
		this.loadPersistentCache();
	}

	private ensureCacheDir(): void {
		if (!fs.existsSync(this.cacheDir)) {
			fs.mkdirSync(this.cacheDir, { recursive: true });
		}
	}

	private loadPersistentCache(): void {
		try {
			const fixesPath = path.join(this.cacheDir, "error-fixes.json");
			if (fs.existsSync(fixesPath)) {
				const data = JSON.parse(fs.readFileSync(fixesPath, "utf-8"));
				this.errorFixes = new Map(Object.entries(data));
			}
		} catch {
			// Cache load failed, start fresh
		}
	}

	private savePersistentCache(): void {
		try {
			const fixesPath = path.join(this.cacheDir, "error-fixes.json");
			const tempPath = `${fixesPath}.tmp`;
			const data = Object.fromEntries(this.errorFixes);

			// Write to temporary file first
			fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), {
				encoding: "utf-8",
				flag: "w",
			});

			// Atomically rename temporary file to target file
			fs.renameSync(tempPath, fixesPath);
		} catch (_error) {
			// Clean up temporary file if it exists
			const fixesPath = path.join(this.cacheDir, "error-fixes.json");
			const tempPath = `${fixesPath}.tmp`;
			if (fs.existsSync(tempPath)) {
				fs.unlinkSync(tempPath);
			}
			// Cache save failed, non-fatal
		}
	}

	/**
	 * Get hash of file content
	 */
	getFileHash(filePath: string): string | null {
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const hash = crypto.createHash("md5").update(content).digest("hex");
			this.fileHashes.set(filePath, hash);
			return hash;
		} catch {
			return null;
		}
	}

	/**
	 * Check if file has changed since last read
	 */
	hasFileChanged(filePath: string): boolean {
		const oldHash = this.fileHashes.get(filePath);
		const newHash = this.getFileHash(filePath);
		return oldHash !== newHash;
	}

	/**
	 * Get cached file summary if file unchanged
	 */
	getFileSummary(filePath: string): FileSummary | null {
		const entry = this.fileSummaries.get(filePath);
		if (!entry) return null;

		const currentHash = this.getFileHash(filePath);
		if (currentHash !== entry.hash) {
			this.fileSummaries.delete(filePath);
			return null;
		}

		return entry.data;
	}

	/**
	 * Cache a file summary
	 */
	setFileSummary(filePath: string, summary: FileSummary): void {
		const hash = this.getFileHash(filePath);
		if (hash) {
			this.fileSummaries.set(filePath, {
				hash,
				timestamp: Date.now(),
				data: summary,
			});
		}
	}

	/**
	 * Record a successful error fix
	 */
	recordErrorFix(errorPattern: string, file: string, fix: string, success: boolean): void {
		const key = this.normalizeErrorPattern(errorPattern);
		const fixes = this.errorFixes.get(key) || [];
		fixes.push({ errorPattern, file, fix, success });
		this.errorFixes.set(key, fixes);
		this.savePersistentCache();
	}

	/**
	 * Find previous fixes for similar errors
	 */
	findSimilarFixes(errorPattern: string): ErrorFix[] {
		// Defensive: validate input
		if (!errorPattern || typeof errorPattern !== "string") {
			return [];
		}

		const key = this.normalizeErrorPattern(errorPattern);
		const fixes = this.errorFixes.get(key) || [];

		// Defensive: filter for valid error fix objects
		return Array.isArray(fixes) ? fixes.filter((f) => f && typeof f.success === "boolean" && f.success) : [];
	}

	/**
	 * Normalize error pattern for matching
	 */
	private normalizeErrorPattern(error: string): string {
		// Remove line numbers, file paths, and variable names
		return error
			.replace(/:\d+:\d+/g, "") // Remove line:column
			.replace(/\/[\w/-]+\.(ts|tsx|js)/g, "FILE") // Normalize paths
			.replace(/'[^']+'/g, "'X'") // Normalize quoted strings
			.replace(/\d+/g, "N") // Normalize numbers
			.trim()
			.toLowerCase();
	}

	/**
	 * Build import graph for a directory
	 */
	buildImportGraph(cwd: string): Map<string, string[]> {
		if (this.importGraph.size > 0) {
			return this.importGraph;
		}

		try {
			// Use grep to find all imports quickly
			const result = execSync(`grep -r "^import.*from" --include="*.ts" --include="*.tsx" . 2>/dev/null || true`, {
				encoding: "utf-8",
				cwd,
				timeout: 10000,
			});

			const lines = result.split("\n").filter(Boolean);
			for (const line of lines) {
				const match = line.match(/^\.\/([^:]+):.*from\s+['"]([^'"]+)['"]/);
				if (match) {
					const [, file, imported] = match;
					const imports = this.importGraph.get(file) || [];
					imports.push(imported);
					this.importGraph.set(file, imports);
				}
			}
		} catch {
			// Graph building failed, non-fatal
		}

		return this.importGraph;
	}

	/**
	 * Get files that import a given file
	 */
	getImporters(filePath: string, cwd: string): string[] {
		const graph = this.buildImportGraph(cwd);
		const importers: string[] = [];
		const baseName = path.basename(filePath, path.extname(filePath));

		for (const [file, imports] of graph) {
			if (imports.some((i) => i.includes(baseName))) {
				importers.push(file);
			}
		}

		return importers;
	}

	/**
	 * Clear all caches
	 */
	clear(): void {
		this.fileHashes.clear();
		this.fileSummaries.clear();
		this.importGraph.clear();
		// Don't clear errorFixes - those are valuable long-term
	}
}

// Singleton instance
let cacheInstance: ContextCache | null = null;

export function getCache(cwd?: string): ContextCache {
	if (!cacheInstance) {
		cacheInstance = new ContextCache(cwd);
	}
	return cacheInstance;
}

/**
 * Get only the changed portions of files for context
 * Returns git diff focused on the relevant changes
 */
export function getChangedContext(files: string[], cwd: string = process.cwd()): string {
	const changes: string[] = [];

	for (const file of files.slice(0, 5)) {
		try {
			// Get unified diff (3 lines of context)
			const diff = execSync(`git diff -U3 HEAD -- "${file}" 2>/dev/null || true`, {
				encoding: "utf-8",
				cwd,
				timeout: 5000,
			});

			if (diff.trim()) {
				changes.push(`### ${file}\n\`\`\`diff\n${diff.slice(0, 1000)}\n\`\`\``);
			}
		} catch {
			// Skip files that fail
		}
	}

	return changes.join("\n\n");
}

/**
 * Compress context by removing comments and extra whitespace
 */
export function compressContext(content: string): string {
	return (
		content
			// Remove single-line comments (but keep URLs)
			.replace(/(?<!:)\/\/(?!.*https?:).*/g, "")
			// Remove multi-line comments
			.replace(/\/\*[\s\S]*?\*\//g, "")
			// Remove JSDoc comments
			.replace(/\/\*\*[\s\S]*?\*\//g, "")
			// Collapse multiple newlines to single
			.replace(/\n{3,}/g, "\n\n")
			// Collapse multiple spaces to single
			.replace(/ {2,}/g, " ")
			// Remove trailing whitespace
			.replace(/[ \t]+$/gm, "")
			.trim()
	);
}

/**
 * Parse TypeScript errors into structured format
 * Much smaller than raw tsc output
 */
export interface StructuredError {
	file: string;
	line: number;
	column: number;
	code: string;
	message: string;
	suggestion?: string;
}

export function parseTypeScriptErrors(tscOutput: string): StructuredError[] {
	const errors: StructuredError[] = [];
	const lines = tscOutput.split("\n");

	for (const line of lines) {
		// Match: src/file.ts(10,5): error TS2345: Argument...
		const match = line.match(/^(.+)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/);
		if (match) {
			const [, file, lineNum, col, code, message] = match;
			errors.push({
				file,
				line: parseInt(lineNum, 10),
				column: parseInt(col, 10),
				code,
				message: message.trim(),
				suggestion: getSuggestionForError(code, message),
			});
		}
	}

	return errors;
}

/**
 * Get suggestion for common TypeScript errors
 */
function getSuggestionForError(code: string, _message: string): string | undefined {
	const suggestions: Record<string, string> = {
		TS2345: "Check argument types match parameter types",
		TS2322: "Check assignment types are compatible",
		TS2304: "Import the missing type or declare it",
		TS2339: "Property doesn't exist - check spelling or add to interface",
		TS2551: "Did you mean a different property name?",
		TS2307: "Module not found - check import path",
		TS2305: "Export doesn't exist in module - check export name",
		TS7006: "Add type annotation to parameter",
		TS2532: "Object is possibly undefined - add null check",
		TS2531: "Object is possibly null - add null check",
	};

	return suggestions[code];
}

/**
 * Format structured errors into concise feedback
 */
export function formatErrorsForAgent(errors: StructuredError[]): string {
	if (errors.length === 0) return "";

	const grouped = new Map<string, StructuredError[]>();
	for (const error of errors) {
		const existing = grouped.get(error.file) || [];
		existing.push(error);
		grouped.set(error.file, existing);
	}

	const parts: string[] = [`Found ${errors.length} type error(s):\n`];

	for (const [file, fileErrors] of grouped) {
		parts.push(`\n${file}:`);
		for (const err of fileErrors.slice(0, 3)) {
			// Limit per file
			parts.push(`  L${err.line}: ${err.code} - ${err.message.slice(0, 80)}`);
			if (err.suggestion) {
				parts.push(`    → ${err.suggestion}`);
			}
		}
		if (fileErrors.length > 3) {
			parts.push(`  ... and ${fileErrors.length - 3} more in this file`);
		}
	}

	return parts.join("\n");
}

/**
 * Parse Biome lint errors into structured format
 */
export function parseLintErrors(lintOutput: string): StructuredError[] {
	const errors: StructuredError[] = [];
	const lines = lintOutput.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Match Biome format: path/file.ts:10:5 lint/rule
		const match = line.match(/^(.+):(\d+):(\d+)\s+([\w/]+)/);
		if (match) {
			const [, file, lineNum, col, code] = match;
			// Next line usually has the message
			const message = lines[i + 1]?.trim() || code;
			errors.push({
				file,
				line: parseInt(lineNum, 10),
				column: parseInt(col, 10),
				code,
				message: message.slice(0, 100),
			});
		}
	}

	return errors;
}
