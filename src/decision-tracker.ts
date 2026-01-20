/**
 * Decision Tracking System
 *
 * Captures decision points from agent execution for:
 * - Learning which decisions can be automated
 * - Building patterns for the automated PM
 * - Identifying what needs human judgment
 *
 * Storage: SQLite (.undercity/undercity.db)
 * Legacy: .undercity/decisions.json (migration only)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	hasDecisionData,
	loadDecisionStoreFromDB,
	saveDecision as saveDecisionDB,
	saveDecisionResolution as saveDecisionResolutionDB,
	saveHumanOverrideDB,
	updateDecisionOutcomeDB,
} from "./storage.js";

const DEFAULT_STATE_DIR = ".undercity";
const DECISIONS_FILE = "decisions.json";

/**
 * Categories of decisions
 */
export type DecisionCategory =
	| "auto_handle" // Retries, lint fixes, rebases - just do it
	| "pm_decidable" // Scope, approach, priority - PM can decide
	| "human_required"; // Security, breaking changes, novel - needs human

/**
 * Confidence level for PM decisions
 */
export type ConfidenceLevel = "high" | "medium" | "low";

/**
 * A captured decision point
 */
export interface DecisionPoint {
	/** Unique ID */
	id: string;
	/** Task this decision is part of */
	taskId: string;
	/** The decision question/choice */
	question: string;
	/** Available options (if known) */
	options?: string[];
	/** Context around the decision */
	context: string;
	/** Category assigned by classifier */
	category: DecisionCategory;
	/** Keywords extracted for pattern matching */
	keywords: string[];
	/** When captured */
	capturedAt: string;
}

/**
 * Resolution of a decision
 */
export interface DecisionResolution {
	/** ID of the decision */
	decisionId: string;
	/** Who resolved it */
	resolvedBy: "auto" | "pm" | "human";
	/** What was decided */
	decision: string;
	/** Reasoning provided */
	reasoning?: string;
	/** Confidence if PM decided */
	confidence?: ConfidenceLevel;
	/** When resolved */
	resolvedAt: string;
	/** Outcome after decision (success/failure) */
	outcome?: "success" | "failure" | "pending";
}

/**
 * Human override of a PM or auto decision
 */
export interface HumanOverride {
	/** ID of the decision */
	decisionId: string;
	/** What was originally decided */
	originalDecision: string;
	/** Who originally decided */
	originalResolver: "auto" | "pm";
	/** What human changed it to */
	humanDecision: string;
	/** Why human overrode */
	humanReasoning?: string;
	/** When overridden */
	overriddenAt: string;
}

/**
 * Full decision store
 */
export interface DecisionStore {
	/** Pending decisions awaiting resolution */
	pending: DecisionPoint[];
	/** Resolved decisions */
	resolved: Array<DecisionPoint & { resolution: DecisionResolution }>;
	/** Human overrides (for learning) */
	overrides: HumanOverride[];
	/** Version */
	version: string;
	/** Last updated */
	lastUpdated: string;
}

/**
 * Patterns that indicate decision types
 */
const DECISION_PATTERNS = {
	// Auto-handle: just do it, no decision needed
	auto_handle: [
		/retry|retrying|attempting again/i,
		/fixing lint|lint error|formatting/i,
		/rebase|rebasing|merge conflict/i,
		/rate limit|throttl/i,
		/escalating to \w+ model/i,
	],
	// Human required: always escalate
	human_required: [
		/security|authentication|authorization/i,
		/breaking change|backwards compat/i,
		/delete|remove.*production|drop.*table/i,
		/credential|secret|api.?key|password/i,
		/payment|billing|subscription/i,
		/gdpr|pii|personal.?data/i,
	],
	// PM decidable: scope, approach, priority questions
	pm_decidable: [
		/should (i|we)|shall (i|we)/i,
		/which approach|two (options|approaches|ways)/i,
		/refactor while|also (fix|update|change)/i,
		/priority|prioritize|first/i,
		/scope|out of scope|expand/i,
		/trade.?off|versus|vs\./i,
	],
};

function getStorePath(stateDir: string): string {
	return join(stateDir, DECISIONS_FILE);
}

function generateDecisionId(): string {
	return `dec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Load decision store from JSON file (for migration only)
 */
function loadDecisionStoreFromJSON(stateDir: string): DecisionStore | null {
	const path = getStorePath(stateDir);

	if (!existsSync(path)) {
		return null;
	}

	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content) as DecisionStore;
	} catch {
		return null;
	}
}

/**
 * Migrate JSON data to SQLite (one-time migration)
 */
function migrateDecisionStoreToSQLite(store: DecisionStore, stateDir: string): void {
	// Migrate pending decisions
	for (const decision of store.pending) {
		saveDecisionDB(decision, stateDir);
	}

	// Migrate resolved decisions
	for (const resolved of store.resolved) {
		// First save the decision point
		const decision: DecisionPoint = {
			id: resolved.id,
			taskId: resolved.taskId,
			question: resolved.question,
			context: resolved.context,
			category: resolved.category,
			keywords: resolved.keywords,
			capturedAt: resolved.capturedAt,
			options: resolved.options,
		};
		saveDecisionDB(decision, stateDir);
		saveDecisionResolutionDB(resolved.resolution, stateDir);
	}

	// Migrate overrides
	for (const override of store.overrides) {
		saveHumanOverrideDB(
			{
				decisionId: override.decisionId,
				originalDecision: override.originalDecision,
				originalResolver: override.originalResolver,
				humanDecision: override.humanDecision,
				humanReasoning: override.humanReasoning,
				overriddenAt: override.overriddenAt,
			},
			stateDir,
		);
	}
}

/**
 * Load decision store (SQLite primary, JSON migration fallback)
 */
export function loadDecisionStore(stateDir: string = DEFAULT_STATE_DIR): DecisionStore {
	try {
		// Check if SQLite has data
		if (hasDecisionData(stateDir)) {
			// Load from SQLite
			const dbStore = loadDecisionStoreFromDB(stateDir);
			return {
				pending: dbStore.pending,
				resolved: dbStore.resolved,
				overrides: dbStore.overrides,
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};
		}

		// Try JSON fallback and migrate
		const jsonStore = loadDecisionStoreFromJSON(stateDir);
		if (jsonStore && (jsonStore.pending.length > 0 || jsonStore.resolved.length > 0 || jsonStore.overrides.length > 0)) {
			migrateDecisionStoreToSQLite(jsonStore, stateDir);
			return jsonStore;
		}
	} catch {
		// Fall through to empty store
	}

	return {
		pending: [],
		resolved: [],
		overrides: [],
		version: "1.0",
		lastUpdated: new Date().toISOString(),
	};
}


/**
 * Extract keywords from decision context
 */
function extractKeywords(text: string): string[] {
	const stopWords = new Set([
		"the",
		"a",
		"an",
		"is",
		"are",
		"was",
		"were",
		"be",
		"been",
		"have",
		"has",
		"had",
		"do",
		"does",
		"did",
		"will",
		"would",
		"could",
		"should",
		"may",
		"might",
		"must",
		"i",
		"we",
		"you",
		"it",
		"this",
		"that",
		"these",
		"those",
		"and",
		"or",
		"but",
		"if",
		"then",
		"else",
		"when",
		"where",
		"what",
		"which",
		"who",
		"how",
		"to",
		"of",
		"in",
		"for",
		"on",
		"with",
		"at",
		"by",
		"from",
		"as",
	]);

	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((word) => word.length > 2 && !stopWords.has(word));
}

/**
 * Classify a decision based on patterns
 */
export function classifyDecision(question: string, context: string): DecisionCategory {
	const fullText = `${question} ${context}`;

	// Check human-required first (highest priority)
	for (const pattern of DECISION_PATTERNS.human_required) {
		if (pattern.test(fullText)) {
			return "human_required";
		}
	}

	// Check auto-handle
	for (const pattern of DECISION_PATTERNS.auto_handle) {
		if (pattern.test(fullText)) {
			return "auto_handle";
		}
	}

	// Check PM-decidable
	for (const pattern of DECISION_PATTERNS.pm_decidable) {
		if (pattern.test(fullText)) {
			return "pm_decidable";
		}
	}

	// Default to PM-decidable (let PM triage)
	return "pm_decidable";
}

/**
 * Capture a decision point
 */
export function captureDecision(
	taskId: string,
	question: string,
	context: string,
	options?: string[],
	stateDir: string = DEFAULT_STATE_DIR,
): DecisionPoint {
	const decision: DecisionPoint = {
		id: generateDecisionId(),
		taskId,
		question,
		options,
		context,
		category: classifyDecision(question, context),
		keywords: extractKeywords(`${question} ${context}`),
		capturedAt: new Date().toISOString(),
	};

	// Write to SQLite
	saveDecisionDB(decision, stateDir);

	return decision;
}

/**
 * Resolve a pending decision
 */
export function resolveDecision(
	decisionId: string,
	resolution: Omit<DecisionResolution, "decisionId" | "resolvedAt">,
	stateDir: string = DEFAULT_STATE_DIR,
): boolean {
	// Check if decision exists in pending
	const store = loadDecisionStore(stateDir);
	const pendingIndex = store.pending.findIndex((d) => d.id === decisionId);
	if (pendingIndex === -1) {
		return false;
	}

	const fullResolution: DecisionResolution = {
		...resolution,
		decisionId,
		resolvedAt: new Date().toISOString(),
	};

	// Write to SQLite
	saveDecisionResolutionDB(fullResolution, stateDir);

	return true;
}

/**
 * Record a human override of a decision
 */
export function recordOverride(
	decisionId: string,
	originalDecision: string,
	originalResolver: "auto" | "pm",
	humanDecision: string,
	humanReasoning?: string,
	stateDir: string = DEFAULT_STATE_DIR,
): void {
	// Write to SQLite
	saveHumanOverrideDB(
		{
			decisionId,
			originalDecision,
			originalResolver,
			humanDecision,
			humanReasoning,
			overriddenAt: new Date().toISOString(),
		},
		stateDir,
	);
}

/**
 * Update outcome of a resolved decision
 */
export function updateDecisionOutcome(
	decisionId: string,
	outcome: "success" | "failure",
	stateDir: string = DEFAULT_STATE_DIR,
): boolean {
	// Write to SQLite and return whether it succeeded
	return updateDecisionOutcomeDB(decisionId, outcome, stateDir);
}

/**
 * Get pending decisions for a task
 */
export function getPendingDecisions(taskId?: string, stateDir: string = DEFAULT_STATE_DIR): DecisionPoint[] {
	const store = loadDecisionStore(stateDir);

	if (taskId) {
		return store.pending.filter((d) => d.taskId === taskId);
	}
	return store.pending;
}

/**
 * Get decisions by category
 */
export function getDecisionsByCategory(
	category: DecisionCategory,
	stateDir: string = DEFAULT_STATE_DIR,
): DecisionPoint[] {
	const store = loadDecisionStore(stateDir);
	return store.pending.filter((d) => d.category === category);
}

/**
 * Find similar past decisions for learning
 */
export function findSimilarDecisions(
	keywords: string[],
	limit: number = 5,
	stateDir: string = DEFAULT_STATE_DIR,
): Array<DecisionPoint & { resolution: DecisionResolution }> {
	const store = loadDecisionStore(stateDir);

	// Only consider resolved decisions with outcomes
	const withOutcomes = store.resolved.filter((d) => d.resolution.outcome);

	// Score by keyword overlap
	const scored = withOutcomes.map((decision) => {
		const overlap = keywords.filter((k) => decision.keywords.includes(k)).length;
		return { decision, score: overlap };
	});

	return scored
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((s) => s.decision);
}

/**
 * Get decision statistics
 */
export function getDecisionStats(stateDir: string = DEFAULT_STATE_DIR): {
	pending: number;
	resolved: number;
	overrides: number;
	byCategory: Record<DecisionCategory, number>;
	byResolver: Record<string, number>;
	successRate: Record<string, number>;
} {
	const store = loadDecisionStore(stateDir);

	const byCategory: Record<DecisionCategory, number> = {
		auto_handle: 0,
		pm_decidable: 0,
		human_required: 0,
	};

	const byResolver: Record<string, number> = {
		auto: 0,
		pm: 0,
		human: 0,
	};

	const outcomes: Record<string, { success: number; total: number }> = {
		auto: { success: 0, total: 0 },
		pm: { success: 0, total: 0 },
		human: { success: 0, total: 0 },
	};

	for (const decision of store.resolved) {
		byCategory[decision.category]++;
		byResolver[decision.resolution.resolvedBy]++;

		if (decision.resolution.outcome) {
			outcomes[decision.resolution.resolvedBy].total++;
			if (decision.resolution.outcome === "success") {
				outcomes[decision.resolution.resolvedBy].success++;
			}
		}
	}

	const successRate: Record<string, number> = {};
	for (const [resolver, data] of Object.entries(outcomes)) {
		successRate[resolver] = data.total > 0 ? data.success / data.total : 0;
	}

	return {
		pending: store.pending.length,
		resolved: store.resolved.length,
		overrides: store.overrides.length,
		byCategory,
		byResolver,
		successRate,
	};
}

/**
 * Parse agent output for decision points
 * Returns questions/choices the agent surfaced
 */
export function parseAgentOutputForDecisions(
	output: string,
	_taskId: string,
): Array<{ question: string; context: string; options?: string[] }> {
	const decisions: Array<{ question: string; context: string; options?: string[] }> = [];

	// Patterns that indicate decision points in agent output
	const questionPatterns = [
		// Direct questions
		/(?:should (?:I|we)|shall (?:I|we)|would you like me to|do you want me to)\s+([^?.]+\?)/gi,
		// Option presentation
		/(?:I can either|there are (?:two|several|multiple) (?:options|approaches|ways))[\s\S]{0,200}?(?:1\.|option 1|first)/gi,
		// Uncertainty markers
		/(?:I'm not sure whether|unsure if|uncertain about)\s+([^.]+)/gi,
		// Trade-off presentation
		/(?:trade-?off|on one hand|alternatively)\s+([^.]+)/gi,
	];

	for (const pattern of questionPatterns) {
		const matches = output.matchAll(pattern);
		for (const match of matches) {
			const fullMatch = match[0];
			const startIndex = match.index || 0;

			// Get surrounding context (100 chars before and after)
			const contextStart = Math.max(0, startIndex - 100);
			const contextEnd = Math.min(output.length, startIndex + fullMatch.length + 100);
			const context = output.slice(contextStart, contextEnd);

			// Try to extract options if present
			const optionsMatch = context.match(
				/(?:1\.|option 1|first)[:\s]+([^\n]+)[\s\S]*?(?:2\.|option 2|second)[:\s]+([^\n]+)/i,
			);
			const options = optionsMatch ? [optionsMatch[1].trim(), optionsMatch[2].trim()] : undefined;

			decisions.push({
				question: fullMatch.trim(),
				context: context.trim(),
				options,
			});
		}
	}

	return decisions;
}
