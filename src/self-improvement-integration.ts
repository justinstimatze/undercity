/**
 * Self-Improvement System Integration Example
 *
 * Demonstrates how to integrate the self-improvement loop
 * with quest execution and metric collection.
 */

import type { EfficiencyTracker } from "./efficiency-tracker.js";
import { getImprovementPersistence } from "./improvement-persistence.js";
import { raidLogger } from "./logger.js";
import { MetricsTracker } from "./metrics.js";
import type { ExperimentConfig } from "./self-improvement.js";
import { selfImprovementAgent } from "./self-improvement.js";
import type { AgentType, LoadoutModelChoices, ParallelismLevel, QuestMetrics } from "./types.js";

/**
 * Example integration showing how to collect metrics during quest execution
 */
export class SelfImprovingQuestRunner {
	private metricsTracker: MetricsTracker;
	private improvementPersistence = getImprovementPersistence();

	constructor() {
		this.metricsTracker = new MetricsTracker();
	}

	/**
	 * Execute a quest with comprehensive metrics collection
	 */
	async executeQuest(
		questId: string,
		objective: string,
		raidId: string,
		options: {
			parallelismLevel: ParallelismLevel;
			modelChoices: LoadoutModelChoices;
			experimentId?: string;
		},
	): Promise<{
		success: boolean;
		metrics: QuestMetrics | null;
		efficiencyTrackerResults?: any;
	}> {
		// Start metrics tracking
		this.metricsTracker.startQuest(questId, objective, raidId);

		// Create efficiency tracker for A/B testing
		let efficiencyTracker: EfficiencyTracker | null = null;
		let variantName: string | undefined;

		if (options.experimentId) {
			// Assign experiment variant
			const variant = selfImprovementAgent.assignExperimentVariant(options.experimentId);
			if (variant) {
				variantName = variant.variantName;
				// Use variant configuration
				options.parallelismLevel = variant.config.parallelismLevel;
				options.modelChoices = variant.config.modelChoices;

				efficiencyTracker = selfImprovementAgent.createEfficiencyTracker(
					questId,
					raidId,
					objective,
					options.parallelismLevel,
					options.modelChoices,
					options.experimentId,
					variantName,
				);
			}
		} else {
			// Regular efficiency tracking
			efficiencyTracker = selfImprovementAgent.createEfficiencyTracker(
				questId,
				raidId,
				objective,
				options.parallelismLevel,
				options.modelChoices,
			);
		}

		let success = false;
		let error: string | undefined;

		try {
			// Simulate quest execution with different agents
			const agentTypes: AgentType[] = this.determineAgentTypes(options.parallelismLevel);

			for (const agentType of agentTypes) {
				// Record agent spawn
				this.metricsTracker.recordAgentSpawn(agentType);
				efficiencyTracker?.recordAgentActivity(agentType);

				// Simulate agent work and token usage
				const mockTokenUsage = this.simulateAgentWork(agentType);
				efficiencyTracker?.recordTokenUsage(mockTokenUsage, agentType);

				// Record token usage in metrics tracker
				this.metricsTracker.recordTokenUsage(
					{
						inputTokens: mockTokenUsage * 0.7,
						outputTokens: mockTokenUsage * 0.3,
						totalTokens: mockTokenUsage,
						sonnetEquivalentTokens: mockTokenUsage,
					},
					this.getModelForAgent(agentType, options.modelChoices),
				);
			}

			// Record first attempt completion
			const firstAttemptSuccess = Math.random() > 0.3; // 70% success rate
			efficiencyTracker?.recordFirstAttemptCompletion(firstAttemptSuccess);

			if (!firstAttemptSuccess) {
				// Simulate rework
				const reworkTokens = Math.floor(Math.random() * 1000) + 500;
				efficiencyTracker?.recordReworkAttempt("Tests failed, fixing implementation", "quester", reworkTokens, true);
			}

			// Record final completion
			success = true;
			efficiencyTracker?.recordStableCompletion(success);

			raidLogger.info(
				{
					questId,
					objective: objective.slice(0, 50),
					success,
					parallelismLevel: options.parallelismLevel,
					variantName,
				},
				"Quest completed with metrics collection",
			);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			this.metricsTracker.recordQuestFailure(error);
			efficiencyTracker?.recordStableCompletion(false);

			raidLogger.error(
				{
					questId,
					error,
				},
				"Quest failed",
			);
		}

		// Complete metrics tracking
		const metrics = this.metricsTracker.completeQuest(success);

		// Persist metrics and efficiency outcomes
		if (metrics) {
			this.improvementPersistence.addQuestMetrics(metrics);
			selfImprovementAgent.collectQuestMetrics(metrics);
		}

		if (efficiencyTracker) {
			const efficiencyOutcome = efficiencyTracker.generateOutcome();
			this.improvementPersistence.addEfficiencyOutcome(efficiencyOutcome);
			selfImprovementAgent.collectEfficiencyOutcome(efficiencyOutcome);
		}

		return {
			success,
			metrics,
			efficiencyTrackerResults: efficiencyTracker?.getStatus(),
		};
	}

	/**
	 * Start an A/B experiment
	 */
	startExperiment(experimentConfig: ExperimentConfig): void {
		selfImprovementAgent.startExperiment(experimentConfig);
		this.improvementPersistence.saveActiveExperiment(experimentConfig);

		raidLogger.info(
			{
				experimentId: experimentConfig.id,
				hypothesis: experimentConfig.hypothesis,
				variants: experimentConfig.variants.length,
			},
			"Started A/B experiment",
		);
	}

	/**
	 * Generate and return improvement quests
	 */
	generateImprovementQuests(): any[] {
		const quests = selfImprovementAgent.generateImprovementQuests();

		// Persist new improvement quests
		for (const quest of quests) {
			this.improvementPersistence.addImprovementQuest(quest);
		}

		raidLogger.info({ questCount: quests.length }, "Generated improvement quests from empirical data");

		return quests;
	}

	/**
	 * Get comprehensive metrics report
	 */
	getMetricsReport() {
		return selfImprovementAgent.generateMetricsReport();
	}

	/**
	 * Determine which agent types to use based on parallelism level
	 */
	private determineAgentTypes(parallelismLevel: ParallelismLevel): AgentType[] {
		switch (parallelismLevel) {
			case "sequential":
				return ["logistics", "quester", "sheriff"];
			case "limited":
				return ["flute", "quester", "sheriff"];
			case "maximum":
				return ["flute", "logistics", "quester", "sheriff"];
			default:
				return ["quester"];
		}
	}

	/**
	 * Simulate agent work and return token usage
	 */
	private simulateAgentWork(agentType: AgentType): number {
		// Different agents use different amounts of tokens
		const baseTokens = {
			flute: 500,
			logistics: 1500,
			quester: 3000,
			sheriff: 800,
		};

		// Add some randomness
		const variance = Math.random() * 0.5 + 0.75; // 75% to 125%
		return Math.floor(baseTokens[agentType] * variance);
	}

	/**
	 * Get model for a specific agent type
	 */
	private getModelForAgent(agentType: AgentType, modelChoices: LoadoutModelChoices): "haiku" | "sonnet" | "opus" {
		return modelChoices[agentType];
	}
}

/**
 * Example usage and demonstration
 */
export async function demonstrateSelfImprovement(): Promise<void> {
	const questRunner = new SelfImprovingQuestRunner();

	// Example: Start an A/B experiment
	const experiment: ExperimentConfig = {
		id: "parallel-vs-sequential-2024",
		hypothesis: "Parallel execution reduces completion time without significantly impacting quality",
		variants: [
			{
				name: "sequential",
				description: "Sequential agent execution",
				parallelismLevel: "sequential",
				modelChoices: {
					flute: "haiku",
					logistics: "sonnet",
					quester: "sonnet",
					sheriff: "opus",
				},
				weight: 0.5,
			},
			{
				name: "parallel",
				description: "Maximum parallel agent execution",
				parallelismLevel: "maximum",
				modelChoices: {
					flute: "haiku",
					logistics: "sonnet",
					quester: "sonnet",
					sheriff: "opus",
				},
				weight: 0.5,
			},
		],
		targetSampleSize: 50,
		maxDurationDays: 30,
		successMetrics: ["completion_time", "success_rate", "token_efficiency"],
	};

	questRunner.startExperiment(experiment);

	// Execute some quests with the experiment
	const questsToRun = [
		"Add input validation to user registration form",
		"Implement dark mode toggle functionality",
		"Fix memory leak in data processing pipeline",
		"Add unit tests for authentication module",
		"Optimize database query performance",
	];

	console.log("🧪 Running experiment quests...");

	for (let i = 0; i < questsToRun.length; i++) {
		const questId = `demo-quest-${i + 1}`;
		const objective = questsToRun[i];
		const raidId = "demo-raid";

		const result = await questRunner.executeQuest(questId, objective, raidId, {
			parallelismLevel: "sequential", // Will be overridden by experiment
			modelChoices: {
				flute: "haiku",
				logistics: "sonnet",
				quester: "sonnet",
				sheriff: "opus",
			},
			experimentId: experiment.id,
		});

		console.log(`  ✓ Quest ${i + 1}: ${result.success ? "SUCCESS" : "FAILED"}`);
	}

	// Generate improvement quests based on data
	console.log("\n🎯 Generating improvement quests...");
	const improvementQuests = questRunner.generateImprovementQuests();

	if (improvementQuests.length > 0) {
		console.log(`Generated ${improvementQuests.length} improvement quests:`);
		improvementQuests.slice(0, 3).forEach((quest, i) => {
			console.log(`  ${i + 1}. [${quest.priority.toUpperCase()}] ${quest.title}`);
			console.log(`     ${quest.description.slice(0, 80)}...`);
		});
	}

	// Show metrics report
	console.log("\n📊 Metrics Summary:");
	const report = questRunner.getMetricsReport();
	console.log(`  Total quests: ${report.summary.totalQuestMetrics}`);
	console.log(`  Success rate: ${report.performance.successRate.toFixed(1)}%`);
	console.log(`  Avg completion time: ${Math.round(report.performance.avgCompletionTime / 60000)}m`);
	console.log(`  Active experiments: ${report.summary.activeExperiments}`);

	if (report.recommendations.length > 0) {
		console.log("\n🔧 Top Recommendations:");
		report.recommendations.slice(0, 2).forEach((rec) => {
			console.log(`  • [${rec.priority.toUpperCase()}] ${rec.title}`);
		});
	}
}
