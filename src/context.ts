/**
 * Context Summarization Module
 *
 * Provides smart context extraction for agents to reduce token usage.
 * Instead of passing entire plan files to every agent, this module
 * extracts only the relevant sections each agent needs.
 *
 * Context limits by agent type:
 * - Scout: Just the goal (~1K chars)
 * - Planner: Full scout report (~10K chars)
 * - Builder: Implementation details only (~5K chars)
 * - Reviewer: Review requirements (~3K chars)
 */

import type { AgentType } from "./types.js";

/**
 * Parsed section from a markdown plan
 */
interface PlanSection {
	heading: string;
	level: number;
	content: string;
}

/**
 * Context limits per agent type (in characters)
 */
const CONTEXT_LIMITS: Record<AgentType, number> = {
	scout: 1000,
	planner: 10000,
	builder: 5000,
	reviewer: 3000,
};

/**
 * Keywords that indicate relevant sections for each agent type
 */
const RELEVANCE_KEYWORDS: Record<AgentType, string[]> = {
	scout: ["goal", "objective", "target", "find", "locate"],
	planner: ["scout", "intel", "findings", "structure", "files", "dependencies"],
	builder: [
		"implement",
		"create",
		"modify",
		"add",
		"change",
		"file",
		"code",
		"function",
		"class",
		"module",
		"step",
		"step",
	],
	reviewer: ["test", "verify", "check", "review", "requirement", "edge case", "security", "validation"],
};

/**
 * Parse markdown content into sections based on headings
 */
export function parseMarkdownSections(content: string): PlanSection[] {
	const sections: PlanSection[] = [];
	const lines = content.split("\n");

	let currentSection: PlanSection | null = null;
	let currentContent: string[] = [];

	for (const line of lines) {
		// Check for heading (# to ######)
		const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

		if (headingMatch) {
			// Save previous section if exists
			if (currentSection) {
				currentSection.content = currentContent.join("\n").trim();
				sections.push(currentSection);
			}

			// Start new section
			currentSection = {
				heading: headingMatch[2],
				level: headingMatch[1].length,
				content: "",
			};
			currentContent = [];
		} else {
			currentContent.push(line);
		}
	}

	// Don't forget the last section
	if (currentSection) {
		currentSection.content = currentContent.join("\n").trim();
		sections.push(currentSection);
	}

	// If no sections found, treat entire content as one section
	if (sections.length === 0 && content.trim()) {
		sections.push({
			heading: "Content",
			level: 1,
			content: content.trim(),
		});
	}

	return sections;
}

/**
 * Calculate relevance score for a section based on agent type
 */
function calculateRelevanceScore(section: PlanSection, agentType: AgentType): number {
	const keywords = RELEVANCE_KEYWORDS[agentType];
	const textToSearch = `${section.heading} ${section.content}`.toLowerCase();

	let score = 0;

	// Higher level headings are more important
	score += Math.max(0, 4 - section.level);

	// Count keyword matches
	for (const keyword of keywords) {
		if (textToSearch.includes(keyword.toLowerCase())) {
			score += 2;
		}
	}

	// Bonus for implementation-specific sections for builder
	if (agentType === "builder") {
		if (/files?\s+to\s+(modify|create|change)/i.test(textToSearch) || /implementation/i.test(section.heading)) {
			score += 5;
		}
	}

	// Bonus for test-related sections for reviewer
	if (agentType === "reviewer") {
		if (/test/i.test(section.heading) || /verification|validation/i.test(section.heading)) {
			score += 5;
		}
	}

	return score;
}

/**
 * Extract relevant sections for an agent type
 */
export function extractRelevantSections(sections: PlanSection[], agentType: AgentType): PlanSection[] {
	// Score each section
	const scoredSections = sections.map((section) => ({
		section,
		score: calculateRelevanceScore(section, agentType),
	}));

	// Sort by score descending
	scoredSections.sort((a, b) => b.score - a.score);

	// Take sections until we hit the limit
	const limit = CONTEXT_LIMITS[agentType];
	const relevantSections: PlanSection[] = [];
	let totalLength = 0;

	for (const { section, score } of scoredSections) {
		// Skip sections with zero relevance (unless we have nothing)
		if (score === 0 && relevantSections.length > 0) {
			continue;
		}

		const sectionLength = section.heading.length + section.content.length + 10; // +10 for formatting

		if (totalLength + sectionLength <= limit) {
			relevantSections.push(section);
			totalLength += sectionLength;
		} else if (relevantSections.length === 0) {
			// Always include at least one section (truncated if needed)
			relevantSections.push(section);
			break;
		}
	}

	return relevantSections;
}

/**
 * Format sections back into readable text
 */
export function formatSections(sections: PlanSection[]): string {
	return sections
		.map((section) => {
			const prefix = "#".repeat(section.level);
			return `${prefix} ${section.heading}\n\n${section.content}`;
		})
		.join("\n\n");
}

/**
 * Smart truncation that preserves meaningful content
 * Falls back to this when parsing fails
 */
export function smartTruncate(content: string, maxLength: number): string {
	if (content.length <= maxLength) {
		return content;
	}

	// Try to truncate at a paragraph boundary
	const truncated = content.substring(0, maxLength);
	const lastParagraph = truncated.lastIndexOf("\n\n");

	if (lastParagraph > maxLength * 0.7) {
		return `${truncated.substring(0, lastParagraph)}\n\n[...truncated]`;
	}

	// Try to truncate at a sentence boundary
	const lastSentence = truncated.lastIndexOf(". ");
	if (lastSentence > maxLength * 0.8) {
		return `${truncated.substring(0, lastSentence + 1)}\n\n[...truncated]`;
	}

	// Fall back to word boundary
	const lastSpace = truncated.lastIndexOf(" ");
	if (lastSpace > maxLength * 0.9) {
		return `${truncated.substring(0, lastSpace)}...\n\n[...truncated]`;
	}

	return `${truncated}...\n\n[...truncated]`;
}

/**
 * Main function: Summarize context for a specific agent type
 *
 * This is the primary API for the session orchestrator to use.
 * It extracts only the relevant parts of a plan for each agent type,
 * significantly reducing token usage.
 */
export function summarizeContextForAgent(fullContext: string, agentType: AgentType, goal?: string): string {
	const limit = CONTEXT_LIMITS[agentType];

	// For scout, just return the goal
	if (agentType === "scout") {
		if (goal) {
			return smartTruncate(goal, limit);
		}
		return smartTruncate(fullContext, limit);
	}

	// Try to parse as markdown
	try {
		const sections = parseMarkdownSections(fullContext);

		if (sections.length === 0) {
			// Parsing failed, use smart truncation
			return smartTruncate(fullContext, limit);
		}

		const relevantSections = extractRelevantSections(sections, agentType);
		const formatted = formatSections(relevantSections);

		// Check if formatted content is within limit
		if (formatted.length <= limit) {
			return formatted;
		}

		// Content still too long, apply smart truncation
		return smartTruncate(formatted, limit);
	} catch {
		// Parsing error, fall back to smart truncation
		return smartTruncate(fullContext, limit);
	}
}

/**
 * Extract implementation-focused context for builder
 *
 * This specifically extracts:
 * - Files to modify/create
 * - Specific changes needed
 * - Code patterns to follow
 */
export function extractImplementationContext(planContent: string): string {
	const sections = parseMarkdownSections(planContent);

	// Priority headings for implementation
	const priorityPatterns = [
		/implementation/i,
		/files?\s+to/i,
		/changes?/i,
		/steps?/i,
		/steps?/i,
		/code/i,
		/modify/i,
		/create/i,
	];

	const implementationSections = sections.filter((section) =>
		priorityPatterns.some((pattern) => pattern.test(section.heading) || pattern.test(section.content)),
	);

	if (implementationSections.length > 0) {
		return formatSections(implementationSections);
	}

	// Fall back to full context with smart summarization
	return summarizeContextForAgent(planContent, "builder");
}

/**
 * Extract review-focused context for reviewer
 *
 * This specifically extracts:
 * - Test requirements
 * - Edge cases to verify
 * - Security considerations
 * - Expected behavior
 */
export function extractReviewContext(planContent: string, builderOutput: string): string {
	const planSections = parseMarkdownSections(planContent);

	// Priority headings for review
	const reviewPatterns = [
		/test/i,
		/verif/i,
		/valid/i,
		/edge\s+case/i,
		/security/i,
		/requirement/i,
		/expect/i,
		/check/i,
	];

	const reviewSections = planSections.filter((section) =>
		reviewPatterns.some((pattern) => pattern.test(section.heading) || pattern.test(section.content)),
	);

	let result = "";

	if (reviewSections.length > 0) {
		result += "## Review Requirements\n\n";
		result += formatSections(reviewSections);
		result += "\n\n";
	}

	// Add truncated builder output
	result += "## Implementation Output\n\n";
	result += smartTruncate(builderOutput, 1500);

	return smartTruncate(result, CONTEXT_LIMITS.reviewer);
}

/**
 * Get the context limit for an agent type
 */
export function getContextLimit(agentType: AgentType): number {
	return CONTEXT_LIMITS[agentType];
}

// ============================================================================
// PRE-FLIGHT CONTEXT PREPARATION ("Innie" Factory)
// ============================================================================
//
// This section provides context preparation for solo mode.
// Uses FREE local tools (no LLM tokens) to gather exactly what the agent needs.
//
// Philosophy:
// - Agent should know WHERE to look before starting
// - Agent should know WHAT signatures/types it's working with
// - Agent should NOT waste tokens on exploration
// - Every token spent exploring is wasted
//
// Tools used:
// - git grep: Find code patterns
// - ast-grep: Structural code search (AST-based)
// - TypeScript compiler: Extract type signatures
// - File analysis: Identify relevant files
// ============================================================================

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type FunctionDeclaration, type MethodDeclaration, Project, type SourceFile, SyntaxKind } from "ts-morph";
import { sessionLogger } from "./logger.js";

// Cached ts-morph project for reuse
let cachedProject: Project | null = null;
let cachedProjectPath: string | null = null;

/**
 * A focused context briefing for an agent
 */
export interface ContextBriefing {
	/** One-line summary of what the agent should do */
	objective: string;
	/** Primary files the agent should focus on */
	targetFiles: string[];
	/** Relevant type/interface definitions */
	typeDefinitions: string[];
	/** Relevant function signatures */
	functionSignatures: string[];
	/** Related code patterns found */
	relatedPatterns: string[];
	/** Any constraints or warnings */
	constraints: string[];
	/** Pre-formatted briefing document */
	briefingDoc: string;
}

/**
 * Keywords that suggest specific areas of the codebase
 */
const AREA_KEYWORDS: Record<string, string[]> = {
	"next-client": ["component", "page", "client", "frontend", "ui", "react", "hook", "css", "style", "modal", "button"],
	"express-server": [
		"route",
		"endpoint",
		"api",
		"server",
		"middleware",
		"controller",
		"handler",
		"request",
		"response",
	],
	common: ["schema", "type", "interface", "util", "shared", "validation", "zod"],
	pyserver: ["python", "llm", "ai", "processing", "pipeline", "fastapi"],
};

/**
 * Prepare context briefing for a task
 *
 * Uses local tools to gather relevant context before agent runs.
 * This is FREE - no LLM tokens consumed.
 */
export async function prepareContext(
	task: string,
	options: {
		/** Current working directory */
		cwd?: string;
		/** Optional repository root directory */
		repoRoot?: string;
	} = {},
): Promise<ContextBriefing> {
	const cwd = options.cwd || process.cwd();
	const repoRoot = options.repoRoot || cwd;

	const briefing: ContextBriefing = {
		objective: task,
		targetFiles: [],
		typeDefinitions: [],
		functionSignatures: [],
		relatedPatterns: [],
		constraints: [],
		briefingDoc: "",
	};

	try {
		// 1. Identify likely target areas from task description
		const targetAreas = identifyTargetAreas(task);
		briefing.constraints.push(`Focus areas: ${targetAreas.join(", ") || "general"}`);

		// 2. Extract key terms from task for searching
		const searchTerms = extractSearchTerms(task);

		// 3. Find related files - prioritize explicitly mentioned files first
		const explicitFiles: string[] = [];
		const searchedFiles: string[] = [];

		for (const term of searchTerms.slice(0, 5)) {
			// Check if it looks like a file name - these get priority
			if (term.match(/\.(ts|tsx|js|jsx)$/)) {
				const files = findFilesByName(term, repoRoot);
				explicitFiles.push(...files);
			} else {
				const files = findFilesWithTerm(term, repoRoot);
				searchedFiles.push(...files);
			}
		}

		// Explicit files first, then searched files
		briefing.targetFiles.push(...explicitFiles, ...searchedFiles);

		// 4. Try ast-grep for structural patterns
		const astPatterns = await findWithAstGrep(task, repoRoot);
		briefing.relatedPatterns.push(...astPatterns);

		// Deduplicate and limit files
		briefing.targetFiles = [...new Set(briefing.targetFiles)].slice(0, 10);

		// 5. Extract type definitions from common/schema if task mentions types
		if (task.match(/type|interface|schema|zod/i)) {
			const types = extractTypeDefinitions(repoRoot);
			briefing.typeDefinitions.push(...types.slice(0, 10));
		}

		// 6. Find function signatures in target files (prefer ts-morph for accuracy)
		for (const file of briefing.targetFiles.slice(0, 5)) {
			// Use full path for ts-morph
			const fullPath = path.isAbsolute(file) ? file : path.join(repoRoot, file);

			// Try ts-morph first for full type info
			let signatures = extractFunctionSignaturesWithTypes(fullPath, repoRoot);
			if (signatures.length === 0) {
				// Fall back to regex-based extraction
				signatures = extractFunctionSignatures(fullPath, repoRoot);
			}
			briefing.functionSignatures.push(...signatures);
		}
		briefing.functionSignatures = briefing.functionSignatures.slice(0, 15);

		// 7. Find related patterns (how similar things are done)
		const patterns = findRelatedPatterns(task, repoRoot);
		briefing.relatedPatterns.push(...patterns.slice(0, 5));

		// 8. Add repository-specific constraints
		const constraints = [
			...detectConstraints(task, repoRoot),
			`Working in repository: ${repoRoot}`,
			`Current directory: ${cwd}`,
		];
		briefing.constraints.push(...constraints);

		// 9. Build the briefing document
		briefing.briefingDoc = buildBriefingDoc(briefing);
	} catch (error) {
		sessionLogger.warn(
			{ error: String(error), cwd, repoRoot },
			"Context preparation had issues, using minimal briefing",
		);
		briefing.briefingDoc = buildMinimalBriefing(task);
	}

	return briefing;
}

/**
 * Identify which areas of the codebase are likely relevant
 */
function identifyTargetAreas(task: string): string[] {
	const taskLower = task.toLowerCase();
	const areas: string[] = [];

	for (const [area, keywords] of Object.entries(AREA_KEYWORDS)) {
		for (const keyword of keywords) {
			if (taskLower.includes(keyword)) {
				areas.push(area);
				break;
			}
		}
	}

	return [...new Set(areas)];
}

/**
 * Extract search terms from task description
 */
function extractSearchTerms(task: string): string[] {
	const stopWords = new Set([
		"the",
		"a",
		"an",
		"to",
		"in",
		"for",
		"of",
		"and",
		"or",
		"add",
		"fix",
		"update",
		"change",
		"make",
		"create",
		"implement",
		"should",
		"must",
		"can",
		"will",
		"this",
		"that",
		"with",
		"from",
		"when",
		"where",
		"how",
	]);

	const words = task
		.split(/[\s\-_.,;:!?()[\]{}'"]+/)
		.filter((w) => w.length > 2)
		.filter((w) => !stopWords.has(w.toLowerCase()))
		.filter((w) => !w.match(/^\d+$/));

	// Also extract camelCase/PascalCase identifiers
	const identifiers = task.match(/[A-Z][a-z]+(?:[A-Z][a-z]+)*|[a-z]+(?:[A-Z][a-z]+)+/g) || [];

	// Extract file paths or file names mentioned (e.g., "solo.ts", "src/solo.ts")
	const filePatterns = task.match(/[\w/-]+\.(ts|tsx|js|jsx)/g) || [];

	return [...new Set([...words, ...identifiers, ...filePatterns])];
}

/**
 * Find files by name pattern (includes untracked files)
 */
function findFilesByName(pattern: string, cwd: string): string[] {
	try {
		// Remove extension for broader matching
		const baseName = pattern.replace(/\.(ts|tsx|js|jsx)$/, "");

		// Use find instead of git ls-files to include untracked files
		const result = execSync(
			`find . -name "*.ts" -o -name "*.tsx" 2>/dev/null | grep -v node_modules | grep -i "${baseName}" | head -10 || true`,
			{ encoding: "utf-8", cwd, timeout: 3000 },
		);

		return result
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((f) => f.replace(/^\.\//, "")) // Remove leading ./
			.filter((f) => !f.includes(".test.") && !f.startsWith("dist/"))
			.slice(0, 5);
	} catch {
		return [];
	}
}

/**
 * Find files containing a search term
 */
function findFilesWithTerm(term: string, cwd: string): string[] {
	try {
		const result = execSync(`git grep -l "${term.replace(/"/g, '\\"')}" -- "*.ts" "*.tsx" 2>/dev/null || true`, {
			encoding: "utf-8",
			cwd,
			timeout: 5000,
		});

		return result
			.trim()
			.split("\n")
			.filter(Boolean)
			.filter((f) => !f.includes("node_modules") && !f.includes(".test.") && !f.includes("__tests__"));
	} catch {
		return [];
	}
}

/**
 * Find structural patterns using ast-grep (if available)
 */
async function findWithAstGrep(task: string, cwd: string): Promise<string[]> {
	const patterns: string[] = [];
	const taskLower = task.toLowerCase();

	try {
		// Check if ast-grep is available
		execSync("which ast-grep", { encoding: "utf-8", timeout: 1000 });
	} catch {
		// ast-grep not installed, skip
		return patterns;
	}

	try {
		// If task mentions functions, find function declarations
		if (taskLower.match(/function|handler|method/)) {
			const result = execSync(
				`ast-grep --lang typescript -p 'function $NAME($$$PARAMS)' --json 2>/dev/null | head -c 2000 || true`,
				{ encoding: "utf-8", cwd, timeout: 5000 },
			);
			if (result.trim()) {
				const matches = JSON.parse(result);
				const names = matches.slice(0, 5).map((m: { text: string }) => m.text?.slice(0, 50) || "");
				patterns.push(`Functions: ${names.filter(Boolean).join(", ")}`);
			}
		}

		// If task mentions routes, find route definitions
		if (taskLower.match(/route|endpoint|api/)) {
			const result = execSync(
				`ast-grep --lang typescript -p 'router.$METHOD($$$)' --json 2>/dev/null | head -c 2000 || true`,
				{ encoding: "utf-8", cwd, timeout: 5000 },
			);
			if (result.trim()) {
				patterns.push("Found router definitions - check express-server/src/routes/");
			}
		}

		// If task mentions hooks, find hook usage
		if (taskLower.match(/hook|useState|useEffect/)) {
			const result = execSync(`ast-grep --lang tsx -p 'use$HOOK($$$)' --json 2>/dev/null | head -c 2000 || true`, {
				encoding: "utf-8",
				cwd,
				timeout: 5000,
			});
			if (result.trim()) {
				patterns.push("Found React hooks - check next-client/src/");
			}
		}
	} catch {
		// ast-grep errors are non-fatal
	}

	return patterns;
}

/**
 * Extract type definitions from common/schema
 */
function extractTypeDefinitions(cwd: string): string[] {
	const schemaPath = path.join(cwd, "common/schema/index.ts");
	if (!fs.existsSync(schemaPath)) {
		return [];
	}

	try {
		const content = fs.readFileSync(schemaPath, "utf-8");

		// Extract exported types and interfaces
		const typeMatches = content.match(/export\s+(?:type|interface)\s+\w+/g) || [];
		const types = typeMatches.map((m) => m.replace(/export\s+(?:type|interface)\s+/, ""));

		// Extract const exports (often Zod schemas)
		const constMatches = content.match(/export\s+const\s+\w+Schema/g) || [];
		const schemas = constMatches.map((m) => m.replace(/export\s+const\s+/, ""));

		return [...types, ...schemas];
	} catch {
		return [];
	}
}

/**
 * Extract function signatures from a file
 */
function extractFunctionSignatures(file: string, cwd: string): string[] {
	const fullPath = path.join(cwd, file);
	if (!fs.existsSync(fullPath)) {
		return [];
	}

	try {
		const content = fs.readFileSync(fullPath, "utf-8");
		const functionMatches: string[] = [];

		// export function name(params): return
		const exportFunctions = content.match(/export\s+(?:async\s+)?function\s+\w+\([^)]*\)(?:\s*:\s*[^{]+)?/g) || [];
		functionMatches.push(...exportFunctions);

		// export const name = (params) => or async (params) =>
		const arrowFunctions = content.match(/export\s+const\s+\w+\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*[^=]+)?=>/g) || [];
		functionMatches.push(...arrowFunctions);

		return functionMatches.map((sig) => `${path.basename(file)}: ${sig.trim()}`);
	} catch {
		return [];
	}
}

/**
 * Find related patterns - how similar things are done
 */
function findRelatedPatterns(task: string, cwd: string): string[] {
	const patterns: string[] = [];
	const taskLower = task.toLowerCase();

	// If adding a route, find existing route patterns
	if (taskLower.includes("route") || taskLower.includes("endpoint") || taskLower.includes("api")) {
		try {
			const routeFiles = execSync('git grep -l "router\\." -- "*.ts" 2>/dev/null | head -3 || true', {
				encoding: "utf-8",
				cwd,
				timeout: 3000,
			});
			if (routeFiles.trim()) {
				patterns.push(`Route patterns in: ${routeFiles.trim().replace(/\n/g, ", ")}`);
			}
		} catch {
			/* ignore */
		}
	}

	// If adding a component, find existing component patterns
	if (taskLower.includes("component") || taskLower.includes("modal") || taskLower.includes("button")) {
		try {
			const componentDirs = execSync(
				"find next-client/src/components -type d -maxdepth 2 2>/dev/null | head -5 || true",
				{
					encoding: "utf-8",
					cwd,
					timeout: 3000,
				},
			);
			if (componentDirs.trim()) {
				patterns.push(`Component patterns in: ${componentDirs.trim().replace(/\n/g, ", ")}`);
			}
		} catch {
			/* ignore */
		}
	}

	// If adding tests, find existing test patterns
	if (taskLower.includes("test")) {
		try {
			const testFiles = execSync('git ls-files "*.test.ts" | head -3 || true', {
				encoding: "utf-8",
				cwd,
				timeout: 3000,
			});
			if (testFiles.trim()) {
				patterns.push(`Test patterns in: ${testFiles.trim().replace(/\n/g, ", ")}`);
			}
		} catch {
			/* ignore */
		}
	}

	return patterns;
}

/**
 * Detect constraints and requirements
 */
function detectConstraints(_task: string, cwd: string): string[] {
	const constraints: string[] = [];

	// Check for TypeScript strict mode
	const tsconfigPath = path.join(cwd, "tsconfig.json");
	if (fs.existsSync(tsconfigPath)) {
		try {
			const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));
			if (tsconfig.compilerOptions?.strict) {
				constraints.push("TypeScript strict mode enabled");
			}
		} catch {
			/* ignore */
		}
	}

	// Check for Biome config
	if (fs.existsSync(path.join(cwd, "biome.json"))) {
		constraints.push("Biome linting enabled");
	}

	// Check if this is a monorepo
	if (fs.existsSync(path.join(cwd, "pnpm-workspace.yaml"))) {
		constraints.push("Monorepo: common/ must be built first");
	}

	return constraints;
}

/**
 * Build the full briefing document
 */
function buildBriefingDoc(briefing: ContextBriefing): string {
	const sections: string[] = [];

	sections.push(`# CONTEXT BRIEFING`);
	sections.push(`\n## Objective\n${briefing.objective}`);

	if (briefing.constraints.length > 0) {
		sections.push(`\n## Constraints\n${briefing.constraints.map((c) => `- ${c}`).join("\n")}`);
	}

	if (briefing.targetFiles.length > 0) {
		sections.push(`\n## Target Files (start here)\n${briefing.targetFiles.map((f) => `- ${f}`).join("\n")}`);
	}

	if (briefing.functionSignatures.length > 0) {
		sections.push(`\n## Relevant Functions\n\`\`\`\n${briefing.functionSignatures.join("\n")}\n\`\`\``);
	}

	if (briefing.typeDefinitions.length > 0) {
		sections.push(
			`\n## Available Types (from common/schema)\n${briefing.typeDefinitions.map((t) => `- ${t}`).join("\n")}`,
		);
	}

	if (briefing.relatedPatterns.length > 0) {
		sections.push(`\n## Related Patterns\n${briefing.relatedPatterns.map((p) => `- ${p}`).join("\n")}`);
	}

	sections.push(
		`\n## Instructions\n1. Start by reading the target files listed above\n2. Follow existing patterns in the codebase\n3. Run typecheck before finishing\n4. Make minimal changes to complete the objective`,
	);

	return sections.join("\n");
}

/**
 * Build a minimal briefing when full analysis fails
 */
function buildMinimalBriefing(task: string): string {
	return `# CONTEXT BRIEFING

## Objective
${task}

## Instructions
1. Explore the codebase to find relevant files
2. Follow existing patterns
3. Run typecheck before finishing
4. Make minimal changes to complete the objective`;
}

/**
 * Quick complexity hint from context
 */
export function estimateComplexityFromContext(briefing: ContextBriefing): "simple" | "medium" | "complex" {
	const fileCount = briefing.targetFiles.length;
	const signatureCount = briefing.functionSignatures.length;

	if (fileCount === 0 || fileCount === 1) {
		return "simple";
	}

	if (fileCount <= 3 && signatureCount <= 5) {
		return "medium";
	}

	return "complex";
}

// ============================================================================
// TS-MORPH INTEGRATION - Deep TypeScript Analysis
// ============================================================================

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
