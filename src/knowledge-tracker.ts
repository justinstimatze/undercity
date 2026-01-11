/**
 * Knowledge Tracking Module
 *
 * Tracks successful prompts, approaches, and learnings across different task types
 * Builds institutional knowledge to improve future raid performance
 *
 * DSPy Evaluation:
 * This module includes assessment logic for determining whether DSPy integration
 * would provide value based on actual metrics data. The assessment analyzes:
 * - Success rates (is prompt quality the bottleneck?)
 * - Escalation patterns (is routing the bottleneck?)
 * - Token efficiency (are prompts optimized?)
 * - Task type performance variance (are specific prompts underperforming?)
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export interface PromptKnowledge {
	/** Unique hash identifier for this prompt/approach */
	id: string;
	/** Type of task this knowledge applies to */
	taskType: string;
	/** The original prompt or input */
	prompt: string;
	/** Successful approach or implementation details */
	approach: string;
	/** Performance metrics from successful execution */
	metrics: {
		/** Tokens used */
		tokensUsed: number;
		/** Execution time in milliseconds */
		executionTimeMs: number;
		/** Success rating (1-5) */
		successRating?: number;
		/** Human satisfaction score (1-5) for DSPy evaluation */
		humanSatisfactionScore?: number;
		/** Error categories encountered (for prompt quality analysis) */
		errorCategories?: string[];
		/** Whether this prompt required human intervention */
		requiredHumanIntervention?: boolean;
	};
	/** Metadata tags for searchability */
	tags: string[];
	/** When this knowledge was first recorded */
	recordedAt: Date;
	/** Number of times this approach has been successful */
	successCount: number;
}

/**
 * KnowledgeTracker manages persistent storage of successful approaches
 * Provides methods to record, search, and retrieve institutional knowledge
 */
export class KnowledgeTracker {
	private storagePath: string;
	private static STORAGE_VERSION = "1.0.0";

	constructor(storagePath: string = ".undercity/knowledge/storage.json") {
		this.storagePath = storagePath;
		this.ensureStorageDirectory();
	}

	/**
	 * Ensure the storage directory exists
	 */
	private ensureStorageDirectory(): void {
		const dir = this.storagePath.substring(0, this.storagePath.lastIndexOf("/"));
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	/**
	 * Generate a unique hash for a prompt
	 */
	private generatePromptHash(prompt: string, taskType: string): string {
		const hash = createHash("sha256");
		hash.update(`${taskType}:${prompt}`);
		return hash.digest("hex").substring(0, 12);
	}

	/**
	 * Load knowledge storage from disk
	 */
	private loadStorage(): {
		version: string;
		lastUpdated: Date;
		knowledge: PromptKnowledge[];
	} {
		if (!existsSync(this.storagePath)) {
			return {
				version: KnowledgeTracker.STORAGE_VERSION,
				lastUpdated: new Date(),
				knowledge: [],
			};
		}

		try {
			const content = readFileSync(this.storagePath, "utf-8");
			const storage = JSON.parse(content) as {
				version: string;
				lastUpdated: string;
				knowledge: PromptKnowledge[];
			};

			// Convert dates back to Date objects
			const knowledgeStorage = {
				version: storage.version,
				lastUpdated: new Date(storage.lastUpdated),
				knowledge: storage.knowledge.map((entry) => ({
					...entry,
					recordedAt: new Date(entry.recordedAt),
				})),
			};

			return knowledgeStorage;
		} catch {
			return {
				version: KnowledgeTracker.STORAGE_VERSION,
				lastUpdated: new Date(),
				knowledge: [],
			};
		}
	}

	/**
	 * Save knowledge storage to disk
	 */
	private saveStorage(storage: { version: string; lastUpdated: Date; knowledge: PromptKnowledge[] }): void {
		storage.lastUpdated = new Date();
		const tempPath = `${this.storagePath}.tmp`;

		try {
			// Write to temporary file first
			writeFileSync(tempPath, JSON.stringify(storage, null, 2), {
				encoding: "utf-8",
				flag: "w",
			});

			// Atomically rename temporary file to target file
			// This ensures the file is never in a partially written state
			renameSync(tempPath, this.storagePath);
		} catch (error) {
			// Clean up temporary file if it exists
			if (existsSync(tempPath)) {
				unlinkSync(tempPath);
			}
			throw error;
		}
	}

	/**
	 * Record a successful prompt/approach
	 */
	recordPromptKnowledge(
		taskType: string,
		prompt: string,
		approach: string,
		metrics: PromptKnowledge["metrics"],
		tags: string[] = [],
	): void {
		const storage = this.loadStorage();
		const promptHash = this.generatePromptHash(prompt, taskType);

		// Check if this prompt approach already exists
		const existingKnowledgeIndex = storage.knowledge.findIndex((k) => k.id === promptHash);

		const knowledgeEntry: PromptKnowledge =
			existingKnowledgeIndex !== -1
				? {
						...storage.knowledge[existingKnowledgeIndex],
						approach, // Update approach with latest successful method
						metrics: {
							tokensUsed: (storage.knowledge[existingKnowledgeIndex].metrics.tokensUsed + metrics.tokensUsed) / 2,
							executionTimeMs:
								(storage.knowledge[existingKnowledgeIndex].metrics.executionTimeMs + metrics.executionTimeMs) / 2,
							successRating: metrics.successRating ?? storage.knowledge[existingKnowledgeIndex].metrics.successRating,
						},
						tags: [...new Set([...storage.knowledge[existingKnowledgeIndex].tags, ...tags])],
						successCount: (storage.knowledge[existingKnowledgeIndex].successCount || 0) + 1,
					}
				: {
						id: promptHash,
						taskType,
						prompt,
						approach,
						metrics,
						tags,
						recordedAt: new Date(),
						successCount: 1,
					};

		if (existingKnowledgeIndex !== -1) {
			storage.knowledge[existingKnowledgeIndex] = knowledgeEntry;
		} else {
			storage.knowledge.push(knowledgeEntry);
		}

		this.saveStorage(storage);
	}

	/**
	 * Retrieve knowledge for a specific task type
	 */
	getKnowledgeByTaskType(taskType: string): PromptKnowledge[] {
		const storage = this.loadStorage();
		return storage.knowledge.filter((k) => k.taskType === taskType).sort((a, b) => b.successCount - a.successCount);
	}

	/**
	 * Search knowledge by tags
	 */
	searchKnowledgeByTags(tags: string[]): PromptKnowledge[] {
		const storage = this.loadStorage();
		return storage.knowledge
			.filter((k) => tags.some((tag) => k.tags.includes(tag)))
			.sort((a, b) => b.successCount - a.successCount);
	}

	/**
	 * Find the most successful prompt for a given task type
	 */
	findMostSuccessfulPrompt(taskType: string, limit: number = 1): PromptKnowledge[] {
		const storage = this.loadStorage();
		return storage.knowledge
			.filter((k) => k.taskType === taskType)
			.sort((a, b) => b.successCount - a.successCount)
			.slice(0, limit);
	}

	/**
	 * Identify low-success prompts for a given task type
	 * @param taskType - The type of task to analyze
	 * @param successThreshold - Maximum number of successful attempts before considering a prompt effective
	 * @param limit - Maximum number of low-success prompts to return
	 */
	identifyLowSuccessPrompts(taskType: string, successThreshold: number = 2, limit: number = 5): PromptKnowledge[] {
		const storage = this.loadStorage();
		return storage.knowledge
			.filter((k) => k.taskType === taskType && (k.successCount === undefined || k.successCount <= successThreshold))
			.sort((a, b) => (a.successCount || 0) - (b.successCount || 0))
			.slice(0, limit);
	}

	/**
	 * Generate prompt improvement suggestions
	 * @param lowSuccessPrompt - The prompt with low success rate
	 * @returns Suggested improvements for the prompt
	 */
	generatePromptImprovements(lowSuccessPrompt: PromptKnowledge): string[] {
		const improvements: string[] = [];

		// Check metrics for potential improvement areas
		if ((lowSuccessPrompt.metrics.tokensUsed || 0) > 1000) {
			improvements.push("Reduce prompt verbosity and token usage");
		}

		// Human intervention analysis for DSPy readiness assessment
		if (lowSuccessPrompt.metrics.requiredHumanIntervention) {
			improvements.push("Improve prompt autonomy - reduce human dependency");
		}

		// Error category analysis
		if (lowSuccessPrompt.metrics.errorCategories?.length) {
			const errorTypes = lowSuccessPrompt.metrics.errorCategories;
			if (errorTypes.includes("ambiguous_requirements")) {
				improvements.push("Add more specific task requirements and constraints");
			}
			if (errorTypes.includes("poor_context")) {
				improvements.push("Improve contextual information and examples");
			}
			if (errorTypes.includes("wrong_approach")) {
				improvements.push("Consider few-shot examples of successful approaches");
			}
		}

		// Human satisfaction analysis
		if ((lowSuccessPrompt.metrics.humanSatisfactionScore || 0) < 3) {
			improvements.push("Focus on improving output quality and user experience");
		}

		// Add tags-based suggestions
		if (lowSuccessPrompt.tags.includes("complex")) {
			improvements.push("Break down complex tasks into smaller, more focused prompts");
		}

		// Basic prompt clarity and structure suggestions
		improvements.push("Clarify task objectives and context");
		improvements.push("Provide more specific examples or constraints");
		improvements.push("Use a step-by-step approach in the prompt");

		// A/B testing suggestion
		improvements.push("Create alternative prompt variants for comparison");

		return improvements;
	}

	/**
	 * Perform basic A/B testing of prompt improvements
	 * @param originalPrompt - The original low-success prompt
	 * @param improvedPrompts - Suggested improved prompt variants
	 * @returns A map of improved prompts with their initial performance metrics
	 */
	async testPromptImprovements(
		originalPrompt: PromptKnowledge,
		improvedPrompts: string[],
	): Promise<Map<string, { successCount: number; metrics: PromptKnowledge["metrics"] }>> {
		const resultsMap = new Map<string, { successCount: number; metrics: PromptKnowledge["metrics"] }>();

		for (const improvedPrompt of improvedPrompts) {
			// Simulate initial testing of the improved prompt
			// In a real implementation, this would involve actual task execution
			const simulatedMetrics: PromptKnowledge["metrics"] = {
				tokensUsed: Math.max(100, (originalPrompt.metrics.tokensUsed || 0) * 0.8),
				executionTimeMs: Math.max(100, (originalPrompt.metrics.executionTimeMs || 0) * 0.9),
				successRating: 4, // Hypothetical initial improvement
			};

			resultsMap.set(improvedPrompt, {
				successCount: 1, // Initial test
				metrics: simulatedMetrics,
			});
		}

		return resultsMap;
	}

	/**
	 * Load metrics from the JSONL file for comprehensive DSPy analysis
	 */
	private loadMetricsData(): Array<{
		questId: string;
		raidId: string;
		objective: string;
		success: boolean;
		durationMs: number;
		totalTokens: number;
		agentsSpawned: number;
		agentTypes: string[];
		startedAt: string;
		completedAt?: string;
		escalations?: number;
		escalationReasons?: string[];
	}> {
		const metricsPath = ".undercity/metrics.jsonl";
		if (!existsSync(metricsPath)) {
			return [];
		}

		try {
			const content = readFileSync(metricsPath, "utf-8");
			return content
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				})
				.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
		} catch {
			return [];
		}
	}

	/**
	 * Analyze bottleneck: is prompt quality or routing/model selection the issue?
	 * This is the core analysis for DSPy evaluation.
	 */
	private analyzeBottleneck(metrics: ReturnType<typeof this.loadMetricsData>): {
		bottleneck: "prompt_quality" | "routing" | "model_capability" | "unknown" | "none";
		evidence: string[];
		promptQualityScore: number;
		routingAccuracyScore: number;
	} {
		if (metrics.length === 0) {
			return {
				bottleneck: "unknown",
				evidence: ["No metrics data available for analysis"],
				promptQualityScore: 0,
				routingAccuracyScore: 0,
			};
		}

		const evidence: string[] = [];
		// Filter out entries without objective field (legacy or malformed entries)
		const validMetrics = metrics.filter((m) => m.objective && typeof m.objective === "string");
		const successfulTasks = validMetrics.filter((m) => m.success);
		const failedTasks = validMetrics.filter((m) => !m.success);
		const successRate = validMetrics.length > 0 ? successfulTasks.length / validMetrics.length : 0;

		// Analyze task patterns
		const taskCategories = new Map<string, { success: number; fail: number; totalTokens: number }>();
		for (const task of validMetrics) {
			// Extract category from objective (e.g., "[metrics]", "[learning]")
			const categoryMatch = task.objective.match(/^\[([^\]]+)\]/);
			const category = categoryMatch ? categoryMatch[1] : "general";

			const existing = taskCategories.get(category) || { success: 0, fail: 0, totalTokens: 0 };
			if (task.success) {
				existing.success++;
			} else {
				existing.fail++;
			}
			existing.totalTokens += task.totalTokens || 0;
			taskCategories.set(category, existing);
		}

		// Calculate variance in success rates across categories
		const categorySuccessRates: number[] = [];
		for (const [category, stats] of taskCategories) {
			const total = stats.success + stats.fail;
			if (total >= 2) {
				const rate = stats.success / total;
				categorySuccessRates.push(rate);
				if (rate < 0.5) {
					evidence.push(`Category "${category}" has low success rate (${(rate * 100).toFixed(0)}%)`);
				}
			}
		}

		// High variance in category success rates suggests prompt quality issues
		const avgCategoryRate =
			categorySuccessRates.length > 0
				? categorySuccessRates.reduce((a, b) => a + b, 0) / categorySuccessRates.length
				: 0;
		const categoryVariance =
			categorySuccessRates.length > 1
				? categorySuccessRates.reduce((sum, rate) => sum + (rate - avgCategoryRate) ** 2, 0) /
					categorySuccessRates.length
				: 0;

		// Analyze token efficiency (high tokens on failed tasks suggests prompt issues)
		const avgTokensSuccess =
			successfulTasks.length > 0
				? successfulTasks.reduce((sum, t) => sum + (t.totalTokens || 0), 0) / successfulTasks.length
				: 0;
		const avgTokensFailed =
			failedTasks.length > 0
				? failedTasks.reduce((sum, t) => sum + (t.totalTokens || 0), 0) / failedTasks.length
				: 0;

		// Check for escalation patterns (indicates routing issues)
		const tasksWithEscalation = metrics.filter((m) => (m.escalations || 0) > 0);
		const escalationRate = tasksWithEscalation.length / metrics.length;

		// Analyze agent type distribution for routing accuracy
		const agentTypeFailures = new Map<string, number>();
		for (const task of failedTasks) {
			for (const agentType of task.agentTypes || []) {
				agentTypeFailures.set(agentType, (agentTypeFailures.get(agentType) || 0) + 1);
			}
		}

		// Calculate scores
		let promptQualityScore = 100;
		let routingAccuracyScore = 100;

		// Reduce prompt quality score based on evidence
		if (categoryVariance > 0.1) {
			promptQualityScore -= 20;
			evidence.push(
				`High variance in category success rates (${(categoryVariance * 100).toFixed(1)}%) suggests inconsistent prompt quality`,
			);
		}

		if (avgTokensFailed > avgTokensSuccess * 1.5 && failedTasks.length > 0) {
			promptQualityScore -= 15;
			evidence.push(
				`Failed tasks use ${((avgTokensFailed / avgTokensSuccess - 1) * 100).toFixed(0)}% more tokens than successful ones`,
			);
		}

		// Reduce routing score based on escalation patterns
		if (escalationRate > 0.3) {
			routingAccuracyScore -= 30;
			evidence.push(`High escalation rate (${(escalationRate * 100).toFixed(1)}%) suggests routing issues`);
		} else if (escalationRate > 0.15) {
			routingAccuracyScore -= 15;
			evidence.push(`Moderate escalation rate (${(escalationRate * 100).toFixed(1)}%)`);
		}

		// Overall success rate impact
		if (successRate < 0.7) {
			promptQualityScore -= Math.floor((0.7 - successRate) * 50);
			evidence.push(`Overall success rate is ${(successRate * 100).toFixed(1)}%`);
		}

		// Determine the bottleneck
		let bottleneck: "prompt_quality" | "routing" | "model_capability" | "unknown" | "none";

		if (successRate > 0.9 && promptQualityScore > 80 && routingAccuracyScore > 80) {
			bottleneck = "none";
			evidence.push("System is performing well - no significant bottleneck identified");
		} else if (promptQualityScore < routingAccuracyScore - 20) {
			bottleneck = "prompt_quality";
			evidence.push("Prompt quality appears to be the primary bottleneck");
		} else if (routingAccuracyScore < promptQualityScore - 20) {
			bottleneck = "routing";
			evidence.push("Routing/model selection appears to be the primary bottleneck");
		} else if (promptQualityScore < 60 && routingAccuracyScore < 60) {
			bottleneck = "model_capability";
			evidence.push("Both prompt quality and routing need improvement");
		} else {
			bottleneck = "unknown";
			evidence.push("No clear bottleneck identified - mixed signals");
		}

		return {
			bottleneck,
			evidence,
			promptQualityScore,
			routingAccuracyScore,
		};
	}

	/**
	 * Assess readiness for DSPy integration by analyzing prompt performance patterns
	 * Integrates with actual metrics data from .undercity/metrics.jsonl
	 * @returns Analysis indicating whether DSPy would provide value
	 */
	assessDSPyReadiness(): {
		recommendDSPy: boolean;
		confidence: number;
		rationale: string[];
		criticalMetrics: {
			lowPerformingPrompts: number;
			humanInterventionRate: number;
			avgSatisfactionScore: number;
			errorPatternDiversity: number;
		};
		metricsAnalysis?: {
			totalTasks: number;
			successRate: number;
			avgTokensPerTask: number;
			avgDurationMs: number;
			bottleneck: string;
			promptQualityScore: number;
			routingAccuracyScore: number;
			categoryBreakdown: Array<{ category: string; successRate: number; count: number }>;
		};
	} {
		// First, load and analyze actual metrics data
		const metricsData = this.loadMetricsData();
		const bottleneckAnalysis = this.analyzeBottleneck(metricsData);

		// Then, check knowledge tracker data
		const storage = this.loadStorage();
		const allKnowledge = storage.knowledge;

		// Build metrics analysis from actual data
		const metricsAnalysis =
			metricsData.length > 0
				? {
						totalTasks: metricsData.length,
						successRate: metricsData.filter((m) => m.success).length / metricsData.length,
						avgTokensPerTask:
							metricsData.reduce((sum, m) => sum + (m.totalTokens || 0), 0) / metricsData.length,
						avgDurationMs: metricsData.reduce((sum, m) => sum + (m.durationMs || 0), 0) / metricsData.length,
						bottleneck: bottleneckAnalysis.bottleneck,
						promptQualityScore: bottleneckAnalysis.promptQualityScore,
						routingAccuracyScore: bottleneckAnalysis.routingAccuracyScore,
						categoryBreakdown: this.buildCategoryBreakdown(metricsData),
					}
				: undefined;

		// Calculate legacy metrics from knowledge storage (for backward compatibility)
		const lowPerformingPrompts = allKnowledge.filter(
			(k) => (k.successCount || 0) <= 2 || (k.metrics.successRating || 0) < 3,
		).length;

		const promptsWithInterventionData = allKnowledge.filter(
			(k) => k.metrics.requiredHumanIntervention !== undefined,
		);
		const humanInterventionRate =
			promptsWithInterventionData.length > 0
				? promptsWithInterventionData.filter((k) => k.metrics.requiredHumanIntervention).length /
					promptsWithInterventionData.length
				: 0;

		const promptsWithSatisfactionData = allKnowledge.filter((k) => k.metrics.humanSatisfactionScore !== undefined);
		const avgSatisfactionScore =
			promptsWithSatisfactionData.length > 0
				? promptsWithSatisfactionData.reduce((sum, k) => sum + (k.metrics.humanSatisfactionScore || 0), 0) /
					promptsWithSatisfactionData.length
				: 0;

		const allErrorCategories = new Set<string>();
		allKnowledge.forEach((k) => {
			k.metrics.errorCategories?.forEach((cat) => allErrorCategories.add(cat));
		});
		const errorPatternDiversity = allErrorCategories.size;

		const legacyMetrics = {
			lowPerformingPrompts,
			humanInterventionRate,
			avgSatisfactionScore,
			errorPatternDiversity,
		};

		// Decision logic combining both data sources
		const rationale: string[] = [];
		let score = 0;

		// Primary decision: Use metrics data if available (more reliable)
		if (metricsData.length >= 10) {
			rationale.push(`Analyzing ${metricsData.length} tasks from metrics.jsonl`);

			// Check if prompt quality is the bottleneck
			if (bottleneckAnalysis.bottleneck === "prompt_quality") {
				score += 4;
				rationale.push("Bottleneck Analysis: Prompt quality identified as primary issue");
				rationale.push(
					`Prompt Quality Score: ${bottleneckAnalysis.promptQualityScore}/100 (DSPy could help optimize)`,
				);
			} else if (bottleneckAnalysis.bottleneck === "routing") {
				score += 1;
				rationale.push("Bottleneck Analysis: Routing/model selection is the primary issue");
				rationale.push("Focus on improving task routing before considering DSPy");
			} else if (bottleneckAnalysis.bottleneck === "none") {
				rationale.push("Bottleneck Analysis: System performing well - no significant issues");
				rationale.push("DSPy would provide marginal improvement at best");
			}

			// Add evidence from bottleneck analysis
			bottleneckAnalysis.evidence.forEach((e) => rationale.push(e));

			// Success rate analysis
			if (metricsAnalysis && metricsAnalysis.successRate < 0.7) {
				score += 2;
				rationale.push(
					`Low overall success rate (${(metricsAnalysis.successRate * 100).toFixed(1)}%) indicates optimization opportunity`,
				);
			} else if (metricsAnalysis && metricsAnalysis.successRate > 0.9) {
				rationale.push(
					`High success rate (${(metricsAnalysis.successRate * 100).toFixed(1)}%) - current prompts are effective`,
				);
			}

			// Calculate confidence based on data volume
			const dataConfidence = Math.min(1, metricsData.length / 50);

			// Final recommendation
			const recommendDSPy = score >= 4 && bottleneckAnalysis.bottleneck === "prompt_quality";

			if (!recommendDSPy) {
				if (bottleneckAnalysis.bottleneck !== "prompt_quality") {
					rationale.push(
						"DSPy NOT RECOMMENDED: Prompt quality is not the bottleneck. Focus on improving " +
							(bottleneckAnalysis.bottleneck === "routing"
								? "task routing and model selection"
								: "overall system architecture"),
					);
				} else if (score < 4) {
					rationale.push("DSPy NOT RECOMMENDED: Insufficient evidence of prompt quality issues");
				}
			} else {
				rationale.push("DSPy RECOMMENDED: Prompt quality is the bottleneck and could benefit from optimization");
				rationale.push(
					"Suggested approach: Use DSPy for few-shot learning on underperforming task categories",
				);
			}

			return {
				recommendDSPy,
				confidence: dataConfidence,
				rationale,
				criticalMetrics: legacyMetrics,
				metricsAnalysis,
			};
		}

		// Fallback to legacy knowledge-based analysis if no metrics data
		if (allKnowledge.length < 10 && metricsData.length < 10) {
			return {
				recommendDSPy: false,
				confidence: 0.1,
				rationale: [
					"Insufficient data: Need at least 10 task records for meaningful analysis",
					`Currently have ${metricsData.length} metrics entries and ${allKnowledge.length} knowledge entries`,
					"Continue running tasks to collect more data before evaluating DSPy",
				],
				criticalMetrics: legacyMetrics,
				metricsAnalysis,
			};
		}

		// Legacy analysis if we only have knowledge data
		const lowPerfRatio = allKnowledge.length > 0 ? lowPerformingPrompts / allKnowledge.length : 0;
		if (lowPerfRatio > 0.3) {
			score += 3;
			rationale.push(`High proportion of low-performing prompts (${(lowPerfRatio * 100).toFixed(1)}%)`);
		} else if (lowPerfRatio > 0.15) {
			score += 1;
			rationale.push(`Moderate proportion of low-performing prompts (${(lowPerfRatio * 100).toFixed(1)}%)`);
		} else {
			rationale.push(
				`Low proportion of underperforming prompts (${(lowPerfRatio * 100).toFixed(1)}%) - existing system effective`,
			);
		}

		if (humanInterventionRate > 0.4) {
			score += 3;
			rationale.push(`High human intervention rate (${(humanInterventionRate * 100).toFixed(1)}%)`);
		} else if (humanInterventionRate > 0.2) {
			score += 1;
			rationale.push(`Moderate human intervention rate (${(humanInterventionRate * 100).toFixed(1)}%)`);
		}

		const dataCompleteness = Math.min(
			promptsWithInterventionData.length > 0 ? promptsWithInterventionData.length / allKnowledge.length : 0,
			promptsWithSatisfactionData.length > 0 ? promptsWithSatisfactionData.length / allKnowledge.length : 0,
			allKnowledge.length / 100,
		);

		const confidence = Math.max(0.1, dataCompleteness);
		const recommendDSPy = score >= 5 && confidence > 0.7;

		if (!recommendDSPy) {
			rationale.push(
				"DSPy NOT RECOMMENDED based on current data - continue collecting metrics for better assessment",
			);
		}

		return {
			recommendDSPy,
			confidence,
			rationale,
			criticalMetrics: legacyMetrics,
			metricsAnalysis,
		};
	}

	/**
	 * Build category breakdown from metrics data
	 */
	private buildCategoryBreakdown(
		metrics: ReturnType<typeof this.loadMetricsData>,
	): Array<{ category: string; successRate: number; count: number }> {
		const categoryStats = new Map<string, { success: number; total: number }>();

		// Filter to only entries with valid objective field
		const validMetrics = metrics.filter((m) => m.objective && typeof m.objective === "string");

		for (const task of validMetrics) {
			const categoryMatch = task.objective.match(/^\[([^\]]+)\]/);
			const category = categoryMatch ? categoryMatch[1] : "general";

			const existing = categoryStats.get(category) || { success: 0, total: 0 };
			existing.total++;
			if (task.success) {
				existing.success++;
			}
			categoryStats.set(category, existing);
		}

		return Array.from(categoryStats.entries())
			.map(([category, stats]) => ({
				category,
				successRate: stats.total > 0 ? stats.success / stats.total : 0,
				count: stats.total,
			}))
			.sort((a, b) => b.count - a.count);
	}
}
