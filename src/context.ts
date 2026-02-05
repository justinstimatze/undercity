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

import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getASTIndex } from "./ast-index.js";
import { sessionLogger } from "./logger.js";
import { extractFunctionSignaturesWithTypes, getTypeDefinition } from "./ts-analysis.js";

/**
 * Context mode - controls verbosity/size of context
 */
export type ContextMode = "full" | "compact" | "minimal";

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
	/** Files that depend on target files (impact analysis) */
	impactedFiles: string[];
	/** Files that target files depend on */
	dependencies: string[];
	/** File summaries for quick context */
	fileSummaries: Record<string, string>;
	/** Pre-formatted briefing document */
	briefingDoc: string;
	/** Symbol stubs from AST index (compact representation) */
	symbolStubs: string[];
	/** Token budget used for context */
	tokenBudgetUsed: number;
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
 * Token budget limits for context modes (approximate characters, ~4 chars = 1 token)
 */
const CONTEXT_TOKEN_BUDGETS: Record<ContextMode, number> = {
	full: 16000, // ~4000 tokens - used for Opus tasks (1M context window)
	compact: 4000, // ~1000 tokens - preferred for most tasks
	minimal: 1500, // ~375 tokens - for simple tasks
};

/**
 * Prepare context briefing for a task
 *
 * Uses local tools to gather relevant context before agent runs.
 * This is FREE - no LLM tokens consumed.
 *
 * Strategy:
 * 1. Use AST index as PRIMARY source for symbol/file discovery (fast, accurate)
 * 2. Fall back to git grep/find only when AST index is unavailable
 * 3. Prefer compact symbol stubs over full signatures to save tokens
 * 4. Apply token budget to limit context size
 */
export async function prepareContext(
	task: string,
	options: {
		/** Current working directory */
		cwd?: string;
		/** Optional repository root directory */
		repoRoot?: string;
		/** Context mode - controls verbosity (default: compact) */
		mode?: ContextMode;
		/** Token budget override (characters, ~4 chars = 1 token) */
		tokenBudget?: number;
	} = {},
): Promise<ContextBriefing> {
	const cwd = options.cwd || process.cwd();
	const repoRoot = options.repoRoot || cwd;
	const mode = options.mode || "compact";
	const tokenBudget = options.tokenBudget || CONTEXT_TOKEN_BUDGETS[mode];

	const briefing: ContextBriefing = {
		objective: task,
		targetFiles: [],
		typeDefinitions: [],
		functionSignatures: [],
		relatedPatterns: [],
		constraints: [],
		impactedFiles: [],
		dependencies: [],
		fileSummaries: {},
		briefingDoc: "",
		symbolStubs: [],
		tokenBudgetUsed: 0,
	};

	// Check if this is a "new file" task - don't search for existing files
	// as they'll just confuse the agent
	const isNewFileTask = task.toLowerCase().includes("(new file)") || task.toLowerCase().includes("new file:");
	if (isNewFileTask) {
		// Extract the target file path from the task
		const fileMatch = task.match(/In\s+(src\/[\w\-./]+\.ts)/i);
		if (fileMatch) {
			briefing.constraints.push(`CREATE NEW FILE: ${fileMatch[1]}`);
			briefing.constraints.push("This file does not exist yet - you must create it");
		}
		briefing.briefingDoc = buildMinimalBriefing(task);
		return briefing;
	}

	try {
		// 1. Identify likely target areas from task description
		const targetAreas = identifyTargetAreas(task);
		briefing.constraints.push(`Focus areas: ${targetAreas.join(", ") || "general"}`);

		// 2. Extract key terms from task for searching
		const searchTerms = extractSearchTerms(task);

		// 3. TRY AST INDEX FIRST (preferred - fast, accurate, structured)
		const astResult = await tryASTIndexFirst(briefing, searchTerms, repoRoot, mode);

		// 4. If AST index didn't find enough, fall back to git grep/find
		if (!astResult.sufficient) {
			sessionLogger.debug("AST index insufficient, falling back to file search");

			// Find related files IN PARALLEL - each search term spawns its own process
			const fileSearchPromises = searchTerms.slice(0, 5).map(async (term) => {
				if (term.match(/\.(ts|tsx|js|jsx)$/)) {
					return { type: "explicit" as const, files: findFilesByName(term, repoRoot) };
				}
				return { type: "searched" as const, files: findFilesWithTerm(term, repoRoot) };
			});

			// Run file searches and ast-grep patterns in parallel
			const [fileSearchResults, astPatterns] = await Promise.all([
				Promise.all(fileSearchPromises),
				findWithAstGrep(task, repoRoot),
			]);

			// Collect file search results - explicit files first
			const explicitFiles: string[] = [];
			const searchedFiles: string[] = [];
			for (const result of fileSearchResults) {
				if (result.type === "explicit") {
					explicitFiles.push(...result.files);
				} else {
					searchedFiles.push(...result.files);
				}
			}
			briefing.targetFiles.push(...explicitFiles, ...searchedFiles);
			briefing.relatedPatterns.push(...astPatterns);
		}

		// Deduplicate and limit files
		briefing.targetFiles = [...new Set(briefing.targetFiles)].slice(0, 10);

		// 5. In compact mode, skip expensive function signature extraction if we have symbol stubs
		if (mode !== "compact" || briefing.symbolStubs.length === 0) {
			// Extract type definitions from common/schema if task mentions types
			if (task.match(/type|interface|schema|zod/i)) {
				const types = extractTypeDefinitions(repoRoot);
				briefing.typeDefinitions.push(...types.slice(0, 10));
			}

			// Find function signatures in target files IN PARALLEL (only in full mode or if no stubs)
			if (mode === "full" || briefing.symbolStubs.length === 0) {
				const signaturePromises = briefing.targetFiles.slice(0, 5).map(async (file) => {
					const fullPath = path.isAbsolute(file) ? file : path.join(repoRoot, file);
					// Try ts-morph first for full type info
					let signatures = extractFunctionSignaturesWithTypes(fullPath, repoRoot);
					if (signatures.length === 0) {
						// Fall back to regex-based extraction
						signatures = extractFunctionSignatures(fullPath, repoRoot);
					}
					return signatures;
				});

				const signatureResults = await Promise.all(signaturePromises);
				for (const sigs of signatureResults) {
					briefing.functionSignatures.push(...sigs);
				}
				briefing.functionSignatures = briefing.functionSignatures.slice(0, 15);
			}
		}

		// 6. Add related patterns (only in full mode to save tokens)
		if (mode === "full") {
			const relatedPatternsResult = findRelatedPatterns(task, repoRoot);
			briefing.relatedPatterns.push(...relatedPatternsResult.slice(0, 5));
		}

		// 7. Add repository-specific constraints
		const constraints = [
			...detectConstraints(task, repoRoot),
			`Working in repository: ${repoRoot}`,
			`Current directory: ${cwd}`,
		];
		briefing.constraints.push(...constraints);

		// 8. Add file scope restriction to prevent scope creep
		if (briefing.targetFiles.length > 0) {
			briefing.constraints.push(`SCOPE: Only modify files related to this task. Avoid touching unrelated code.`);
		}

		// 9. Build the briefing document with token budget
		briefing.briefingDoc = buildBriefingDoc(briefing, mode, tokenBudget);
		briefing.tokenBudgetUsed = briefing.briefingDoc.length;

		sessionLogger.debug(
			{
				mode,
				tokenBudget,
				tokenBudgetUsed: briefing.tokenBudgetUsed,
				targetFiles: briefing.targetFiles.length,
				symbolStubs: briefing.symbolStubs.length,
			},
			"Context preparation complete",
		);
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

	// Extract camelCase/PascalCase identifiers - these are likely symbol names
	// Match full identifier patterns: MyClass, myFunction, getAST, etc.
	const identifiers = task.split(/[\s\-_.,;:!?()[\]{}'"]+/).filter((word) => {
		// Must contain both upper and lower case (indicates camelCase/PascalCase)
		if (!/[a-z]/.test(word) || !/[A-Z]/.test(word)) return false;
		// Full pattern: starts with letter, contains letters/numbers only
		return /^[A-Za-z][A-Za-z0-9]*$/.test(word);
	});

	// Extract file paths or file names mentioned (e.g., "solo.ts", "src/solo.ts")
	// Limit path depth and use word boundaries to prevent backtracking
	const filePatterns = task.match(/\b[\w]+(?:\/[\w]+){0,5}\.(?:ts|tsx|js|jsx)\b/g) || [];

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
		const result = execFileSync("git", ["grep", "-l", term, "--", "*.ts", "*.tsx"], {
			encoding: "utf-8",
			cwd,
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
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
				try {
					const matches = JSON.parse(result);
					const names = matches.slice(0, 5).map((m: { text: string }) => m.text?.slice(0, 50) || "");
					patterns.push(`Functions: ${names.filter(Boolean).join(", ")}`);
				} catch (parseError: unknown) {
					// ast-grep may return malformed JSON if output is truncated or corrupted
					const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
					sessionLogger.debug(
						{ error: errorMsg, outputSample: result.slice(0, 100) },
						"Failed to parse ast-grep JSON output for function detection",
					);
				}
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
			// Malformed or unparseable tsconfig.json - non-fatal, skip constraint
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
 * Result of trying AST index first
 */
interface ASTIndexResult {
	/** Whether AST index provided sufficient context */
	sufficient: boolean;
	/** Number of files found via AST index */
	filesFound: number;
	/** Number of symbols found */
	symbolsFound: number;
}

/**
 * Try AST index FIRST as the primary source for context
 *
 * This is more aggressive than the previous enrichWithASTIndex approach:
 * 1. Uses AST index as PRIMARY source (not just enrichment)
 * 2. Extracts compact symbol stubs instead of full signatures
 * 3. Only falls back to git grep if AST index is unavailable/insufficient
 *
 * Returns whether the AST index provided sufficient context
 */
async function tryASTIndexFirst(
	briefing: ContextBriefing,
	searchTerms: string[],
	repoRoot: string,
	mode: ContextMode,
): Promise<ASTIndexResult> {
	try {
		const index = getASTIndex(repoRoot);
		await index.load();

		const stats = index.getStats();
		if (stats.fileCount === 0) {
			// Index not built yet - can't use it
			sessionLogger.debug("AST index empty, cannot use as primary source");
			return { sufficient: false, filesFound: 0, symbolsFound: 0 };
		}

		let filesFound = 0;
		let symbolsFound = 0;

		// 1. Find files defining symbols mentioned in the task (PRIMARY discovery method)
		const symbolFiles: string[] = [];
		const foundSymbols: Array<{ name: string; kind: string; file: string }> = [];

		for (const term of searchTerms) {
			// Skip short terms and file-like patterns
			if (term.length < 3 || term.includes(".")) continue;

			// Check if term looks like a symbol (PascalCase or camelCase)
			if (/^[A-Z][a-zA-Z0-9]*$/.test(term) || /^[a-z][a-zA-Z0-9]*$/.test(term)) {
				const files = index.findSymbolDefinition(term);
				for (const file of files) {
					symbolFiles.push(file);
					const info = index.getSymbolInfo(term);
					if (info) {
						foundSymbols.push({ name: term, kind: info.kind, file });
					}
				}
			}
		}

		// Add symbol-based files to target files (prioritize them)
		if (symbolFiles.length > 0) {
			const uniqueSymbolFiles = [...new Set(symbolFiles)];
			briefing.targetFiles = [...uniqueSymbolFiles, ...briefing.targetFiles];
			briefing.targetFiles = [...new Set(briefing.targetFiles)].slice(0, 10);
			filesFound = uniqueSymbolFiles.length;
		}

		// 2. Build compact symbol stubs (saves tokens vs full signatures)
		// Format: "symbolName (kind) in file.ts"
		for (const sym of foundSymbols.slice(0, 15)) {
			const stub = `${sym.name} (${sym.kind}) in ${path.basename(sym.file)}`;
			if (!briefing.symbolStubs.includes(stub)) {
				briefing.symbolStubs.push(stub);
				symbolsFound++;
			}
		}

		// 3. Get file exports as compact stubs (for target files)
		for (const file of briefing.targetFiles.slice(0, 5)) {
			const exports = index.getFileExports(file);
			for (const exp of exports.slice(0, 5)) {
				const stub = `${exp.name} (${exp.kind}) in ${path.basename(file)}`;
				if (!briefing.symbolStubs.includes(stub)) {
					briefing.symbolStubs.push(stub);
				}
			}
		}

		// Limit symbol stubs based on mode
		const maxStubs = mode === "minimal" ? 5 : mode === "compact" ? 10 : 20;
		briefing.symbolStubs = briefing.symbolStubs.slice(0, maxStubs);

		// 4. Find dependencies for target files - AGGRESSIVE import graph usage
		const allDependencies: string[] = [];
		const typeProviders: string[] = []; // Files that provide types to target files
		for (const file of briefing.targetFiles.slice(0, 5)) {
			const fileInfo = index.getFileInfo(file);
			if (fileInfo) {
				for (const imp of fileInfo.imports) {
					if (imp.resolvedPath) {
						allDependencies.push(imp.resolvedPath);
						// Track type-only imports - these are CRITICAL for context
						if (imp.isTypeOnly || imp.namedImports.some((n) => /^[A-Z]/.test(n))) {
							typeProviders.push(imp.resolvedPath);
						}
					}
				}
			}
		}

		// Include type provider files in target files (not just dependencies)
		// because understanding types is critical for code modification
		if (typeProviders.length > 0) {
			const uniqueTypeProviders = [...new Set(typeProviders)].filter((f) => !briefing.targetFiles.includes(f));
			// Add up to 3 type providers directly to target files
			briefing.targetFiles = [...briefing.targetFiles, ...uniqueTypeProviders.slice(0, 3)];
			briefing.targetFiles = [...new Set(briefing.targetFiles)].slice(0, 12);
		}

		briefing.dependencies = [...new Set(allDependencies)].filter((f) => !briefing.targetFiles.includes(f)).slice(0, 8); // Increased limit

		// 5. Find impacted files (what depends on target files)
		const allImpacted: string[] = [];
		for (const file of briefing.targetFiles.slice(0, 5)) {
			const importers = index.findImporters(file);
			allImpacted.push(...importers);
		}
		briefing.impactedFiles = [...new Set(allImpacted)].filter((f) => !briefing.targetFiles.includes(f)).slice(0, 8);

		// 6. Enrich type definitions from index - extract FULL definitions for worker context
		// This is critical for tasks that modify or use types - the worker needs to understand the structure
		const typeTerms = searchTerms.filter((t) => /^[A-Z][a-zA-Z0-9]*$/.test(t) && t.length > 2);
		const maxTypeLength = mode === "minimal" ? 200 : mode === "compact" ? 400 : 600;
		let typeDefsAdded = 0;
		const maxTypeDefs = mode === "minimal" ? 2 : mode === "compact" ? 4 : 8;

		for (const typeName of typeTerms.slice(0, 8)) {
			if (typeDefsAdded >= maxTypeDefs) break;

			const info = index.getSymbolInfo(typeName);
			if (info && (info.kind === "interface" || info.kind === "type" || info.kind === "enum")) {
				// Find the file where this type is defined
				const files = index.findSymbolDefinition(typeName);
				const filePath = files.length > 0 ? files[0] : undefined;

				// Get the full type definition source code
				const fullDef = getTypeDefinition(typeName, repoRoot, filePath, maxTypeLength);
				if (fullDef && !briefing.typeDefinitions.includes(fullDef)) {
					briefing.typeDefinitions.push(fullDef);
					typeDefsAdded++;
					sessionLogger.debug({ typeName, file: filePath }, "Added full type definition to context");
				}
			}
		}

		// Also extract types from type-only imports in target files (critical dependencies)
		for (const providerFile of typeProviders.slice(0, 3)) {
			if (typeDefsAdded >= maxTypeDefs) break;

			const fileInfo = index.getFileInfo(providerFile);
			if (fileInfo) {
				// Get exported types from this file
				for (const exp of fileInfo.exports) {
					if (typeDefsAdded >= maxTypeDefs) break;
					if (exp.kind === "interface" || exp.kind === "type" || exp.kind === "enum") {
						const fullDef = getTypeDefinition(exp.name, repoRoot, providerFile, maxTypeLength);
						if (fullDef && !briefing.typeDefinitions.includes(fullDef)) {
							briefing.typeDefinitions.push(fullDef);
							typeDefsAdded++;
						}
					}
				}
			}
		}

		// 7. Get file summaries for target files (compact and informative)
		const allRelevantFiles = [...briefing.targetFiles.slice(0, 5), ...briefing.dependencies.slice(0, 2)];
		briefing.fileSummaries = index.getFileSummaries(allRelevantFiles);

		// 8. Lazy incremental update: check if target files are stale
		const filesToCheck = briefing.targetFiles.slice(0, 10);
		const staleFiles = filesToCheck.filter((f) => index.isStale(f));
		if (staleFiles.length > 0) {
			sessionLogger.debug({ count: staleFiles.length }, "Updating stale files in AST index");
			await index.indexFiles(staleFiles);
			await index.save();
		}

		sessionLogger.debug(
			{
				filesFound,
				symbolsFound,
				symbolStubs: briefing.symbolStubs.length,
				dependencies: briefing.dependencies.length,
				impactedFiles: briefing.impactedFiles.length,
			},
			"AST index primary lookup complete",
		);

		// Consider sufficient if we found at least one file or symbol
		const sufficient = filesFound > 0 || symbolsFound > 0;
		return { sufficient, filesFound, symbolsFound };
	} catch (error) {
		// AST index errors are non-fatal - fall back to git grep
		sessionLogger.debug({ error: String(error) }, "AST index primary lookup failed");
		return { sufficient: false, filesFound: 0, symbolsFound: 0 };
	}
}

/**
 * Build the full briefing document
 */
function buildBriefingDoc(briefing: ContextBriefing, _mode: ContextMode, _tokenBudget: number): string {
	const sections: string[] = [];

	sections.push(`# CONTEXT BRIEFING`);

	// For simple single-file tasks, add a very explicit quick-start
	if (briefing.targetFiles.length === 1) {
		sections.push(`\n**QUICK START: Modify \`${briefing.targetFiles[0]}\` to complete the objective below.**`);
	} else if (briefing.targetFiles.length > 0 && briefing.targetFiles.length <= 3) {
		sections.push(
			`\n**QUICK START: Focus your changes on these ${briefing.targetFiles.length} files:**\n${briefing.targetFiles.map((f) => `- \`${f}\``).join("\n")}`,
		);
	}

	sections.push(`\n## Objective\n${briefing.objective}`);

	if (briefing.constraints.length > 0) {
		sections.push(`\n## Constraints\n${briefing.constraints.map((c) => `- ${c}`).join("\n")}`);
	}

	// Make target files section more directive
	if (briefing.targetFiles.length > 0) {
		if (briefing.targetFiles.length === 1) {
			sections.push(
				`\n## PRIMARY FILE TO MODIFY\n\`${briefing.targetFiles[0]}\`\nRead this file first, then make your changes here.`,
			);
		} else {
			sections.push(
				`\n## FILES TO MODIFY (in order of priority)\n${briefing.targetFiles.map((f, i) => `${i + 1}. \`${f}\``).join("\n")}`,
			);
		}
	}

	// Add file summaries if available
	const summaryEntries = Object.entries(briefing.fileSummaries);
	if (summaryEntries.length > 0) {
		const summaryLines = summaryEntries.map(([file, summary]) => `- \`${file}\`: ${summary}`);
		sections.push(`\n## File Summaries\n${summaryLines.join("\n")}`);
	}

	// Add dependencies section - these are for READING, not modifying
	if (briefing.dependencies.length > 0) {
		sections.push(
			`\n## Reference Files (read-only, for context)\n${briefing.dependencies.map((f) => `- \`${f}\``).join("\n")}`,
		);
	}

	// Add impact analysis section (files that depend on target files)
	if (briefing.impactedFiles.length > 0) {
		sections.push(
			`\n## Impact Analysis (may need updates if API changes)\n${briefing.impactedFiles.map((f) => `- \`${f}\``).join("\n")}`,
		);
	}

	if (briefing.functionSignatures.length > 0) {
		sections.push(`\n## Relevant Functions\n\`\`\`\n${briefing.functionSignatures.join("\n")}\n\`\`\``);
	}

	if (briefing.typeDefinitions.length > 0) {
		sections.push(`\n## Available Types\n${briefing.typeDefinitions.map((t) => `- ${t}`).join("\n")}`);
	}

	if (briefing.relatedPatterns.length > 0) {
		sections.push(`\n## Related Patterns\n${briefing.relatedPatterns.map((p) => `- ${p}`).join("\n")}`);
	}

	sections.push(
		`\n## Instructions\n1. Read the primary file(s) listed above\n2. Make focused changes to complete the objective\n3. Follow existing patterns in the codebase\n4. Avoid modifying unrelated files`,
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
3. Make minimal changes to complete the objective`;
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
