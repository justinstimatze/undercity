/**
 * Complexity Assessment Module
 *
 * Estimates task complexity to determine:
 * - Which model to use (haiku/sonnet/opus)
 * - Whether to use solo mode or full agent chain
 * - How much verification is needed
 *
 * Uses heuristics + optional LLM assessment for complex cases.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { raidLogger } from "./logger.js";

/**
 * Complexity levels with associated configurations
 */
export type ComplexityLevel = "trivial" | "simple" | "standard" | "complex" | "critical";

/**
 * Result of complexity assessment
 */
export interface ComplexityAssessment {
	/** The assessed complexity level */
	level: ComplexityLevel;
	/** Confidence in the assessment (0-1) */
	confidence: number;
	/** Recommended model for execution */
	model: "haiku" | "sonnet" | "opus";
	/** Whether to use full agent chain or solo mode */
	useFullChain: boolean;
	/** Whether sheriff review is recommended */
	needsReview: boolean;
	/** Estimated scope (files likely to change) */
	estimatedScope: "single-file" | "few-files" | "many-files" | "cross-package";
	/** Signals that influenced the decision */
	signals: string[];
	/** Raw score used for assessment */
	score: number;
}

/**
 * Keywords and patterns that indicate complexity
 */
const COMPLEXITY_SIGNALS = {
	trivial: {
		keywords: ["typo", "comment", "rename", "fix typo", "update comment", "version bump"],
		patterns: [/^fix\s+typo/i, /^update\s+comment/i, /^bump\s+version/i],
		weight: 0,
	},
	simple: {
		keywords: ["add log", "simple fix", "small change", "minor", "tweak", "adjust", "update import", "add import"],
		patterns: [/^add\s+(a\s+)?log/i, /^simple\s+/i, /^small\s+/i],
		weight: 1,
	},
	standard: {
		keywords: ["add feature", "implement", "create", "build", "update", "modify", "fix bug", "add test"],
		patterns: [/^add\s+/i, /^implement\s+/i, /^create\s+/i, /^fix\s+/i],
		weight: 2,
	},
	complex: {
		keywords: [
			"refactor",
			"migrate",
			"redesign",
			"rewrite",
			"integrate",
			"cross-package",
			"multi-file",
			"architecture",
			"api change",
			"breaking change",
		],
		patterns: [/refactor/i, /migrate/i, /redesign/i, /integration/i, /across\s+(multiple|all)/i],
		weight: 3,
	},
	critical: {
		keywords: [
			"security",
			"authentication",
			"authorization",
			"payment",
			"database migration",
			"production",
			"critical",
			"breaking",
		],
		patterns: [/security/i, /auth/i, /payment/i, /migration/i, /production/i],
		weight: 4,
	},
};

/**
 * Scope indicators based on task description
 */
const SCOPE_SIGNALS = {
	"single-file": ["in file", "this file", "one file", "the function", "the component"],
	"few-files": ["a few files", "related files", "and tests", "with types"],
	"many-files": ["multiple files", "several files", "across files", "throughout"],
	"cross-package": ["cross-package", "multiple packages", "common and", "server and client"],
};

/**
 * Assess complexity of a task using heuristics
 *
 * Fast, no API calls, good for initial triage
 */
export function assessComplexityFast(task: string): ComplexityAssessment {
	if (!task) {
		return {
			level: "simple",
			confidence: 0.5,
			model: "haiku",
			useFullChain: false,
			needsReview: false,
			estimatedScope: "single-file",
			score: 1,
			signals: ["no task description provided"]
		};
	}
	const taskLower = task.toLowerCase();
	const signals: string[] = [];
	let score = 0;

	// Check each complexity level
	for (const [level, config] of Object.entries(COMPLEXITY_SIGNALS)) {
		// Check keywords
		for (const keyword of config.keywords) {
			if (taskLower.includes(keyword)) {
				signals.push(`${level}:keyword:${keyword}`);
				score += config.weight;
			}
		}

		// Check patterns
		for (const pattern of config.patterns) {
			if (pattern.test(task)) {
				signals.push(`${level}:pattern:${pattern.source}`);
				score += config.weight;
			}
		}
	}

	// Assess scope
	let estimatedScope: ComplexityAssessment["estimatedScope"] = "few-files";
	for (const [scope, keywords] of Object.entries(SCOPE_SIGNALS)) {
		for (const keyword of keywords) {
			if (taskLower.includes(keyword)) {
				estimatedScope = scope as ComplexityAssessment["estimatedScope"];
				signals.push(`scope:${scope}`);
				break;
			}
		}
	}

	// Scope affects score
	const scopeWeights: Record<string, number> = {
		"single-file": 0,
		"few-files": 1,
		"many-files": 2,
		"cross-package": 3,
	};
	score += scopeWeights[estimatedScope] || 0;

	// Task length is a weak signal of complexity
	const wordCount = task.split(/\s+/).length;
	if (wordCount > 50) {
		score += 1;
		signals.push("long-description");
	}
	if (wordCount > 100) {
		score += 1;
		signals.push("very-long-description");
	}

	// Determine level from score
	let level: ComplexityLevel;
	if (score <= 1) {
		level = "trivial";
	} else if (score <= 3) {
		level = "simple";
	} else if (score <= 6) {
		level = "standard";
	} else if (score <= 9) {
		level = "complex";
	} else {
		level = "critical";
	}

	// Map level to configuration
	const levelConfig: Record<
		ComplexityLevel,
		{
			model: "haiku" | "sonnet" | "opus";
			useFullChain: boolean;
			needsReview: boolean;
		}
	> = {
		trivial: { model: "haiku", useFullChain: false, needsReview: false },
		simple: { model: "sonnet", useFullChain: false, needsReview: false },
		standard: { model: "sonnet", useFullChain: false, needsReview: true },
		complex: { model: "opus", useFullChain: true, needsReview: true },
		critical: { model: "opus", useFullChain: true, needsReview: true },
	};

	const config = levelConfig[level];

	return {
		level,
		confidence: signals.length > 0 ? Math.min(0.9, 0.5 + signals.length * 0.1) : 0.3,
		model: config.model,
		useFullChain: config.useFullChain,
		needsReview: config.needsReview,
		estimatedScope,
		signals,
		score,
	};
}

/**
 * Get a more accurate complexity assessment using Haiku for analysis
 *
 * Use when fast assessment confidence is low
 */
export async function assessComplexityDeep(task: string): Promise<ComplexityAssessment> {
	// Start with fast assessment
	const fastAssessment = assessComplexityFast(task);

	// If confidence is high enough, trust it
	if (fastAssessment.confidence >= 0.7) {
		return fastAssessment;
	}

	try {
		let result = "";

		// Use Haiku for quick, cheap assessment
		for await (const message of query({
			prompt: `Assess the complexity of this coding task. Respond with ONLY a JSON object, no other text.

Task: ${task}

Respond with this exact JSON format:
{
  "level": "trivial|simple|standard|complex|critical",
  "scope": "single-file|few-files|many-files|cross-package",
  "reasoning": "brief explanation"
}

Complexity guide:
- trivial: typos, comments, trivial fixes
- simple: add a log, small changes, single function
- standard: typical feature, bug fix, add tests
- complex: refactoring, multi-file changes, architecture
- critical: security, auth, breaking changes, production data`,
			options: {
				model: "claude-3-5-haiku-20241022",
				allowedTools: [],
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				result = message.result;
			}
		}

		// Parse the response
		const jsonMatch = result.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]);
			const level = parsed.level as ComplexityLevel;
			const scope = parsed.scope as ComplexityAssessment["estimatedScope"];

			// Build assessment from LLM response
			const levelConfig: Record<
				ComplexityLevel,
				{
					model: "haiku" | "sonnet" | "opus";
					useFullChain: boolean;
					needsReview: boolean;
				}
			> = {
				trivial: { model: "haiku", useFullChain: false, needsReview: false },
				simple: { model: "sonnet", useFullChain: false, needsReview: false },
				standard: { model: "sonnet", useFullChain: false, needsReview: true },
				complex: { model: "opus", useFullChain: true, needsReview: true },
				critical: { model: "opus", useFullChain: true, needsReview: true },
			};

			const config = levelConfig[level] || levelConfig.standard;

			return {
				level,
				confidence: 0.85,
				model: config.model,
				useFullChain: config.useFullChain,
				needsReview: config.needsReview,
				estimatedScope: scope,
				signals: [...fastAssessment.signals, `llm:${parsed.reasoning}`],
				score: fastAssessment.score,
			};
		}
	} catch (error) {
		raidLogger.warn({ error: String(error) }, "Deep complexity assessment failed, using fast assessment");
	}

	// Fall back to fast assessment
	return fastAssessment;
}

/**
 * Recommend whether to escalate from solo to full chain
 *
 * Called after initial work is done to see if more review is needed
 */
export function shouldEscalateToFullChain(
	assessment: ComplexityAssessment,
	workResult: {
		filesChanged: number;
		linesChanged: number;
		hasTests: boolean;
		hasTypeErrors: boolean;
		hasBuildErrors: boolean;
	},
): boolean {
	// Always escalate if there are errors
	if (workResult.hasTypeErrors || workResult.hasBuildErrors) {
		return true;
	}

	// Escalate if scope was underestimated
	if (assessment.estimatedScope === "single-file" && workResult.filesChanged > 3) {
		return true;
	}

	if (assessment.estimatedScope === "few-files" && workResult.filesChanged > 10) {
		return true;
	}

	// Large changes without tests should be reviewed
	if (workResult.linesChanged > 200 && !workResult.hasTests) {
		return true;
	}

	// Complex/critical always gets full chain
	if (assessment.level === "complex" || assessment.level === "critical") {
		return true;
	}

	return false;
}
