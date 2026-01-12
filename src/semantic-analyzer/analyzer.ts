import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { glob } from "glob";
import { IssueDetector } from "./detectors.js";
import { FactExtractor } from "./fact-extractor.js";
import { countFileTokens } from "./tokenizer.js";
import type { Action, FileAnalysis, FileType, GlobalMetrics, Issue, Redundancy, SemanticReport } from "./types.js";

export interface AnalyzerOptions {
	rootDir: string;
	include?: string[];
	exclude?: string[];
}

export class SemanticAnalyzer {
	private factExtractor = new FactExtractor();
	private issueDetector = new IssueDetector();

	async analyze(options: AnalyzerOptions): Promise<SemanticReport> {
		const patterns = options.include || ["src/**/*.ts", ".claude/**/*.md", "*.md", "package.json"];

		const excludePatterns = options.exclude || [
			"**/node_modules/**",
			"**/dist/**",
			"**/__tests__/**",
			"**/coverage/**",
		];

		const files = await glob(patterns, {
			cwd: options.rootDir,
			ignore: excludePatterns,
			absolute: true,
		});

		const fileContents = new Map<string, string>();
		const fileAnalyses: FileAnalysis[] = [];

		// Analyze each file
		for (const filePath of files) {
			try {
				const content = readFileSync(filePath, "utf-8");
				const relativePath = relative(options.rootDir, filePath);
				fileContents.set(relativePath, content);

				const analysis = this.analyzeFile(relativePath, content);
				fileAnalyses.push(analysis);
			} catch (_error) {}
		}

		// Detect cross-file issues
		const duplicates = this.issueDetector.detectDuplicateDefinitions(fileContents);

		// Add duplicate issues to file analyses
		for (const [filePath, issues] of duplicates.entries()) {
			const analysis = fileAnalyses.find((a) => a.path === filePath);
			if (analysis) {
				analysis.issues.push(...issues);
			}
		}

		// Build redundancy report
		const redundancies = this.detectRedundancies(fileAnalyses);

		// Generate actions
		const actions = this.generateActions(fileAnalyses, redundancies);

		// Calculate global metrics
		const metrics = this.calculateMetrics(fileAnalyses);

		return {
			files: fileAnalyses,
			redundancies,
			actions,
			metrics,
		};
	}

	private analyzeFile(filePath: string, content: string): FileAnalysis {
		const fileType = this.detectFileType(filePath);
		const tokens = countFileTokens(content);

		// Extract facts based on file type
		let facts = 0;
		if (fileType === "code" || fileType === "test") {
			facts = this.factExtractor.extractFromTypeScript(content, filePath).length;
		} else if (fileType === "docs" || fileType === "claude_rules") {
			facts = this.factExtractor.extractFromMarkdown(content, filePath).length;
		} else if (fileType === "config") {
			facts = this.factExtractor.extractFromJSON(content, filePath).length;
		}

		const density = tokens > 0 ? facts / (tokens / 1000) : 0;

		// Detect issues
		const issues: Issue[] = [];

		if (fileType === "code" || fileType === "test") {
			issues.push(...this.issueDetector.detectRedundantComments(content, filePath));
			issues.push(...this.issueDetector.detectUnclearNaming(content, filePath));
		}

		if (fileType === "docs" || fileType === "claude_rules") {
			issues.push(...this.issueDetector.detectLowDensityProse(content, filePath));
		}

		return {
			path: filePath,
			type: fileType,
			tokens,
			facts,
			density,
			issues,
		};
	}

	private detectFileType(filePath: string): FileType {
		if (filePath.includes(".claude/rules")) return "claude_rules";
		if (filePath.endsWith(".md")) return "docs";
		if (filePath.endsWith(".json")) return "config";
		if (filePath.includes("__tests__") || filePath.endsWith(".test.ts")) return "test";
		if (filePath.endsWith(".ts")) return "code";
		return "other";
	}

	private detectRedundancies(analyses: FileAnalysis[]): Redundancy[] {
		const redundancies: Redundancy[] = [];

		// Group issues by type
		const duplicatesByName = new Map<string, string[]>();

		for (const analysis of analyses) {
			for (const issue of analysis.issues) {
				if (issue.type === "duplicate_definition" && issue.data?.name) {
					const name = issue.data.name as string;
					if (!duplicatesByName.has(name)) {
						duplicatesByName.set(name, []);
					}
					duplicatesByName.get(name)?.push(`${analysis.path}:${issue.line}`);
				}
			}
		}

		for (const [name, locations] of duplicatesByName.entries()) {
			if (locations.length > 1) {
				redundancies.push({
					fact: `Definition of ${name}`,
					locations,
					action: "consolidate",
					primaryLocation: locations[0],
				});
			}
		}

		return redundancies;
	}

	private generateActions(analyses: FileAnalysis[], redundancies: Redundancy[]): Action[] {
		const actions: Action[] = [];

		// Generate actions from issues
		for (const analysis of analyses) {
			for (const issue of analysis.issues) {
				switch (issue.type) {
					case "redundant_comment":
						if (issue.line) {
							actions.push({
								priority: "medium",
								type: "remove_lines",
								file: analysis.path,
								data: { lines: [issue.line] },
								description: `Remove redundant comment at line ${issue.line}`,
							});
						}
						break;

					case "low_density":
						if (issue.startLine && issue.endLine) {
							actions.push({
								priority: "medium",
								type: "convert_to_table",
								file: analysis.path,
								data: {
									startLine: issue.startLine,
									endLine: issue.endLine,
								},
								description: `Convert prose (lines ${issue.startLine}-${issue.endLine}) to structured format`,
							});
						}
						break;

					case "unclear_naming":
						actions.push({
							priority: "low",
							type: "rename_symbol",
							file: analysis.path,
							data: {
								line: issue.line,
								current: issue.data?.name,
							},
							description: `Rename unclear symbol: ${issue.data?.name}`,
						});
						break;
				}
			}
		}

		// Generate actions from redundancies
		for (const redundancy of redundancies) {
			if (redundancy.primaryLocation) {
				actions.push({
					priority: "high",
					type: "consolidate_definition",
					file: redundancy.primaryLocation.split(":")[0],
					data: {
						fact: redundancy.fact,
						locations: redundancy.locations,
						primary: redundancy.primaryLocation,
					},
					description: `Consolidate ${redundancy.fact} to ${redundancy.primaryLocation}`,
				});
			}
		}

		return actions;
	}

	private calculateMetrics(analyses: FileAnalysis[]): GlobalMetrics {
		const totalTokens = analyses.reduce((sum, a) => sum + a.tokens, 0);
		const totalFacts = analyses.reduce((sum, a) => sum + a.facts, 0);
		const avgDensity = totalTokens > 0 ? totalFacts / (totalTokens / 1000) : 0;

		// Estimate potential savings
		const redundantComments = analyses.reduce(
			(sum, a) => sum + a.issues.filter((i) => i.type === "redundant_comment").length,
			0,
		);
		const lowDensityBlocks = analyses.reduce(
			(sum, a) => sum + a.issues.filter((i) => i.type === "low_density").length,
			0,
		);

		// Rough estimate: each redundant comment = 10 tokens, each low density block = 100 tokens
		const potentialSavings = redundantComments * 10 + lowDensityBlocks * 100;
		const savingsPercent = totalTokens > 0 ? (potentialSavings / totalTokens) * 100 : 0;

		const filesByType: Record<FileType, number> = {
			code: 0,
			docs: 0,
			claude_rules: 0,
			config: 0,
			test: 0,
			other: 0,
		};

		const issuesByType: Record<string, number> = {};

		for (const analysis of analyses) {
			filesByType[analysis.type]++;

			for (const issue of analysis.issues) {
				issuesByType[issue.type] = (issuesByType[issue.type] || 0) + 1;
			}
		}

		return {
			totalTokens,
			totalFacts,
			avgDensity,
			potentialSavings,
			savingsPercent,
			filesByType,
			issuesByType,
		};
	}
}
