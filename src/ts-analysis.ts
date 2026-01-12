/**
 * TypeScript Analysis Module
 *
 * Deep TypeScript AST analysis using ts-morph.
 * Extracts type definitions, function signatures, and finds symbol usages.
 *
 * Extracted from context.ts for better separation of concerns.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type FunctionDeclaration, type MethodDeclaration, Project, type SourceFile, SyntaxKind } from "ts-morph";
import { sessionLogger } from "./logger.js";

// Cached ts-morph project for reuse
let cachedProject: Project | null = null;
let cachedProjectPath: string | null = null;

/**
 * Get or create a ts-morph Project for the codebase
 */
function getTsMorphProject(cwd: string): Project | null {
	// Return cached project if same path
	if (cachedProject && cachedProjectPath === cwd) {
		return cachedProject;
	}

	try {
		const tsconfigPath = path.join(cwd, "tsconfig.json");
		if (!fs.existsSync(tsconfigPath)) {
			return null;
		}

		cachedProject = new Project({
			tsConfigFilePath: tsconfigPath,
			skipAddingFilesFromTsConfig: true, // We'll add files as needed
		});
		cachedProjectPath = cwd;
		return cachedProject;
	} catch (error) {
		sessionLogger.debug({ error: String(error) }, "Failed to create ts-morph project");
		return null;
	}
}

/**
 * Extract detailed function signatures using ts-morph
 * Returns signatures with full type information
 */
export function extractFunctionSignaturesWithTypes(filePath: string, cwd: string): string[] {
	const project = getTsMorphProject(cwd);
	if (!project) {
		return [];
	}

	const fullPath = path.join(cwd, filePath);
	if (!fs.existsSync(fullPath)) {
		return [];
	}

	try {
		// Add the file to the project
		let sourceFile: SourceFile;
		try {
			sourceFile = project.addSourceFileAtPath(fullPath);
		} catch {
			// File might already be added
			sourceFile = project.getSourceFile(fullPath) as SourceFile;
			if (!sourceFile) return [];
		}

		const signatures: string[] = [];
		const fileName = path.basename(filePath);

		// Get exported functions
		const functions = sourceFile.getFunctions().filter((f) => f.isExported());
		for (const func of functions) {
			const sig = formatFunctionSignature(func, fileName);
			if (sig) signatures.push(sig);
		}

		// Get exported arrow functions (const x = () => {})
		const variables = sourceFile.getVariableDeclarations();
		for (const variable of variables) {
			const parent = variable.getParent()?.getParent();
			if (!parent) continue;

			// Check if exported
			const isExported = parent.getFirstChildByKind(SyntaxKind.ExportKeyword) !== undefined;
			if (!isExported) continue;

			const initializer = variable.getInitializer();
			if (!initializer) continue;

			// Check if it's an arrow function
			if (initializer.getKind() === SyntaxKind.ArrowFunction) {
				const name = variable.getName();
				const type = variable.getType().getText();
				// Simplify type if too long
				const shortType = type.length > 80 ? `${type.slice(0, 77)}...` : type;
				signatures.push(`${fileName}: export const ${name}: ${shortType}`);
			}
		}

		// Get exported class methods
		const classes = sourceFile.getClasses().filter((c) => c.isExported());
		for (const cls of classes) {
			const className = cls.getName() || "AnonymousClass";
			const methods = cls.getMethods().filter((m) => m.getScope() === undefined || m.getScope() === "public");
			for (const method of methods.slice(0, 5)) {
				// Limit methods per class
				const sig = formatMethodSignature(method, className, fileName);
				if (sig) signatures.push(sig);
			}
		}

		return signatures.slice(0, 20); // Limit total signatures
	} catch (error) {
		sessionLogger.debug({ error: String(error), file: filePath }, "ts-morph extraction failed");
		return [];
	}
}

/**
 * Format a function declaration into a readable signature
 */
function formatFunctionSignature(func: FunctionDeclaration, fileName: string): string | null {
	try {
		const name = func.getName();
		if (!name) return null;

		const params = func
			.getParameters()
			.map((p) => {
				const paramName = p.getName();
				const paramType = p.getType().getText();
				// Shorten long types
				const shortType = paramType.length > 40 ? `${paramType.slice(0, 37)}...` : paramType;
				return `${paramName}: ${shortType}`;
			})
			.join(", ");

		const returnType = func.getReturnType().getText();
		const shortReturn = returnType.length > 40 ? `${returnType.slice(0, 37)}...` : returnType;
		const asyncPrefix = func.isAsync() ? "async " : "";

		return `${fileName}: ${asyncPrefix}function ${name}(${params}): ${shortReturn}`;
	} catch {
		return null;
	}
}

/**
 * Format a method declaration into a readable signature
 */
function formatMethodSignature(method: MethodDeclaration, className: string, fileName: string): string | null {
	try {
		const name = method.getName();
		const params = method
			.getParameters()
			.map((p) => {
				const paramName = p.getName();
				const paramType = p.getType().getText();
				const shortType = paramType.length > 30 ? `${paramType.slice(0, 27)}...` : paramType;
				return `${paramName}: ${shortType}`;
			})
			.join(", ");

		const returnType = method.getReturnType().getText();
		const shortReturn = returnType.length > 30 ? `${returnType.slice(0, 27)}...` : returnType;
		const asyncPrefix = method.isAsync() ? "async " : "";

		return `${fileName}: ${className}.${asyncPrefix}${name}(${params}): ${shortReturn}`;
	} catch {
		return null;
	}
}

/**
 * Extract interface and type definitions from a file
 */
export function extractTypeDefinitionsFromFile(filePath: string, cwd: string): string[] {
	const project = getTsMorphProject(cwd);
	if (!project) {
		return [];
	}

	const fullPath = path.join(cwd, filePath);
	if (!fs.existsSync(fullPath)) {
		return [];
	}

	try {
		let sourceFile: SourceFile;
		try {
			sourceFile = project.addSourceFileAtPath(fullPath);
		} catch {
			sourceFile = project.getSourceFile(fullPath) as SourceFile;
			if (!sourceFile) return [];
		}

		const definitions: string[] = [];

		// Get exported interfaces
		const interfaces = sourceFile.getInterfaces().filter((i) => i.isExported());
		for (const iface of interfaces) {
			const name = iface.getName();
			const props = iface
				.getProperties()
				.slice(0, 5)
				.map((p) => p.getName())
				.join(", ");
			const hasMore = iface.getProperties().length > 5 ? ", ..." : "";
			definitions.push(`interface ${name} { ${props}${hasMore} }`);
		}

		// Get exported type aliases
		const typeAliases = sourceFile.getTypeAliases().filter((t) => t.isExported());
		for (const typeAlias of typeAliases) {
			const name = typeAlias.getName();
			const typeText = typeAlias.getType().getText();
			const shortType = typeText.length > 60 ? `${typeText.slice(0, 57)}...` : typeText;
			definitions.push(`type ${name} = ${shortType}`);
		}

		return definitions.slice(0, 15);
	} catch (error) {
		sessionLogger.debug({ error: String(error), file: filePath }, "ts-morph type extraction failed");
		return [];
	}
}

/**
 * Find files that import a specific symbol
 */
export function findFilesImporting(symbolName: string, cwd: string): string[] {
	const project = getTsMorphProject(cwd);
	if (!project) {
		return [];
	}

	try {
		// Use git grep for speed, then validate with ts-morph if needed
		const result = execSync(`git grep -l "import.*${symbolName}" -- "*.ts" "*.tsx" 2>/dev/null || true`, {
			encoding: "utf-8",
			cwd,
			timeout: 5000,
		});

		return result
			.trim()
			.split("\n")
			.filter(Boolean)
			.filter((f) => !f.includes("node_modules") && !f.includes(".test."))
			.slice(0, 10);
	} catch {
		return [];
	}
}

/**
 * Get the full definition of a type by name
 */
export function getTypeDefinition(typeName: string, cwd: string): string | null {
	const project = getTsMorphProject(cwd);
	if (!project) {
		return null;
	}

	try {
		// Common locations to check
		const schemaPath = path.join(cwd, "common/schema/index.ts");

		if (fs.existsSync(schemaPath)) {
			let sourceFile: SourceFile;
			try {
				sourceFile = project.addSourceFileAtPath(schemaPath);
			} catch {
				sourceFile = project.getSourceFile(schemaPath) as SourceFile;
				if (!sourceFile) return null;
			}

			// Look for interface
			const iface = sourceFile.getInterface(typeName);
			if (iface) {
				const text = iface.getText();
				return text.length > 500 ? `${text.slice(0, 497)}...` : text;
			}

			// Look for type alias
			const typeAlias = sourceFile.getTypeAlias(typeName);
			if (typeAlias) {
				const text = typeAlias.getText();
				return text.length > 500 ? `${text.slice(0, 497)}...` : text;
			}
		}

		return null;
	} catch {
		return null;
	}
}
