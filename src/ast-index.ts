/**
 * AST Index Manager
 *
 * Persistent index of TypeScript AST information for smart context selection.
 * - Tracks exports (functions, classes, types) per file
 * - Maps dependencies (imports/importedBy)
 * - Incremental updates via content hash invalidation
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Project, type SourceFile, SyntaxKind } from "ts-morph";
import { sessionLogger } from "./logger.js";

const INDEX_VERSION = "1.0";
const INDEX_FILENAME = "ast-index.json";

// ============================================================================
// Types
// ============================================================================

/**
 * Exported symbol from a file
 */
export interface ExportedSymbol {
	name: string;
	kind: "function" | "class" | "interface" | "type" | "const" | "enum";
	signature?: string;
	line: number;
}

/**
 * Import statement information
 */
export interface ImportInfo {
	moduleSpecifier: string;
	resolvedPath: string | null;
	namedImports: string[];
	defaultImport?: string;
	namespaceImport?: string;
	isTypeOnly: boolean;
}

/**
 * Per-file AST information
 */
export interface FileASTInfo {
	path: string;
	hash: string;
	indexedAt: string;
	exports: ExportedSymbol[];
	imports: ImportInfo[];
	/** Auto-generated 1-2 line summary of file purpose */
	summary?: string;
}

/**
 * The full AST index (persisted to disk)
 */
export interface ASTIndex {
	version: string;
	files: Record<string, FileASTInfo>;
	symbolToFiles: Record<string, string[]>;
	importedBy: Record<string, string[]>;
	lastUpdated: string;
}

// ============================================================================
// AST Index Manager
// ============================================================================

const logger = sessionLogger.child({ module: "ast-index" });

export class ASTIndexManager {
	private index: ASTIndex;
	private project: Project | null = null;
	private indexPath: string;
	private repoRoot: string;
	private dirty = false;

	constructor(repoRoot: string = process.cwd()) {
		this.repoRoot = repoRoot;
		this.indexPath = path.join(repoRoot, ".undercity", INDEX_FILENAME);
		this.index = this.createEmptyIndex();
	}

	// ==========================================================================
	// Lifecycle
	// ==========================================================================

	/**
	 * Load index from disk. Returns empty index if missing/corrupt.
	 */
	async load(): Promise<void> {
		try {
			if (!fs.existsSync(this.indexPath)) {
				logger.debug("No existing index found, starting fresh");
				return;
			}

			const content = fs.readFileSync(this.indexPath, "utf-8");
			const data = JSON.parse(content) as ASTIndex;

			if (data.version !== INDEX_VERSION) {
				logger.info({ oldVersion: data.version, newVersion: INDEX_VERSION }, "Index version mismatch, rebuilding");
				return;
			}

			this.index = data;
			logger.debug({ fileCount: Object.keys(data.files).length }, "Loaded AST index");
		} catch (error) {
			logger.warn({ error: String(error) }, "Failed to load AST index, starting fresh");
			this.index = this.createEmptyIndex();
		}
	}

	/**
	 * Save index to disk (atomic write via temp file)
	 */
	async save(): Promise<void> {
		if (!this.dirty) {
			return;
		}

		try {
			const dir = path.dirname(this.indexPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			const tempPath = `${this.indexPath}.tmp`;
			this.index.lastUpdated = new Date().toISOString();

			fs.writeFileSync(tempPath, JSON.stringify(this.index, null, 2));
			fs.renameSync(tempPath, this.indexPath);

			this.dirty = false;
			logger.debug({ fileCount: Object.keys(this.index.files).length }, "Saved AST index");
		} catch (error) {
			logger.error({ error: String(error) }, "Failed to save AST index");
			// Clean up temp file if it exists
			const tempPath = `${this.indexPath}.tmp`;
			if (fs.existsSync(tempPath)) {
				fs.unlinkSync(tempPath);
			}
		}
	}

	/**
	 * Create empty index structure
	 */
	private createEmptyIndex(): ASTIndex {
		return {
			version: INDEX_VERSION,
			files: {},
			symbolToFiles: {},
			importedBy: {},
			lastUpdated: new Date().toISOString(),
		};
	}

	// ==========================================================================
	// Querying
	// ==========================================================================

	/**
	 * Find file(s) that export a symbol
	 */
	findSymbolDefinition(symbolName: string): string[] {
		return this.index.symbolToFiles[symbolName] || [];
	}

	/**
	 * Find files that import a given file
	 */
	findImporters(filePath: string): string[] {
		const normalizedPath = this.normalizePath(filePath);
		return this.index.importedBy[normalizedPath] || [];
	}

	/**
	 * Find files that a given file imports (local only)
	 */
	findImports(filePath: string): string[] {
		const normalizedPath = this.normalizePath(filePath);
		const fileInfo = this.index.files[normalizedPath];
		if (!fileInfo) return [];

		return fileInfo.imports.filter((i) => i.resolvedPath).map((i) => i.resolvedPath as string);
	}

	/**
	 * Get exported symbol info by name
	 */
	getSymbolInfo(symbolName: string): ExportedSymbol | null {
		const files = this.findSymbolDefinition(symbolName);
		if (files.length === 0) return null;

		const fileInfo = this.index.files[files[0]];
		if (!fileInfo) return null;

		return fileInfo.exports.find((e) => e.name === symbolName) || null;
	}

	/**
	 * Get all exports from a file
	 */
	getFileExports(filePath: string): ExportedSymbol[] {
		const normalizedPath = this.normalizePath(filePath);
		return this.index.files[normalizedPath]?.exports || [];
	}

	/**
	 * Search symbols by pattern
	 */
	searchSymbols(pattern: RegExp): ExportedSymbol[] {
		const results: ExportedSymbol[] = [];
		for (const fileInfo of Object.values(this.index.files)) {
			for (const exp of fileInfo.exports) {
				if (pattern.test(exp.name)) {
					results.push(exp);
				}
			}
		}
		return results;
	}

	/**
	 * Get file info
	 */
	getFileInfo(filePath: string): FileASTInfo | null {
		const normalizedPath = this.normalizePath(filePath);
		return this.index.files[normalizedPath] || null;
	}

	/**
	 * Get summary for a specific file
	 */
	getFileSummary(filePath: string): string | null {
		const info = this.getFileInfo(filePath);
		return info?.summary || null;
	}

	/**
	 * Get summaries for multiple files (useful for context preparation)
	 */
	getFileSummaries(filePaths: string[]): Record<string, string> {
		const summaries: Record<string, string> = {};
		for (const filePath of filePaths) {
			const summary = this.getFileSummary(filePath);
			if (summary) {
				summaries[filePath] = summary;
			}
		}
		return summaries;
	}

	/**
	 * Get all file summaries (for overview/debugging)
	 */
	getAllSummaries(): Array<{ path: string; summary: string }> {
		return Object.values(this.index.files)
			.filter((f) => f.summary)
			.map((f) => ({ path: f.path, summary: f.summary as string }))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	/**
	 * Get index statistics
	 */
	getStats(): { fileCount: number; symbolCount: number; lastUpdated: string } {
		return {
			fileCount: Object.keys(this.index.files).length,
			symbolCount: Object.keys(this.index.symbolToFiles).length,
			lastUpdated: this.index.lastUpdated,
		};
	}

	// ==========================================================================
	// Updating
	// ==========================================================================

	/**
	 * Check if a file needs re-indexing
	 */
	isStale(filePath: string): boolean {
		const normalizedPath = this.normalizePath(filePath);
		const fullPath = path.join(this.repoRoot, normalizedPath);

		if (!fs.existsSync(fullPath)) {
			return false;
		}

		const currentHash = this.computeFileHash(fullPath);
		const cachedInfo = this.index.files[normalizedPath];

		if (!cachedInfo) return true;
		return cachedInfo.hash !== currentHash;
	}

	/**
	 * Index a single file
	 * Returns true if file was updated, false if unchanged
	 */
	async indexFile(filePath: string): Promise<boolean> {
		const normalizedPath = this.normalizePath(filePath);
		const fullPath = path.join(this.repoRoot, normalizedPath);

		if (!fs.existsSync(fullPath)) {
			this.removeFile(normalizedPath);
			return true;
		}

		const currentHash = this.computeFileHash(fullPath);
		const cachedInfo = this.index.files[normalizedPath];

		// Skip if unchanged
		if (cachedInfo && cachedInfo.hash === currentHash) {
			return false;
		}

		// Parse and extract info
		const fileInfo = await this.extractFileInfo(normalizedPath, fullPath, currentHash);
		if (!fileInfo) {
			return false;
		}

		// Remove old entries from reverse lookups
		if (cachedInfo) {
			this.removeFromReverseLookups(normalizedPath, cachedInfo);
		}

		// Add new entries
		this.index.files[normalizedPath] = fileInfo;
		this.addToReverseLookups(normalizedPath, fileInfo);

		this.dirty = true;
		return true;
	}

	/**
	 * Index multiple files
	 * Returns count of files updated
	 */
	async indexFiles(filePaths: string[]): Promise<number> {
		let updated = 0;
		for (const filePath of filePaths) {
			const wasUpdated = await this.indexFile(filePath);
			if (wasUpdated) updated++;
		}
		return updated;
	}

	/**
	 * Incremental update - index only changed files
	 */
	async updateIncremental(changedFiles?: string[]): Promise<number> {
		const filesToCheck = changedFiles || this.getTrackedFiles();
		const staleFiles = filesToCheck.filter((f) => this.isStale(f));

		if (staleFiles.length === 0) {
			return 0;
		}

		logger.debug({ count: staleFiles.length }, "Updating stale files");
		const updated = await this.indexFiles(staleFiles);
		await this.save();

		return updated;
	}

	/**
	 * Full rebuild of the index
	 */
	async rebuildFull(): Promise<void> {
		logger.info("Starting full index rebuild");

		this.index = this.createEmptyIndex();
		this.project = null; // Reset project to pick up new files

		const files = this.findTypeScriptFiles();
		logger.debug({ count: files.length }, "Found TypeScript files");

		let indexed = 0;
		for (const file of files) {
			const wasIndexed = await this.indexFile(file);
			if (wasIndexed) indexed++;
		}

		this.dirty = true;
		await this.save();

		logger.info({ indexed, total: files.length }, "Full index rebuild complete");
	}

	/**
	 * Remove a file from the index
	 */
	removeFile(filePath: string): void {
		const normalizedPath = this.normalizePath(filePath);
		const fileInfo = this.index.files[normalizedPath];

		if (fileInfo) {
			this.removeFromReverseLookups(normalizedPath, fileInfo);
			delete this.index.files[normalizedPath];
			this.dirty = true;
		}
	}

	// ==========================================================================
	// Private Helpers
	// ==========================================================================

	/**
	 * Get or create ts-morph Project
	 */
	private getProject(): Project | null {
		if (this.project) return this.project;

		try {
			const tsconfigPath = path.join(this.repoRoot, "tsconfig.json");
			if (!fs.existsSync(tsconfigPath)) {
				return null;
			}

			this.project = new Project({
				tsConfigFilePath: tsconfigPath,
				skipAddingFilesFromTsConfig: true,
			});
			return this.project;
		} catch (error) {
			logger.debug({ error: String(error) }, "Failed to create ts-morph project");
			return null;
		}
	}

	/**
	 * Extract AST info from a file
	 */
	private async extractFileInfo(normalizedPath: string, fullPath: string, hash: string): Promise<FileASTInfo | null> {
		const project = this.getProject();
		if (!project) return null;

		try {
			let sourceFile: SourceFile;
			try {
				sourceFile = project.addSourceFileAtPath(fullPath);
			} catch {
				const existing = project.getSourceFile(fullPath);
				if (!existing) return null;
				sourceFile = existing;
			}

			const exports = this.extractExports(sourceFile);
			const imports = this.extractImports(sourceFile, normalizedPath);
			const summary = this.generateSummary(normalizedPath, exports, imports);

			return {
				path: normalizedPath,
				hash,
				indexedAt: new Date().toISOString(),
				exports,
				imports,
				summary,
			};
		} catch (error) {
			logger.debug({ error: String(error), file: normalizedPath }, "Failed to extract file info");
			return null;
		}
	}

	/**
	 * Extract exported symbols from a source file
	 */
	private extractExports(sourceFile: SourceFile): ExportedSymbol[] {
		const exports: ExportedSymbol[] = [];

		// Functions
		for (const func of sourceFile.getFunctions().filter((f) => f.isExported())) {
			const name = func.getName();
			if (!name) continue;
			exports.push({
				name,
				kind: "function",
				signature: this.formatSignature(func.getText().split("{")[0].trim()),
				line: func.getStartLineNumber(),
			});
		}

		// Classes
		for (const cls of sourceFile.getClasses().filter((c) => c.isExported())) {
			const name = cls.getName();
			if (!name) continue;
			exports.push({
				name,
				kind: "class",
				line: cls.getStartLineNumber(),
			});
		}

		// Interfaces
		for (const iface of sourceFile.getInterfaces().filter((i) => i.isExported())) {
			exports.push({
				name: iface.getName(),
				kind: "interface",
				line: iface.getStartLineNumber(),
			});
		}

		// Type aliases
		for (const typeAlias of sourceFile.getTypeAliases().filter((t) => t.isExported())) {
			exports.push({
				name: typeAlias.getName(),
				kind: "type",
				line: typeAlias.getStartLineNumber(),
			});
		}

		// Enums
		for (const enumDecl of sourceFile.getEnums().filter((e) => e.isExported())) {
			exports.push({
				name: enumDecl.getName(),
				kind: "enum",
				line: enumDecl.getStartLineNumber(),
			});
		}

		// Exported const/let variables
		for (const varDecl of sourceFile.getVariableDeclarations()) {
			const varStmt = varDecl.getParent()?.getParent();
			if (!varStmt) continue;

			const isExported = varStmt.getFirstChildByKind(SyntaxKind.ExportKeyword) !== undefined;
			if (!isExported) continue;

			exports.push({
				name: varDecl.getName(),
				kind: "const",
				line: varDecl.getStartLineNumber(),
			});
		}

		return exports;
	}

	/**
	 * Extract imports from a source file
	 */
	private extractImports(sourceFile: SourceFile, currentFilePath: string): ImportInfo[] {
		const imports: ImportInfo[] = [];

		for (const importDecl of sourceFile.getImportDeclarations()) {
			const moduleSpecifier = importDecl.getModuleSpecifierValue();
			const resolvedPath = this.resolveImportPath(moduleSpecifier, currentFilePath);

			const namedImports: string[] = [];
			for (const named of importDecl.getNamedImports()) {
				namedImports.push(named.getName());
			}

			imports.push({
				moduleSpecifier,
				resolvedPath,
				namedImports,
				defaultImport: importDecl.getDefaultImport()?.getText(),
				namespaceImport: importDecl.getNamespaceImport()?.getText(),
				isTypeOnly: importDecl.isTypeOnly(),
			});
		}

		return imports;
	}

	/**
	 * Resolve import path to actual file path
	 */
	private resolveImportPath(moduleSpecifier: string, currentFilePath: string): string | null {
		// Skip external packages
		if (!moduleSpecifier.startsWith(".") && !moduleSpecifier.startsWith("/")) {
			return null;
		}

		const currentDir = path.dirname(currentFilePath);
		let resolved = path.join(currentDir, moduleSpecifier);

		// Handle .js -> .ts mapping
		if (resolved.endsWith(".js")) {
			resolved = resolved.replace(/\.js$/, ".ts");
		}

		// Add .ts extension if missing
		if (!resolved.endsWith(".ts") && !resolved.endsWith(".tsx")) {
			if (fs.existsSync(path.join(this.repoRoot, `${resolved}.ts`))) {
				resolved = `${resolved}.ts`;
			} else if (fs.existsSync(path.join(this.repoRoot, `${resolved}/index.ts`))) {
				resolved = `${resolved}/index.ts`;
			}
		}

		// Normalize the path
		resolved = path.normalize(resolved);

		return resolved;
	}

	/**
	 * Add file to reverse lookup maps
	 */
	private addToReverseLookups(filePath: string, fileInfo: FileASTInfo): void {
		// Symbol -> Files
		for (const exp of fileInfo.exports) {
			if (!this.index.symbolToFiles[exp.name]) {
				this.index.symbolToFiles[exp.name] = [];
			}
			if (!this.index.symbolToFiles[exp.name].includes(filePath)) {
				this.index.symbolToFiles[exp.name].push(filePath);
			}
		}

		// ImportedBy
		for (const imp of fileInfo.imports) {
			if (imp.resolvedPath) {
				if (!this.index.importedBy[imp.resolvedPath]) {
					this.index.importedBy[imp.resolvedPath] = [];
				}
				if (!this.index.importedBy[imp.resolvedPath].includes(filePath)) {
					this.index.importedBy[imp.resolvedPath].push(filePath);
				}
			}
		}
	}

	/**
	 * Remove file from reverse lookup maps
	 */
	private removeFromReverseLookups(filePath: string, fileInfo: FileASTInfo): void {
		// Symbol -> Files
		for (const exp of fileInfo.exports) {
			const files = this.index.symbolToFiles[exp.name];
			if (files) {
				const idx = files.indexOf(filePath);
				if (idx !== -1) files.splice(idx, 1);
				if (files.length === 0) delete this.index.symbolToFiles[exp.name];
			}
		}

		// ImportedBy
		for (const imp of fileInfo.imports) {
			if (imp.resolvedPath) {
				const importers = this.index.importedBy[imp.resolvedPath];
				if (importers) {
					const idx = importers.indexOf(filePath);
					if (idx !== -1) importers.splice(idx, 1);
					if (importers.length === 0) delete this.index.importedBy[imp.resolvedPath];
				}
			}
		}
	}

	/**
	 * Compute MD5 hash of file content
	 */
	private computeFileHash(fullPath: string): string {
		const content = fs.readFileSync(fullPath, "utf-8");
		return crypto.createHash("md5").update(content).digest("hex");
	}

	/**
	 * Normalize file path (relative to repo root, forward slashes)
	 */
	private normalizePath(filePath: string): string {
		let normalized = filePath;

		// Make relative if absolute
		if (path.isAbsolute(normalized)) {
			normalized = path.relative(this.repoRoot, normalized);
		}

		// Use forward slashes
		normalized = normalized.replace(/\\/g, "/");

		return normalized;
	}

	/**
	 * Get all currently tracked files
	 */
	private getTrackedFiles(): string[] {
		return Object.keys(this.index.files);
	}

	/**
	 * Find all TypeScript files in the repo
	 */
	private findTypeScriptFiles(): string[] {
		const files: string[] = [];

		const walk = (dir: string): void => {
			const entries = fs.readdirSync(path.join(this.repoRoot, dir), { withFileTypes: true });

			for (const entry of entries) {
				const relativePath = path.join(dir, entry.name);

				// Skip common directories
				if (entry.isDirectory()) {
					if (["node_modules", "dist", "coverage", ".git", ".undercity"].includes(entry.name)) {
						continue;
					}
					walk(relativePath);
				} else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
					// Skip test files for now
					if (!entry.name.includes(".test.") && !entry.name.includes(".spec.")) {
						files.push(relativePath.replace(/\\/g, "/"));
					}
				}
			}
		};

		walk("src");
		return files;
	}

	/**
	 * Format signature for display (truncate long signatures)
	 */
	private formatSignature(sig: string): string {
		const cleaned = sig.replace(/\s+/g, " ").trim();
		return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
	}

	/**
	 * Generate a 1-2 line summary of file purpose based on exports
	 */
	private generateSummary(filePath: string, exports: ExportedSymbol[], imports: ImportInfo[]): string {
		const fileName = path.basename(filePath, ".ts");
		const parts: string[] = [];

		// Group exports by kind
		const byKind: Record<string, string[]> = {};
		for (const exp of exports) {
			if (!byKind[exp.kind]) byKind[exp.kind] = [];
			byKind[exp.kind].push(exp.name);
		}

		// Build summary based on what's exported
		if (byKind.class?.length) {
			const classes = byKind.class.slice(0, 3).join(", ");
			const more = byKind.class.length > 3 ? ` (+${byKind.class.length - 3})` : "";
			parts.push(`Classes: ${classes}${more}`);
		}

		if (byKind.function?.length) {
			const funcs = byKind.function.slice(0, 4).join(", ");
			const more = byKind.function.length > 4 ? ` (+${byKind.function.length - 4})` : "";
			parts.push(`Functions: ${funcs}${more}`);
		}

		if (byKind.interface?.length || byKind.type?.length) {
			const types = [...(byKind.interface || []), ...(byKind.type || [])];
			const shown = types.slice(0, 4).join(", ");
			const more = types.length > 4 ? ` (+${types.length - 4})` : "";
			parts.push(`Types: ${shown}${more}`);
		}

		if (byKind.const?.length && !byKind.class?.length && !byKind.function?.length) {
			const consts = byKind.const.slice(0, 4).join(", ");
			const more = byKind.const.length > 4 ? ` (+${byKind.const.length - 4})` : "";
			parts.push(`Constants: ${consts}${more}`);
		}

		// Add dependency context if notable
		const localImports = imports.filter((i) => i.resolvedPath).length;

		if (parts.length === 0) {
			// No exports - might be entry point or config
			if (localImports > 5) {
				return `${fileName}: Orchestration module (imports ${localImports} local modules)`;
			}
			return `${fileName}: Internal module (no exports)`;
		}

		const summary = parts.join(". ");
		if (summary.length > 120) {
			return summary.slice(0, 117) + "...";
		}
		return summary;
	}
}

// ============================================================================
// Singleton
// ============================================================================

let indexInstance: ASTIndexManager | null = null;

/**
 * Get or create AST index manager singleton
 */
export function getASTIndex(repoRoot?: string): ASTIndexManager {
	if (!indexInstance) {
		indexInstance = new ASTIndexManager(repoRoot);
	}
	return indexInstance;
}

/**
 * Reset singleton (for testing)
 */
export function resetASTIndex(): void {
	indexInstance = null;
}
