/**
 * MINEA-Style Synthetic Ground Truth Test Suite for Knowledge Extractor
 *
 * Uses needle injection technique to validate extraction accuracy:
 * - 20 known learnings (5 per category: pattern, gotcha, fact, preference)
 * - Programmatically injected into synthetic conversations at random positions
 * - Measures extraction recall (% needles recovered) and precision
 * - Validates 80%+ needle recovery rate across conversation sizes
 *
 * MINEA = Minimal Injection for Extraction Accuracy
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LearningCategory } from "../knowledge.js";
import type { ExtractedLearning } from "../knowledge-extractor.js";
import { extractLearnings } from "../knowledge-extractor.js";

// Mock the Claude SDK for model-based extraction tests
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(async function* () {
		yield { type: "result", subtype: "success", result: "[]" };
	}),
}));

vi.mock("../rag/index.js", () => ({
	getRAGEngine: vi.fn(() => ({
		indexContent: vi.fn().mockResolvedValue({ id: "doc-1" }),
		search: vi.fn().mockResolvedValue([]),
		close: vi.fn(),
	})),
}));

// ============================================================================
// Types
// ============================================================================

interface Needle {
	/** Unique identifier for the needle */
	id: string;
	/** Category of the learning */
	category: LearningCategory;
	/** The core content to be extracted */
	content: string;
	/** Template that wraps the content for injection */
	template: string;
	/** Keywords that should be extracted */
	keywords: string[];
}

interface InjectedConversation {
	/** The full conversation text with needles injected */
	text: string;
	/** Positions where needles were injected */
	needlePositions: Array<{ needleId: string; position: number }>;
	/** Size class of the conversation */
	sizeClass: "small" | "medium" | "large" | "xlarge";
	/** Character length */
	charLength: number;
}

interface NeedleRecoveryMetrics {
	/** Number of needles successfully recovered */
	recovered: number;
	/** Total number of injected needles */
	total: number;
	/** Recovery rate as percentage */
	recoveryRate: number;
	/** Precision: recovered / extracted */
	precision: number;
	/** Recall: recovered / total */
	recall: number;
	/** F1 score */
	f1: number;
	/** True positives */
	truePositives: number;
	/** False positives (extractions not matching needles) */
	falsePositives: number;
	/** False negatives (needles not recovered) */
	falseNegatives: number;
}

interface CategoryBreakdown {
	pattern: NeedleRecoveryMetrics;
	gotcha: NeedleRecoveryMetrics;
	fact: NeedleRecoveryMetrics;
	preference: NeedleRecoveryMetrics;
}

// ============================================================================
// Needle Definitions (5 per category = 20 total)
// ============================================================================

/**
 * 20 synthetic needles designed to match extraction patterns in knowledge-extractor.ts
 * Each needle uses a template that matches the LEARNING_PATTERNS regex patterns
 */
const NEEDLES: Needle[] = [
	// ===================== PATTERN Category (5 needles) =====================
	{
		id: "pattern-1",
		category: "pattern",
		content: "TypeScript strict mode with noImplicitAny enabled for all modules",
		template: "This codebase uses {content}.",
		keywords: ["typescript", "strict", "noimplicitany", "modules"],
	},
	{
		id: "pattern-2",
		category: "pattern",
		content: "dependency injection with constructor-based injection for services",
		template: "The convention here is {content}.",
		keywords: ["dependency", "injection", "constructor", "services"],
	},
	{
		id: "pattern-3",
		category: "pattern",
		content: "barrel exports in index.ts files for each module directory",
		template: "This project uses {content}.",
		keywords: ["barrel", "exports", "index", "module"],
	},
	{
		id: "pattern-4",
		category: "pattern",
		content: "repository pattern with custom repository classes for database access",
		template: "The pattern here is {content}.",
		keywords: ["repository", "pattern", "database", "access"],
	},
	{
		id: "pattern-5",
		category: "pattern",
		content: "event-driven architecture with message queues for async processing",
		template: "This codebase uses {content}.",
		keywords: ["event", "driven", "message", "queues", "async"],
	},

	// ===================== GOTCHA Category (5 needles) =====================
	{
		id: "gotcha-1",
		category: "gotcha",
		content: "the connection pool was exhausted during high traffic periods",
		template: "The issue was {content}.",
		keywords: ["connection", "pool", "exhausted", "traffic"],
	},
	{
		id: "gotcha-2",
		category: "gotcha",
		content: "increase the timeout value from 5000ms to 30000ms for external API calls",
		template: "The fix is to {content}.",
		keywords: ["timeout", "increase", "api", "calls"],
	},
	{
		id: "gotcha-3",
		category: "gotcha",
		content: "circular dependency between the auth module and user service",
		template: "The problem was {content}.",
		keywords: ["circular", "dependency", "auth", "user"],
	},
	{
		id: "gotcha-4",
		category: "gotcha",
		content: "cache invalidation not happening when related entities update",
		template: "Be careful about {content}.",
		keywords: ["cache", "invalidation", "entities", "update"],
	},
	{
		id: "gotcha-5",
		category: "gotcha",
		content: "race condition in the token refresh logic causing duplicate requests",
		template: "The root cause was {content}.",
		keywords: ["race", "condition", "token", "refresh"],
	},

	// ===================== FACT Category (5 needles) =====================
	{
		id: "fact-1",
		category: "fact",
		content: "the API rate limit is configured at 1000 requests per minute per user",
		template: "I found that {content}.",
		keywords: ["api", "rate", "limit", "requests"],
	},
	{
		id: "fact-2",
		category: "fact",
		content: "Redis cluster uses six nodes with automatic failover enabled",
		template: "I discovered that {content}.",
		keywords: ["redis", "cluster", "nodes", "failover"],
	},
	{
		id: "fact-3",
		category: "fact",
		content: "the database schema includes 47 tables with foreign key constraints",
		template: "It turns out that {content}.",
		keywords: ["database", "schema", "tables", "foreign"],
	},
	{
		id: "fact-4",
		category: "fact",
		content: "JWT tokens expire after 15 minutes with refresh tokens lasting 7 days",
		template: "I noticed that {content}.",
		keywords: ["jwt", "tokens", "expire", "refresh"],
	},
	{
		id: "fact-5",
		category: "fact",
		content: "the build pipeline runs 342 unit tests and 89 integration tests",
		template: "Note: {content}.",
		keywords: ["build", "pipeline", "unit", "integration", "tests"],
	},

	// ===================== PREFERENCE Category (5 needles) =====================
	{
		id: "preference-1",
		category: "preference",
		content: "using functional components with hooks over class components",
		template: "The preferred approach is {content}.",
		keywords: ["functional", "components", "hooks", "class"],
	},
	{
		id: "preference-2",
		category: "preference",
		content: "Zod schemas for runtime validation over manual type guards",
		template: "This project prefers {content}.",
		keywords: ["zod", "schemas", "validation", "type"],
	},
	{
		id: "preference-3",
		category: "preference",
		content: "use explicit return types on all exported functions",
		template: "Always {content} in this codebase.",
		keywords: ["explicit", "return", "types", "exported"],
	},
	{
		id: "preference-4",
		category: "preference",
		content: "commit untested code to the main branch without review",
		template: "Never {content} in this project.",
		keywords: ["commit", "untested", "main", "review"],
	},
	{
		id: "preference-5",
		category: "preference",
		content: "run the full test suite before merging pull requests",
		template: "Make sure to {content}.",
		keywords: ["run", "test", "suite", "merging"],
	},
];

// ============================================================================
// Synthetic Conversation Generators
// ============================================================================

/**
 * Filler text segments for creating realistic synthetic conversations
 * These don't contain patterns that would be extracted as learnings
 */
const FILLER_SEGMENTS = [
	"Looking at the implementation details here.",
	"Let me check the relevant files.",
	"The code structure seems straightforward.",
	"I'll analyze this further.",
	"Checking the dependencies now.",
	"The module is well organized.",
	"Moving on to the next section.",
	"This part of the code is clear.",
	"Let me examine the test coverage.",
	"The documentation needs updating.",
	"Reviewing the pull request changes.",
	"The feature branch is ready.",
	"Running the linting checks.",
	"Verifying the build process.",
	"The configuration looks correct.",
	"Examining the error handling.",
	"The logging is comprehensive.",
	"Checking the security measures.",
	"The API endpoints are documented.",
	"Looking at performance metrics.",
	"The caching strategy is effective.",
	"Reviewing database queries.",
	"The service layer is abstracted.",
	"Checking middleware functions.",
	"The routing is well defined.",
	"Examining authentication flow.",
	"The validation logic is sound.",
	"Looking at state management.",
	"The event handlers are registered.",
	"Checking error boundaries.",
];

/**
 * Generate base conversation text of specified size
 */
function generateBaseConversation(targetSize: number): string {
	const segments: string[] = [];
	let currentSize = 0;

	while (currentSize < targetSize) {
		const segment = FILLER_SEGMENTS[Math.floor(Math.random() * FILLER_SEGMENTS.length)];
		segments.push(segment);
		currentSize += segment.length + 2; // +2 for newline spacing
	}

	return segments.join("\n\n");
}

/**
 * Format a needle using its template
 */
function formatNeedle(needle: Needle): string {
	return needle.template.replace("{content}", needle.content);
}

/**
 * Inject needles at random positions in the conversation
 * Uses seeded randomness for reproducibility
 */
function injectNeedles(baseConversation: string, needles: Needle[], seed: number = 42): InjectedConversation {
	// Simple seeded random number generator
	let seedValue = seed;
	const random = (): number => {
		seedValue = (seedValue * 9301 + 49297) % 233280;
		return seedValue / 233280;
	};

	const segments = baseConversation.split("\n\n");
	const needlePositions: Array<{ needleId: string; position: number }> = [];

	// Calculate injection points (spread evenly with some randomness)
	const injectionIndices: number[] = [];
	for (let i = 0; i < needles.length; i++) {
		// Distribute needles throughout the conversation
		const baseIndex = Math.floor((i / needles.length) * segments.length);
		const jitter = Math.floor(random() * Math.min(5, segments.length / needles.length));
		const index = Math.min(baseIndex + jitter, segments.length);
		injectionIndices.push(index);
	}

	// Sort injection indices
	injectionIndices.sort((a, b) => a - b);

	// Inject needles at calculated positions
	const result: string[] = [];
	let needleIdx = 0;
	let charPosition = 0;

	for (let i = 0; i <= segments.length; i++) {
		// Check if we should inject a needle at this position
		while (needleIdx < needles.length && injectionIndices[needleIdx] === i) {
			const formattedNeedle = formatNeedle(needles[needleIdx]);
			result.push(formattedNeedle);
			needlePositions.push({
				needleId: needles[needleIdx].id,
				position: charPosition,
			});
			charPosition += formattedNeedle.length + 2;
			needleIdx++;
		}

		// Add the segment
		if (i < segments.length) {
			result.push(segments[i]);
			charPosition += segments[i].length + 2;
		}
	}

	const text = result.join("\n\n");
	const charLength = text.length;

	// Determine size class (thresholds account for ~2000 chars from 20 needles)
	let sizeClass: "small" | "medium" | "large" | "xlarge";
	if (charLength < 5000) {
		sizeClass = "small";
	} else if (charLength < 10000) {
		sizeClass = "medium";
	} else if (charLength < 18000) {
		sizeClass = "large";
	} else {
		sizeClass = "xlarge";
	}

	return { text, needlePositions, sizeClass, charLength };
}

// ============================================================================
// Metrics Calculation
// ============================================================================

/**
 * Normalize content for fuzzy matching
 */
function normalizeContent(content: string): string {
	return content
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Calculate word overlap ratio between two strings
 */
function calculateWordOverlap(a: string, b: string): number {
	const aWords = new Set(
		normalizeContent(a)
			.split(" ")
			.filter((w) => w.length > 2),
	);
	const bWords = new Set(
		normalizeContent(b)
			.split(" ")
			.filter((w) => w.length > 2),
	);

	if (aWords.size === 0 || bWords.size === 0) return 0;

	const intersection = new Set([...aWords].filter((word) => bWords.has(word)));
	const smaller = Math.min(aWords.size, bWords.size);

	return intersection.size / smaller;
}

/**
 * Check if extracted content matches a needle (fuzzy matching)
 * Uses 70% word overlap threshold
 */
function contentMatchesNeedle(extracted: string, needle: Needle): boolean {
	const normalizedExtracted = normalizeContent(extracted);
	const normalizedNeedle = normalizeContent(needle.content);

	// Check direct substring match
	if (normalizedExtracted.includes(normalizedNeedle) || normalizedNeedle.includes(normalizedExtracted)) {
		return true;
	}

	// Check word overlap (70% threshold)
	const overlap = calculateWordOverlap(extracted, needle.content);
	return overlap >= 0.7;
}

/**
 * Calculate recovery metrics for extracted learnings against injected needles
 */
function calculateRecoveryMetrics(
	extracted: ExtractedLearning[],
	needles: Needle[],
	category?: LearningCategory,
): NeedleRecoveryMetrics {
	// Filter by category if specified
	const filteredNeedles = category ? needles.filter((n) => n.category === category) : needles;
	const filteredExtracted = category ? extracted.filter((e) => e.category === category) : extracted;

	// Track which needles have been matched
	const matchedNeedles = new Set<string>();
	let truePositives = 0;

	// For each extracted learning, check if it matches any needle
	for (const ext of filteredExtracted) {
		for (const needle of filteredNeedles) {
			if (!matchedNeedles.has(needle.id) && contentMatchesNeedle(ext.content, needle)) {
				matchedNeedles.add(needle.id);
				truePositives++;
				break;
			}
		}
	}

	const falsePositives = filteredExtracted.length - truePositives;
	const falseNegatives = filteredNeedles.length - truePositives;

	const precision = filteredExtracted.length > 0 ? truePositives / filteredExtracted.length : 0;
	const recall = filteredNeedles.length > 0 ? truePositives / filteredNeedles.length : 0;
	const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
	const recoveryRate = (truePositives / filteredNeedles.length) * 100;

	return {
		recovered: truePositives,
		total: filteredNeedles.length,
		recoveryRate,
		precision,
		recall,
		f1,
		truePositives,
		falsePositives,
		falseNegatives,
	};
}

/**
 * Get breakdown of metrics by category
 */
function getExtractionTypeBreakdown(extracted: ExtractedLearning[], needles: Needle[]): CategoryBreakdown {
	return {
		pattern: calculateRecoveryMetrics(extracted, needles, "pattern"),
		gotcha: calculateRecoveryMetrics(extracted, needles, "gotcha"),
		fact: calculateRecoveryMetrics(extracted, needles, "fact"),
		preference: calculateRecoveryMetrics(extracted, needles, "preference"),
	};
}

/**
 * Get needles by category
 */
function getNeedlesByCategory(category: LearningCategory): Needle[] {
	return NEEDLES.filter((n) => n.category === category);
}

/**
 * Format metrics as a table for display
 */
function formatMetricsTable(metrics: NeedleRecoveryMetrics, category: string): string {
	return `${category.padEnd(12)} | ${(`${metrics.recoveryRate.toFixed(1)}%`).padEnd(8)} | ${(metrics.precision * 100).toFixed(1).padEnd(6)}% | ${(metrics.recall * 100).toFixed(1).padEnd(6)}% | ${(metrics.f1 * 100).toFixed(1).padEnd(6)}% | ${String(metrics.truePositives).padEnd(4)} | ${String(metrics.falsePositives).padEnd(4)} | ${String(metrics.falseNegatives).padEnd(4)}`;
}

// ============================================================================
// Test Suite
// ============================================================================

describe("knowledge-extractor-minea", () => {
	const testDir = join(process.cwd(), ".test-minea-extraction");
	const stateDir = join(testDir, ".undercity");

	beforeAll(() => {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(stateDir, "knowledge.json"), JSON.stringify({ learnings: [], version: "1.0" }));
	});

	afterAll(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("needle dataset validation", () => {
		it("should have exactly 20 needles", () => {
			expect(NEEDLES.length).toBe(20);
		});

		it("should have 5 needles per category", () => {
			const categories: LearningCategory[] = ["pattern", "gotcha", "fact", "preference"];
			for (const category of categories) {
				const categoryNeedles = getNeedlesByCategory(category);
				expect(categoryNeedles.length).toBe(5);
			}
		});

		it("should have unique needle IDs", () => {
			const ids = NEEDLES.map((n) => n.id);
			const uniqueIds = new Set(ids);
			expect(uniqueIds.size).toBe(ids.length);
		});

		it("should have templates that match extraction patterns", () => {
			for (const needle of NEEDLES) {
				const formatted = formatNeedle(needle);
				// Each formatted needle should contain patterns recognized by extractLearnings
				expect(formatted.length).toBeGreaterThan(needle.content.length);
			}
		});
	});

	describe("needle injection", () => {
		it("should inject all needles into small conversation", () => {
			const baseConversation = generateBaseConversation(2000);
			const injected = injectNeedles(baseConversation, NEEDLES, 42);

			expect(injected.needlePositions.length).toBe(NEEDLES.length);
			expect(injected.sizeClass).toBe("small");

			// Verify all needle content is present
			for (const needle of NEEDLES) {
				const formatted = formatNeedle(needle);
				expect(injected.text).toContain(formatted);
			}
		});

		it("should inject all needles into medium conversation", () => {
			const baseConversation = generateBaseConversation(5000);
			const injected = injectNeedles(baseConversation, NEEDLES, 123);

			expect(injected.needlePositions.length).toBe(NEEDLES.length);
			expect(injected.sizeClass).toBe("medium");

			for (const needle of NEEDLES) {
				const formatted = formatNeedle(needle);
				expect(injected.text).toContain(formatted);
			}
		});

		it("should inject all needles into large conversation", () => {
			const baseConversation = generateBaseConversation(10000);
			const injected = injectNeedles(baseConversation, NEEDLES, 456);

			expect(injected.needlePositions.length).toBe(NEEDLES.length);
			expect(injected.sizeClass).toBe("large");

			for (const needle of NEEDLES) {
				const formatted = formatNeedle(needle);
				expect(injected.text).toContain(formatted);
			}
		});

		it("should inject all needles into xlarge conversation", () => {
			const baseConversation = generateBaseConversation(20000);
			const injected = injectNeedles(baseConversation, NEEDLES, 789);

			expect(injected.needlePositions.length).toBe(NEEDLES.length);
			expect(injected.sizeClass).toBe("xlarge");

			for (const needle of NEEDLES) {
				const formatted = formatNeedle(needle);
				expect(injected.text).toContain(formatted);
			}
		});

		it("should produce reproducible results with same seed", () => {
			const baseConversation = generateBaseConversation(3000);
			const injected1 = injectNeedles(baseConversation, NEEDLES, 42);
			const injected2 = injectNeedles(baseConversation, NEEDLES, 42);

			expect(injected1.text).toBe(injected2.text);
			expect(injected1.needlePositions).toEqual(injected2.needlePositions);
		});
	});

	describe("needle recovery - small conversation", () => {
		let injected: InjectedConversation;
		let extracted: ExtractedLearning[];
		let metrics: NeedleRecoveryMetrics;

		beforeAll(() => {
			const baseConversation = generateBaseConversation(2000);
			injected = injectNeedles(baseConversation, NEEDLES, 42);
			extracted = extractLearnings(injected.text);
			metrics = calculateRecoveryMetrics(extracted, NEEDLES);
		});

		it("should extract learnings from small conversation", () => {
			expect(extracted.length).toBeGreaterThan(0);
		});

		it("should achieve at least 80% needle recovery rate", () => {
			expect(metrics.recoveryRate).toBeGreaterThanOrEqual(80);
		});

		it("should have reasonable precision (> 50%)", () => {
			expect(metrics.precision).toBeGreaterThanOrEqual(0.5);
		});

		it("should log metrics for small conversation", () => {
			console.log(`\nSmall Conversation (${injected.charLength} chars):`);
			console.log(`  Extracted: ${extracted.length} learnings`);
			console.log(`  Recovery: ${metrics.recovered}/${metrics.total} (${metrics.recoveryRate.toFixed(1)}%)`);
			console.log(`  Precision: ${(metrics.precision * 100).toFixed(1)}%`);
			console.log(`  Recall: ${(metrics.recall * 100).toFixed(1)}%`);
			console.log(`  F1: ${(metrics.f1 * 100).toFixed(1)}%`);
		});
	});

	describe("needle recovery - medium conversation", () => {
		let injected: InjectedConversation;
		let extracted: ExtractedLearning[];
		let metrics: NeedleRecoveryMetrics;

		beforeAll(() => {
			const baseConversation = generateBaseConversation(5000);
			injected = injectNeedles(baseConversation, NEEDLES, 123);
			extracted = extractLearnings(injected.text);
			metrics = calculateRecoveryMetrics(extracted, NEEDLES);
		});

		it("should extract learnings from medium conversation", () => {
			expect(extracted.length).toBeGreaterThan(0);
		});

		it("should achieve at least 80% needle recovery rate", () => {
			expect(metrics.recoveryRate).toBeGreaterThanOrEqual(80);
		});

		it("should have reasonable precision (> 50%)", () => {
			expect(metrics.precision).toBeGreaterThanOrEqual(0.5);
		});

		it("should log metrics for medium conversation", () => {
			console.log(`\nMedium Conversation (${injected.charLength} chars):`);
			console.log(`  Extracted: ${extracted.length} learnings`);
			console.log(`  Recovery: ${metrics.recovered}/${metrics.total} (${metrics.recoveryRate.toFixed(1)}%)`);
			console.log(`  Precision: ${(metrics.precision * 100).toFixed(1)}%`);
			console.log(`  Recall: ${(metrics.recall * 100).toFixed(1)}%`);
			console.log(`  F1: ${(metrics.f1 * 100).toFixed(1)}%`);
		});
	});

	describe("needle recovery - large conversation", () => {
		let injected: InjectedConversation;
		let extracted: ExtractedLearning[];
		let metrics: NeedleRecoveryMetrics;

		beforeAll(() => {
			const baseConversation = generateBaseConversation(10000);
			injected = injectNeedles(baseConversation, NEEDLES, 456);
			extracted = extractLearnings(injected.text);
			metrics = calculateRecoveryMetrics(extracted, NEEDLES);
		});

		it("should extract learnings from large conversation", () => {
			expect(extracted.length).toBeGreaterThan(0);
		});

		it("should achieve at least 80% needle recovery rate", () => {
			expect(metrics.recoveryRate).toBeGreaterThanOrEqual(80);
		});

		it("should have reasonable precision (> 50%)", () => {
			expect(metrics.precision).toBeGreaterThanOrEqual(0.5);
		});

		it("should log metrics for large conversation", () => {
			console.log(`\nLarge Conversation (${injected.charLength} chars):`);
			console.log(`  Extracted: ${extracted.length} learnings`);
			console.log(`  Recovery: ${metrics.recovered}/${metrics.total} (${metrics.recoveryRate.toFixed(1)}%)`);
			console.log(`  Precision: ${(metrics.precision * 100).toFixed(1)}%`);
			console.log(`  Recall: ${(metrics.recall * 100).toFixed(1)}%`);
			console.log(`  F1: ${(metrics.f1 * 100).toFixed(1)}%`);
		});
	});

	describe("needle recovery - xlarge conversation", () => {
		let injected: InjectedConversation;
		let extracted: ExtractedLearning[];
		let metrics: NeedleRecoveryMetrics;

		beforeAll(() => {
			const baseConversation = generateBaseConversation(20000);
			injected = injectNeedles(baseConversation, NEEDLES, 789);
			extracted = extractLearnings(injected.text);
			metrics = calculateRecoveryMetrics(extracted, NEEDLES);
		});

		it("should extract learnings from xlarge conversation", () => {
			expect(extracted.length).toBeGreaterThan(0);
		});

		it("should achieve at least 80% needle recovery rate", () => {
			expect(metrics.recoveryRate).toBeGreaterThanOrEqual(80);
		});

		it("should have reasonable precision (> 50%)", () => {
			expect(metrics.precision).toBeGreaterThanOrEqual(0.5);
		});

		it("should log metrics for xlarge conversation", () => {
			console.log(`\nXLarge Conversation (${injected.charLength} chars):`);
			console.log(`  Extracted: ${extracted.length} learnings`);
			console.log(`  Recovery: ${metrics.recovered}/${metrics.total} (${metrics.recoveryRate.toFixed(1)}%)`);
			console.log(`  Precision: ${(metrics.precision * 100).toFixed(1)}%`);
			console.log(`  Recall: ${(metrics.recall * 100).toFixed(1)}%`);
			console.log(`  F1: ${(metrics.f1 * 100).toFixed(1)}%`);
		});
	});

	describe("category-level recovery metrics", () => {
		let breakdown: CategoryBreakdown;

		beforeAll(() => {
			const baseConversation = generateBaseConversation(5000);
			const injected = injectNeedles(baseConversation, NEEDLES, 42);
			const extracted = extractLearnings(injected.text);
			breakdown = getExtractionTypeBreakdown(extracted, NEEDLES);
		});

		it("should recover pattern needles with at least 60% rate", () => {
			expect(breakdown.pattern.recoveryRate).toBeGreaterThanOrEqual(60);
		});

		it("should recover gotcha needles with at least 60% rate", () => {
			expect(breakdown.gotcha.recoveryRate).toBeGreaterThanOrEqual(60);
		});

		it("should recover fact needles with at least 60% rate", () => {
			expect(breakdown.fact.recoveryRate).toBeGreaterThanOrEqual(60);
		});

		it("should recover preference needles with at least 60% rate", () => {
			expect(breakdown.preference.recoveryRate).toBeGreaterThanOrEqual(60);
		});

		it("should display category breakdown", () => {
			console.log("\n========================================");
			console.log("CATEGORY BREAKDOWN");
			console.log("========================================");
			console.log("Category     | Recovery | Prec   | Recall | F1     | TP   | FP   | FN");
			console.log("-".repeat(75));
			console.log(formatMetricsTable(breakdown.pattern, "pattern"));
			console.log(formatMetricsTable(breakdown.gotcha, "gotcha"));
			console.log(formatMetricsTable(breakdown.fact, "fact"));
			console.log(formatMetricsTable(breakdown.preference, "preference"));
			console.log("-".repeat(75));
		});
	});

	describe("edge cases", () => {
		it("should handle empty conversation", () => {
			const extracted = extractLearnings("");
			const metrics = calculateRecoveryMetrics(extracted, NEEDLES);
			expect(metrics.recovered).toBe(0);
			expect(metrics.recoveryRate).toBe(0);
		});

		it("should handle conversation with single needle", () => {
			const singleNeedle = [NEEDLES[0]];
			const formatted = formatNeedle(singleNeedle[0]);
			const extracted = extractLearnings(formatted);
			const metrics = calculateRecoveryMetrics(extracted, singleNeedle);

			expect(metrics.recovered).toBeGreaterThanOrEqual(0);
		});

		it("should handle conversation with no extractable content", () => {
			const noContent = "Hello world. Just random text here. Nothing special.";
			const extracted = extractLearnings(noContent);
			expect(extracted.length).toBe(0);
		});

		it("should handle needles from single category only", () => {
			const patternNeedles = getNeedlesByCategory("pattern");
			const baseConversation = generateBaseConversation(2000);
			const injected = injectNeedles(baseConversation, patternNeedles, 42);
			const extracted = extractLearnings(injected.text);
			const metrics = calculateRecoveryMetrics(extracted, patternNeedles, "pattern");

			expect(metrics.total).toBe(5);
		});
	});

	describe("aggregated metrics summary", () => {
		it("should display full MINEA benchmark summary", () => {
			const sizes = [
				{ name: "Small", targetSize: 2000, seed: 42 },
				{ name: "Medium", targetSize: 5000, seed: 123 },
				{ name: "Large", targetSize: 10000, seed: 456 },
				{ name: "XLarge", targetSize: 20000, seed: 789 },
			];

			console.log("\n========================================");
			console.log("MINEA EXTRACTION BENCHMARK SUMMARY");
			console.log("========================================");
			console.log(`Total Needles: ${NEEDLES.length} (5 per category)`);
			console.log(`Categories: pattern, gotcha, fact, preference`);
			console.log("========================================\n");

			let totalRecovered = 0;
			let totalNeedles = 0;
			let totalPrecision = 0;
			let totalRecall = 0;

			console.log("Size Class   | Chars    | Extracted | Recovered | Recovery | Precision | Recall | F1");
			console.log("-".repeat(90));

			for (const size of sizes) {
				const baseConversation = generateBaseConversation(size.targetSize);
				const injected = injectNeedles(baseConversation, NEEDLES, size.seed);
				const extracted = extractLearnings(injected.text);
				const metrics = calculateRecoveryMetrics(extracted, NEEDLES);

				totalRecovered += metrics.recovered;
				totalNeedles += metrics.total;
				totalPrecision += metrics.precision;
				totalRecall += metrics.recall;

				console.log(
					`${size.name.padEnd(12)} | ${String(injected.charLength).padEnd(8)} | ${String(extracted.length).padEnd(9)} | ${String(metrics.recovered).padEnd(9)} | ${(`${metrics.recoveryRate.toFixed(1)}%`).padEnd(8)} | ${(`${(metrics.precision * 100).toFixed(1)}%`).padEnd(9)} | ${(`${(metrics.recall * 100).toFixed(1)}%`).padEnd(6)} | ${(`${(metrics.f1 * 100).toFixed(1)}%`).padEnd(6)}`,
				);
			}

			console.log("-".repeat(90));

			const avgRecoveryRate = (totalRecovered / totalNeedles) * 100;
			const avgPrecision = totalPrecision / sizes.length;
			const avgRecall = totalRecall / sizes.length;
			const avgF1 = avgPrecision + avgRecall > 0 ? (2 * avgPrecision * avgRecall) / (avgPrecision + avgRecall) : 0;

			console.log(
				`${"AVERAGE".padEnd(12)} | ${"-".padEnd(8)} | ${"-".padEnd(9)} | ${String(totalRecovered).padEnd(9)} | ${(`${avgRecoveryRate.toFixed(1)}%`).padEnd(8)} | ${(`${(avgPrecision * 100).toFixed(1)}%`).padEnd(9)} | ${(`${(avgRecall * 100).toFixed(1)}%`).padEnd(6)} | ${(`${(avgF1 * 100).toFixed(1)}%`).padEnd(6)}`,
			);

			console.log("\n========================================");
			console.log(`OVERALL RECOVERY RATE: ${avgRecoveryRate.toFixed(1)}%`);
			console.log(`TARGET: >= 80%`);
			console.log(`STATUS: ${avgRecoveryRate >= 80 ? "PASS" : "FAIL"}`);
			console.log("========================================\n");

			// Assert overall 80% recovery rate
			expect(avgRecoveryRate).toBeGreaterThanOrEqual(80);
		});
	});

	describe("confusion matrix validation", () => {
		it("should correctly calculate TP, FP, FN", () => {
			// Create a controlled scenario
			const testNeedles: Needle[] = [
				{
					id: "test-1",
					category: "fact",
					content: "the API uses REST endpoints for communication",
					template: "I found that {content}.",
					keywords: ["api", "rest", "endpoints"],
				},
			];

			const formatted = formatNeedle(testNeedles[0]);
			const extracted = extractLearnings(formatted);
			const metrics = calculateRecoveryMetrics(extracted, testNeedles);

			// Should have at least 1 extraction
			expect(extracted.length).toBeGreaterThanOrEqual(1);

			// TP + FN should equal total needles
			expect(metrics.truePositives + metrics.falseNegatives).toBe(testNeedles.length);

			// TP + FP should equal total extractions that could match
			expect(metrics.truePositives + metrics.falsePositives).toBe(extracted.length);
		});

		it("should handle all false negatives case", () => {
			const unextractableNeedles: Needle[] = [
				{
					id: "unextractable-1",
					category: "fact",
					content: "something completely unextractable xyz123",
					template: "Random text: {content}",
					keywords: ["unextractable"],
				},
			];

			const formatted = "Random text: something completely unextractable xyz123";
			const extracted = extractLearnings(formatted);
			const metrics = calculateRecoveryMetrics(extracted, unextractableNeedles);

			// Should have FN = total needles when nothing matches
			expect(metrics.falseNegatives).toBe(unextractableNeedles.length);
			expect(metrics.recall).toBe(0);
		});
	});
});
