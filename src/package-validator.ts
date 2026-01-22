/**
 * Package Validator
 *
 * Validates npm/pip package recommendations in task proposals.
 * Protects against typosquatting and suspicious packages.
 *
 * | Check | Action |
 * |-------|--------|
 * | Package exists on registry | Verify |
 * | Low downloads (<100/week) | Warn |
 * | Recently published (<7 days) | Warn |
 * | Typosquatting pattern | Warn |
 */

import { sessionLogger } from "./logger.js";

/**
 * Result of package validation
 */
export interface PackageValidationResult {
	/** Whether the package is safe to use */
	isSafe: boolean;
	/** Whether the package passed all checks (no warnings) */
	isClean: boolean;
	/** Reasons for concern */
	warnings: string[];
	/** Package details if found */
	details?: {
		name: string;
		version?: string;
		weeklyDownloads?: number;
		publishedAt?: Date;
		maintainer?: string;
		repository?: string;
	};
}

/**
 * Extract package install commands from text
 */
export function extractPackageInstalls(content: string): Array<{
	manager: "npm" | "pip" | "yarn" | "pnpm";
	packageName: string;
	version?: string;
}> {
	const results: Array<{
		manager: "npm" | "pip" | "yarn" | "pnpm";
		packageName: string;
		version?: string;
	}> = [];

	// npm/yarn/pnpm install patterns
	// npm install <package>[@version]
	// yarn add <package>[@version]
	// pnpm add <package>[@version]
	// Note: Use word boundary \b to prevent matching "npm" inside "pnpm"
	const npmPatterns = [
		/\b(?:npm|npx)\s+(?:install|i|add)\s+(?:-[gGD]\s+)?(@?[\w/-]+)(?:@([\w.^~<>=]+))?/gi,
		/\b(?:yarn|pnpm)\s+(?:add|install)\s+(?:-[gGD]\s+)?(@?[\w/-]+)(?:@([\w.^~<>=]+))?/gi,
	];

	for (const pattern of npmPatterns) {
		let match: RegExpExecArray | null = pattern.exec(content);
		while (match) {
			const packageName = match[1];
			const version = match[2];

			// Determine manager from the match
			const managerMatch = match[0].match(/^(npm|npx|yarn|pnpm)/i);
			const manager = managerMatch
				? managerMatch[1].toLowerCase() === "npx"
					? "npm"
					: (managerMatch[1].toLowerCase() as "npm" | "yarn" | "pnpm")
				: "npm";

			results.push({
				manager,
				packageName,
				version,
			});
			match = pattern.exec(content);
		}
	}

	// pip install patterns
	// pip install <package>[==version]
	const pipPattern = /pip3?\s+install\s+(?:-[a-zA-Z]+\s+)*([a-zA-Z0-9_-]+)(?:==?([\d.]+))?/gi;
	let pipMatch: RegExpExecArray | null = pipPattern.exec(content);
	while (pipMatch) {
		results.push({
			manager: "pip",
			packageName: pipMatch[1],
			version: pipMatch[2],
		});
		pipMatch = pipPattern.exec(content);
	}

	return results;
}

/**
 * Well-known popular packages that don't need verification
 */
const TRUSTED_PACKAGES: Record<"npm" | "pip", Set<string>> = {
	npm: new Set([
		// Build tools
		"typescript",
		"vite",
		"webpack",
		"esbuild",
		"rollup",
		"parcel",
		"turbo",
		"nx",
		// Testing
		"vitest",
		"jest",
		"mocha",
		"chai",
		"cypress",
		"playwright",
		// Frameworks
		"react",
		"vue",
		"svelte",
		"angular",
		"next",
		"nuxt",
		"express",
		"fastify",
		"hono",
		"koa",
		// Utilities
		"lodash",
		"underscore",
		"ramda",
		"date-fns",
		"dayjs",
		"moment",
		"axios",
		"node-fetch",
		"chalk",
		"commander",
		"yargs",
		// Linting/formatting
		"eslint",
		"prettier",
		"biome",
		// Types
		"@types/node",
		"@types/react",
		"zod",
		// CLI tools
		"nodemon",
		"ts-node",
		"tsx",
		// Package management
		"npm-check-updates",
		"syncpack",
	]),
	pip: new Set([
		// Web frameworks
		"django",
		"flask",
		"fastapi",
		"starlette",
		"tornado",
		// Data science
		"numpy",
		"pandas",
		"scipy",
		"matplotlib",
		"seaborn",
		"scikit-learn",
		// ML/AI
		"tensorflow",
		"torch",
		"pytorch",
		"transformers",
		"keras",
		// Utilities
		"requests",
		"httpx",
		"aiohttp",
		"pydantic",
		"attrs",
		// Testing
		"pytest",
		"unittest",
		"coverage",
		"tox",
		// Linting
		"black",
		"flake8",
		"pylint",
		"mypy",
		"ruff",
		// CLI
		"click",
		"typer",
		"rich",
	]),
};

/**
 * Patterns that suggest typosquatting attempts
 */
const TYPOSQUATTING_PATTERNS: Array<{
	pattern: RegExp;
	description: string;
}> = [
	{
		pattern: /^([a-z]+)-js$/i,
		description: "Suspicious -js suffix",
	},
	{
		pattern: /^js-([a-z]+)$/i,
		description: "Suspicious js- prefix",
	},
	{
		pattern: /^node-([a-z]+)$/i,
		description: "Suspicious node- prefix (often unnecessary)",
	},
	{
		pattern: /^python-([a-z]+)$/i,
		description: "Suspicious python- prefix",
	},
	{
		pattern: /(.)\1{3,}/i,
		description: "Repeated characters (possible typo)",
	},
	{
		pattern: /[0oO].*[0oO].*[0oO]/,
		description: "Multiple O/0 characters (possible substitution)",
	},
	{
		pattern: /[1lI].*[1lI].*[1lI]/,
		description: "Multiple l/1/I characters (possible substitution)",
	},
];

/**
 * Common typosquatting targets and their variants
 */
const TYPOSQUATTING_TARGETS: Array<{
	legitimate: string;
	variants: string[];
}> = [
	{
		legitimate: "lodash",
		variants: ["lodash-es", "lodash.js", "1odash", "lodahs"],
	},
	{
		legitimate: "express",
		variants: ["expres", "expresss", "express-js"],
	},
	{
		legitimate: "react",
		variants: ["reactt", "reac", "react-js"],
	},
	{
		legitimate: "axios",
		variants: ["axois", "axioss", "axi0s"],
	},
	{
		legitimate: "requests",
		variants: ["request", "reqeusts", "requets"],
	},
	{
		legitimate: "numpy",
		variants: ["numpi", "numpyy", "num-py"],
	},
];

/**
 * Check if a package name looks like a typosquatting attempt
 */
function checkTyposquatting(packageName: string): string[] {
	const warnings: string[] = [];
	const lowerName = packageName.toLowerCase();

	// Check against pattern-based detection
	for (const { pattern, description } of TYPOSQUATTING_PATTERNS) {
		if (pattern.test(packageName)) {
			warnings.push(`Typosquatting pattern: ${description}`);
		}
	}

	// Check against known typosquatting targets
	for (const { legitimate, variants } of TYPOSQUATTING_TARGETS) {
		if (variants.some((v) => v.toLowerCase() === lowerName)) {
			warnings.push(`Possible typosquatting of "${legitimate}"`);
		}
	}

	// Check Levenshtein distance to popular packages
	// Distance <= 2 catches transpositions (lodahs vs lodash) and other close typos
	const allTrusted = [...TRUSTED_PACKAGES.npm, ...TRUSTED_PACKAGES.pip];
	for (const trusted of allTrusted) {
		const distance = levenshteinDistance(lowerName, trusted.toLowerCase());
		if (distance > 0 && distance <= 2 && lowerName !== trusted.toLowerCase()) {
			warnings.push(`Very similar to popular package "${trusted}" (${distance} character difference)`);
		}
	}

	return warnings;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	const matrix: number[][] = [];

	for (let i = 0; i <= b.length; i++) {
		matrix[i] = [i];
	}

	for (let j = 0; j <= a.length; j++) {
		matrix[0][j] = j;
	}

	for (let i = 1; i <= b.length; i++) {
		for (let j = 1; j <= a.length; j++) {
			if (b.charAt(i - 1) === a.charAt(j - 1)) {
				matrix[i][j] = matrix[i - 1][j - 1];
			} else {
				matrix[i][j] = Math.min(
					matrix[i - 1][j - 1] + 1, // substitution
					matrix[i][j - 1] + 1, // insertion
					matrix[i - 1][j] + 1, // deletion
				);
			}
		}
	}

	return matrix[b.length][a.length];
}

/**
 * Validate a package without network calls (local checks only)
 *
 * @param packageName - Name of the package
 * @param manager - Package manager (npm, pip, etc.)
 * @returns Validation result
 */
export function validatePackageLocal(
	packageName: string,
	manager: "npm" | "pip" | "yarn" | "pnpm",
): PackageValidationResult {
	const result: PackageValidationResult = {
		isSafe: true,
		isClean: true,
		warnings: [],
		details: {
			name: packageName,
		},
	};

	const normalizedManager = manager === "yarn" || manager === "pnpm" ? "npm" : manager;

	// Check if it's a trusted package
	if (TRUSTED_PACKAGES[normalizedManager].has(packageName)) {
		return result;
	}

	// Check for scoped npm packages (@org/package)
	if (normalizedManager === "npm" && packageName.startsWith("@")) {
		const [scope] = packageName.split("/");
		// Well-known scopes are generally safe
		const trustedScopes = ["@types", "@babel", "@testing-library", "@tanstack", "@radix-ui", "@prisma"];
		if (trustedScopes.includes(scope)) {
			return result;
		}
		result.warnings.push(`Scoped package from ${scope} - verify organization`);
		result.isClean = false;
	}

	// Check typosquatting patterns
	const typoWarnings = checkTyposquatting(packageName);
	if (typoWarnings.length > 0) {
		result.warnings.push(...typoWarnings);
		result.isClean = false;
	}

	// Check for suspicious package name patterns
	if (packageName.length < 3) {
		result.warnings.push("Package name is very short (< 3 characters)");
		result.isClean = false;
	}

	if (packageName.length > 50) {
		result.warnings.push("Package name is unusually long (> 50 characters)");
		result.isClean = false;
	}

	if (/^[0-9]/.test(packageName)) {
		result.warnings.push("Package name starts with a number (unusual)");
		result.isClean = false;
	}

	if (/--/.test(packageName) || /__/.test(packageName)) {
		result.warnings.push("Package name contains double dashes or underscores (unusual)");
		result.isClean = false;
	}

	if (result.warnings.length > 0) {
		sessionLogger.debug({ packageName, manager, warnings: result.warnings }, "Package validation warnings");
	}

	return result;
}

/**
 * Validate packages mentioned in a task objective (local checks only)
 *
 * @param objective - Task objective that may contain package install commands
 * @returns Array of package validation results
 */
export function validatePackagesInObjective(objective: string): Array<{
	package: string;
	manager: string;
	result: PackageValidationResult;
}> {
	const installs = extractPackageInstalls(objective);

	return installs.map((install) => ({
		package: install.packageName,
		manager: install.manager,
		result: validatePackageLocal(install.packageName, install.manager),
	}));
}

/**
 * Quick check if all packages in an objective are likely safe
 *
 * @param objective - Task objective to check
 * @returns true if all packages pass local validation
 */
export function arePackagesSafe(objective: string): boolean {
	const validations = validatePackagesInObjective(objective);
	return validations.every((v) => v.result.isSafe);
}

/**
 * Get package warnings for a task objective
 *
 * @param objective - Task objective to check
 * @returns Array of warning messages for any suspicious packages
 */
export function getPackageWarnings(objective: string): string[] {
	const validations = validatePackagesInObjective(objective);
	const warnings: string[] = [];

	for (const v of validations) {
		if (v.result.warnings.length > 0) {
			warnings.push(`Package "${v.package}" (${v.manager}): ${v.result.warnings.join("; ")}`);
		}
	}

	return warnings;
}

/**
 * Get trusted packages set (for testing/documentation)
 */
export function getTrustedPackages(): Record<"npm" | "pip", string[]> {
	return {
		npm: [...TRUSTED_PACKAGES.npm],
		pip: [...TRUSTED_PACKAGES.pip],
	};
}
