/**
 * Quest Analyzer Module
 *
 * Analyzes quest objectives to detect package boundaries, estimate file modifications,
 * and calculate risk scores for intelligent quest matchmaking.
 */

import type { Quest } from "./quest.js";

export interface QuestAnalysis {
	packages: string[];
	estimatedFiles: string[];
	complexity: "low" | "medium" | "high";
	riskScore: number;
	tags: string[];
}

export class QuestAnalyzer {
	private packagePatterns: RegExp[];
	private filePatterns: RegExp[];
	private complexityKeywords: { [key: string]: string };

	constructor() {
		// Package boundary detection patterns
		this.packagePatterns = [
			/\b(?:src\/)?([a-zA-Z0-9-]+)\//g, // src/package-name/
			/\b(?:packages\/)?([a-zA-Z0-9-]+)\//g, // packages/package-name/
			/\b(?:libs?\/)?([a-zA-Z0-9-]+)\//g, // lib/package-name/
			/\b(?:components\/)?([a-zA-Z0-9-]+)\//g, // components/package-name/
			/\b(?:modules\/)?([a-zA-Z0-9-]+)\//g, // modules/package-name/
		];

		// File modification patterns
		this.filePatterns = [
			/\b[\w/-]+\.(?:ts|js|tsx|jsx|py|java|go|rs|cpp|c|h)\b/g, // Source files
			/\b[\w/-]+\.(?:json|yaml|yml|toml|xml)\b/g, // Config files
			/\b[\w/-]+\.(?:md|txt|rst)\b/g, // Documentation files
			/\b[\w/-]+\.(?:css|scss|less|styl)\b/g, // Style files
		];

		// Complexity keywords mapping
		this.complexityKeywords = {
			// High complexity indicators
			refactor: "high",
			migrate: "high",
			rewrite: "high",
			overhaul: "high",
			redesign: "high",
			architecture: "high",
			database: "high",
			security: "high",
			authentication: "high",
			authorization: "high",

			// Medium complexity indicators
			implement: "medium",
			feature: "medium",
			integration: "medium",
			optimize: "medium",
			performance: "medium",
			enhance: "medium",
			extend: "medium",
			improve: "medium",
			update: "medium",
			upgrade: "medium",

			// Low complexity indicators
			fix: "low",
			bug: "low",
			typo: "low",
			text: "low",
			style: "low",
			format: "low",
			documentation: "low",
			comment: "low",
			log: "low",
			debug: "low",
		};
	}

	/**
	 * Analyze a quest for package boundaries, file estimates, and risk factors
	 */
	async analyzeQuest(quest: Quest): Promise<QuestAnalysis> {
		const _objective = quest.objective.toLowerCase();

		// Detect package boundaries
		const packages = this.detectPackageBoundaries(quest.objective);

		// Estimate files that might be touched
		const estimatedFiles = this.estimateFilesTouched(quest.objective);

		// Determine complexity
		const complexity = this.assessComplexity(quest.objective);

		// Calculate risk score
		const riskScore = this.calculateRiskScore(quest, packages, estimatedFiles, complexity);

		// Generate tags
		const tags = this.generateTags(quest.objective, complexity);

		return {
			packages,
			estimatedFiles,
			complexity,
			riskScore,
			tags,
		};
	}

	/**
	 * Detect package boundaries from quest objective
	 */
	detectPackageBoundaries(objective: string): string[] {
		const packages = new Set<string>();

		// Check manual hints first if available
		// (Would be passed in via quest.packageHints)

		// Extract package names from text patterns
		for (const pattern of this.packagePatterns) {
			const matches = objective.matchAll(pattern);
			for (const match of matches) {
				if (match[1] && !this.isCommonWord(match[1])) {
					packages.add(match[1]);
				}
			}
		}

		// Look for common framework/library patterns
		const frameworkPatterns = [
			/\b(react|vue|angular|express|fastapi|django|spring)\b/gi,
			/\b(auth|user|admin|api|client|server|database|db)\b/gi,
			/\b(component|service|model|controller|middleware|util)\b/gi,
		];

		for (const pattern of frameworkPatterns) {
			const matches = objective.matchAll(pattern);
			for (const match of matches) {
				packages.add(match[0].toLowerCase());
			}
		}

		return Array.from(packages);
	}

	/**
	 * Estimate files likely to be touched based on quest description
	 */
	estimateFilesTouched(objective: string): string[] {
		const files = new Set<string>();

		// Extract explicit file references
		for (const pattern of this.filePatterns) {
			const matches = objective.matchAll(pattern);
			for (const match of matches) {
				files.add(match[0]);
			}
		}

		// Infer file types based on waypoint type
		const lowerObjective = objective.toLowerCase();

		if (lowerObjective.includes("test") || lowerObjective.includes("spec")) {
			files.add("**/*.test.{ts,js,tsx,jsx}");
			files.add("**/*.spec.{ts,js,tsx,jsx}");
		}

		if (lowerObjective.includes("component") || lowerObjective.includes("ui")) {
			files.add("**/components/**/*");
			files.add("**/*.{tsx,jsx}");
		}

		if (lowerObjective.includes("api") || lowerObjective.includes("endpoint")) {
			files.add("**/api/**/*");
			files.add("**/routes/**/*");
			files.add("**/controllers/**/*");
		}

		if (lowerObjective.includes("database") || lowerObjective.includes("migration")) {
			files.add("**/migrations/**/*");
			files.add("**/models/**/*");
			files.add("**/schema/**/*");
		}

		if (lowerObjective.includes("style") || lowerObjective.includes("css")) {
			files.add("**/*.{css,scss,less,styl}");
		}

		if (lowerObjective.includes("config") || lowerObjective.includes("setting")) {
			files.add("**/*.{json,yaml,yml,toml}");
			files.add("**/config/**/*");
		}

		if (lowerObjective.includes("documentation") || lowerObjective.includes("readme")) {
			files.add("**/*.{md,txt,rst}");
			files.add("**/docs/**/*");
		}

		return Array.from(files);
	}

	/**
	 * Assess the complexity level of a quest
	 */
	assessComplexity(objective: string): "low" | "medium" | "high" {
		const lowerObjective = objective.toLowerCase();
		const words = lowerObjective.split(/\s+/);

		let highCount = 0;
		let mediumCount = 0;
		let lowCount = 0;

		for (const word of words) {
			const complexity = this.complexityKeywords[word];
			switch (complexity) {
				case "high":
					highCount++;
					break;
				case "medium":
					mediumCount++;
					break;
				case "low":
					lowCount++;
					break;
			}
		}

		// Additional complexity heuristics
		if (words.length > 15) highCount++; // Very detailed waypoints tend to be complex
		if (lowerObjective.includes("across") || lowerObjective.includes("multiple")) mediumCount++;
		if (lowerObjective.includes("breaking change")) highCount++;
		if (lowerObjective.includes("backward compatible")) mediumCount++;

		// Determine final complexity
		if (highCount > 0) return "high";
		if (mediumCount > lowCount) return "medium";
		return "low";
	}

	/**
	 * Calculate risk score based on quest characteristics
	 */
	calculateRiskScore(
		quest: Quest,
		packages: string[],
		estimatedFiles: string[],
		complexity: "low" | "medium" | "high",
	): number {
		let score = 0;

		// Base complexity score
		switch (complexity) {
			case "high":
				score += 0.6;
				break;
			case "medium":
				score += 0.3;
				break;
			case "low":
				score += 0.1;
				break;
		}

		// Package breadth penalty
		if (packages.length > 3) score += 0.2;
		else if (packages.length > 1) score += 0.1;

		// File count penalty
		if (estimatedFiles.length > 10) score += 0.2;
		else if (estimatedFiles.length > 5) score += 0.1;

		// Special keywords that increase risk
		const objective = quest.objective.toLowerCase();
		const riskKeywords = [
			"delete",
			"remove",
			"drop",
			"migration",
			"schema",
			"authentication",
			"security",
			"permission",
			"encryption",
			"payment",
			"billing",
			"transaction",
			"critical",
			"production",
		];

		for (const keyword of riskKeywords) {
			if (objective.includes(keyword)) {
				score += 0.15;
			}
		}

		// Manual risk indicators from quest fields
		if (quest.conflicts && quest.conflicts.length > 0) score += 0.1;
		if (quest.dependsOn && quest.dependsOn.length > 0) score += 0.05;

		// Cap at 1.0
		return Math.min(score, 1.0);
	}

	/**
	 * Generate categorization tags for the quest
	 */
	generateTags(objective: string, complexity: "low" | "medium" | "high"): string[] {
		const tags = new Set<string>();
		const lowerObjective = objective.toLowerCase();

		// Add complexity tag
		tags.add(complexity);

		// Feature type tags
		if (lowerObjective.includes("test") || lowerObjective.includes("spec")) {
			tags.add("testing");
		}
		if (lowerObjective.includes("fix") || lowerObjective.includes("bug")) {
			tags.add("bugfix");
		}
		if (lowerObjective.includes("feature") || lowerObjective.includes("implement")) {
			tags.add("feature");
		}
		if (lowerObjective.includes("refactor") || lowerObjective.includes("cleanup")) {
			tags.add("refactor");
		}
		if (lowerObjective.includes("doc") || lowerObjective.includes("readme")) {
			tags.add("documentation");
		}
		if (lowerObjective.includes("style") || lowerObjective.includes("ui") || lowerObjective.includes("design")) {
			tags.add("ui");
		}
		if (lowerObjective.includes("api") || lowerObjective.includes("endpoint")) {
			tags.add("api");
		}
		if (lowerObjective.includes("database") || lowerObjective.includes("migration")) {
			tags.add("database");
		}
		if (lowerObjective.includes("performance") || lowerObjective.includes("optimize")) {
			tags.add("performance");
		}
		if (lowerObjective.includes("security") || lowerObjective.includes("auth")) {
			tags.add("security");
		}
		if (lowerObjective.includes("config") || lowerObjective.includes("setting")) {
			tags.add("configuration");
		}

		return Array.from(tags);
	}

	/**
	 * Check if a word is a common word that shouldn't be considered a package name
	 */
	private isCommonWord(word: string): boolean {
		const commonWords = new Set([
			"the",
			"and",
			"or",
			"but",
			"in",
			"on",
			"at",
			"to",
			"for",
			"of",
			"with",
			"by",
			"from",
			"up",
			"about",
			"into",
			"through",
			"during",
			"before",
			"after",
			"above",
			"below",
			"over",
			"under",
			"between",
			"among",
			"test",
			"tests",
			"spec",
			"specs",
			"example",
			"examples",
			"sample",
			"demo",
			"docs",
			"doc",
			"documentation",
			"readme",
			"license",
			"src",
			"lib",
			"libs",
			"build",
			"dist",
			"public",
			"assets",
			"static",
		]);
		return commonWords.has(word.toLowerCase());
	}
}
