/**
 * Example Experiment Definitions
 *
 * Pre-built experiment templates for common hypotheses
 */

import type { ExperimentFramework } from "./framework.js";
import type { ExperimentVariant } from "./types.js";

/**
 * Create common experiment templates
 */
export class ExperimentTemplates {
	constructor(private framework: ExperimentFramework) {}

	/**
	 * A/B test different routing strategies for task assignment
	 */
	createTaskRoutingExperiment(): string {
		const variants: Omit<ExperimentVariant, "id">[] = [
			{
				name: "Random Routing (Control)",
				description: "Randomly assign tasks to available agents",
				weight: 0.33,
				isControl: true,
				parameters: {
					customParameters: {
						routingStrategy: "random",
					},
				},
			},
			{
				name: "Skill-Based Routing",
				description: "Route tasks based on agent's historical performance",
				weight: 0.33,
				parameters: {
					customParameters: {
						routingStrategy: "skill-based",
					},
				},
			},
			{
				name: "Load-Balanced Routing",
				description: "Route tasks to least busy agents",
				weight: 0.34,
				parameters: {
					customParameters: {
						routingStrategy: "load-balanced",
					},
				},
			},
		];

		const experiment = this.framework.createExperiment(
			"Task Routing Strategy Experiment",
			"Evaluate different task routing strategies for efficiency and success rate",
			"Skill-based routing will improve success rate by >15% compared to random routing",
			variants,
			{
				targetSampleSize: 100,
				minimumDetectableEffect: 0.15,
				tags: ["routing", "task-assignment", "efficiency"],
			},
		);

		return experiment.id;
	}

	/**
	 * A/B test dynamic vs static agent pool routing
	 */
	createDynamicPoolRoutingExperiment(): string {
		const variants: Omit<ExperimentVariant, "id">[] = [
			{
				name: "Static Agent Pool (Control)",
				description: "Fixed agent pool with predefined composition",
				weight: 0.5,
				isControl: true,
				parameters: {
					customParameters: {
						poolType: "static",
						poolSize: 4,
					},
				},
			},
			{
				name: "Dynamic Agent Pool",
				description: "Dynamically adjust agent pool based on task complexity",
				weight: 0.5,
				parameters: {
					customParameters: {
						poolType: "dynamic",
						maxPoolSize: 6,
						minPoolSize: 2,
					},
				},
			},
		];

		const experiment = this.framework.createExperiment(
			"Dynamic vs Static Agent Pool Routing",
			"Test whether dynamically adjusting the agent pool improves overall system efficiency",
			"Dynamic pool will reduce task completion time by >20% with minimal increase in complexity",
			variants,
			{
				targetSampleSize: 75,
				minimumDetectableEffect: 0.2,
				tags: ["routing", "agent-pool", "scalability"],
			},
		);

		return experiment.id;
	}

	/**
	 * Test if using Opus for all agents improves quality vs mixed models
	 */
	createOpusVsMixedExperiment(): string {
		const variants: Omit<ExperimentVariant, "id">[] = [
			{
				name: "Mixed Models (Control)",
				description: "Standard loadout: Haiku for Scout, Sonnet for others, Opus for Reviewer",
				weight: 0.5,
				isControl: true,
				parameters: {
					modelChoices: {
						scout: "haiku",
						planner: "sonnet",
						builder: "sonnet",
						reviewer: "opus",
					},
				},
			},
			{
				name: "All Opus",
				description: "Use Opus for all agent types for maximum quality",
				weight: 0.5,
				parameters: {
					modelChoices: {
						scout: "opus",
						planner: "opus",
						builder: "opus",
						reviewer: "opus",
					},
				},
			},
		];

		const experiment = this.framework.createExperiment(
			"Opus vs Mixed Models",
			"Test whether using Opus for all agents improves success rate and reduces rework despite higher token cost",
			"Using Opus for all agents will improve success rate by >15% and reduce rework by >20%",
			variants,
			{
				targetSampleSize: 50,
				minimumDetectableEffect: 0.15,
				tags: ["model-choice", "quality", "cost"],
			},
		);

		return experiment.id;
	}

	/**
	 * Test different squad compositions
	 */
	createSquadCompositionExperiment(): string {
		const variants: Omit<ExperimentVariant, "id">[] = [
			{
				name: "Standard Squad (Control)",
				description: "All agent types enabled with max squad size 4",
				weight: 0.33,
				isControl: true,
				parameters: {
					agentsComposition: ["scout", "planner", "builder", "reviewer"],
					maxAgents: 4,
				},
			},
			{
				name: "Lean Squad",
				description: "Skip Scout recon, go straight to Planner + Builder",
				weight: 0.33,
				parameters: {
					agentsComposition: ["planner", "builder", "reviewer"],
					maxAgents: 3,
				},
			},
			{
				name: "Speed Squad",
				description: "Skip Reviewer review for faster iteration",
				weight: 0.34,
				parameters: {
					agentsComposition: ["scout", "planner", "builder"],
					maxAgents: 3,
				},
			},
		];

		const experiment = this.framework.createExperiment(
			"Squad Composition Test",
			"Test different squad compositions to find the optimal balance of speed vs quality",
			"Lean squad (no Scout) will be 25% faster with <10% quality reduction",
			variants,
			{
				targetSampleSize: 75,
				minimumDetectableEffect: 0.2,
				tags: ["squad-composition", "speed", "efficiency"],
			},
		);

		return experiment.id;
	}

	/**
	 * Test parallelism levels
	 */
	createParallelismExperiment(): string {
		const variants: Omit<ExperimentVariant, "id">[] = [
			{
				name: "Sequential (Control)",
				description: "One agent at a time for maximum safety",
				weight: 0.33,
				isControl: true,
				parameters: {
					parallelismLevel: "sequential",
				},
			},
			{
				name: "Limited Parallel",
				description: "Limited parallelism with conflict detection",
				weight: 0.33,
				parameters: {
					parallelismLevel: "limited",
				},
			},
			{
				name: "Maximum Parallel",
				description: "All agents work in parallel with merge resolution",
				weight: 0.34,
				parameters: {
					parallelismLevel: "maximum",
				},
			},
		];

		const experiment = this.framework.createExperiment(
			"Parallelism Level Test",
			"Test different levels of agent parallelism to optimize speed vs merge conflicts",
			"Limited parallelism will be 40% faster than sequential with <5% increase in failures",
			variants,
			{
				targetSampleSize: 60,
				minimumDetectableEffect: 0.3,
				tags: ["parallelism", "speed", "conflicts"],
			},
		);

		return experiment.id;
	}

	/**
	 * Test context size impact
	 */
	createContextSizeExperiment(): string {
		const variants: Omit<ExperimentVariant, "id">[] = [
			{
				name: "Medium Context (Control)",
				description: "Standard medium context size",
				weight: 0.33,
				isControl: true,
				parameters: {
					contextSize: "medium",
				},
			},
			{
				name: "Large Context",
				description: "Larger context for better understanding",
				weight: 0.33,
				parameters: {
					contextSize: "large",
				},
			},
			{
				name: "Small Context",
				description: "Smaller context for speed and cost efficiency",
				weight: 0.34,
				parameters: {
					contextSize: "small",
				},
			},
		];

		const experiment = this.framework.createExperiment(
			"Context Size Optimization",
			"Test optimal context size for balancing understanding vs token usage",
			"Large context will improve success rate by >10% but increase token usage by <30%",
			variants,
			{
				targetSampleSize: 80,
				minimumDetectableEffect: 0.1,
				tags: ["context-size", "understanding", "cost"],
			},
		);

		return experiment.id;
	}

	/**
	 * Test auto-approval vs human review
	 */
	createAutoApprovalExperiment(): string {
		const variants: Omit<ExperimentVariant, "id">[] = [
			{
				name: "Human Approval (Control)",
				description: "Require human approval for all plans",
				weight: 0.5,
				isControl: true,
				parameters: {
					autoApprove: false,
				},
			},
			{
				name: "Auto Approval",
				description: "Automatically approve and execute plans",
				weight: 0.5,
				parameters: {
					autoApprove: true,
				},
			},
		];

		const experiment = this.framework.createExperiment(
			"Auto Approval Test",
			"Test impact of skipping human plan approval on speed and quality",
			"Auto approval will be 60% faster with <15% reduction in success rate",
			variants,
			{
				targetSampleSize: 40,
				minimumDetectableEffect: 0.5,
				tags: ["automation", "speed", "human-oversight"],
			},
		);

		return experiment.id;
	}

	/**
	 * Create a comprehensive A/B test with multiple parameters
	 */
	createComprehensiveExperiment(): string {
		const variants: Omit<ExperimentVariant, "id">[] = [
			{
				name: "Current Best Practices",
				description: "Current optimal configuration based on experience",
				weight: 0.4,
				isControl: true,
				parameters: {
					modelChoices: {
						scout: "haiku",
						planner: "sonnet",
						builder: "sonnet",
						reviewer: "opus",
					},
					agentsComposition: ["scout", "planner", "builder", "reviewer"],
					maxAgents: 4,
					contextSize: "medium",
					parallelismLevel: "limited",
					autoApprove: false,
				},
			},
			{
				name: "Speed Optimized",
				description: "Configuration optimized for maximum speed",
				weight: 0.3,
				parameters: {
					modelChoices: {
						scout: "haiku",
						planner: "sonnet",
						builder: "sonnet",
						reviewer: "sonnet",
					},
					agentsComposition: ["planner", "builder"],
					maxAgents: 2,
					contextSize: "small",
					parallelismLevel: "maximum",
					autoApprove: true,
				},
			},
			{
				name: "Quality Maximized",
				description: "Configuration optimized for maximum quality",
				weight: 0.3,
				parameters: {
					modelChoices: {
						scout: "sonnet",
						planner: "opus",
						builder: "opus",
						reviewer: "opus",
					},
					agentsComposition: ["scout", "planner", "builder", "reviewer"],
					maxAgents: 4,
					contextSize: "large",
					parallelismLevel: "sequential",
					autoApprove: false,
				},
			},
		];

		const experiment = this.framework.createExperiment(
			"Speed vs Quality Optimization",
			"Comprehensive test of speed-optimized vs quality-optimized configurations",
			"Speed configuration will be 3x faster but quality configuration will have 20% better success rate",
			variants,
			{
				targetSampleSize: 100,
				minimumDetectableEffect: 0.2,
				tags: ["comprehensive", "speed", "quality", "optimization"],
			},
		);

		return experiment.id;
	}

	/**
	 * Test linear vs swarm execution modes for efficiency tracking
	 */
	createLinearVsSwarmEfficiencyExperiment(): string {
		const variants: Omit<ExperimentVariant, "id">[] = [
			{
				name: "Linear Mode (Control)",
				description: "Sequential execution: scout→planner→fabricator→sheriff",
				weight: 0.5,
				isControl: true,
				parameters: {
					parallelismLevel: "sequential",
					maxAgents: 4,
					agentsComposition: ["scout", "planner", "builder", "reviewer"],
					modelChoices: {
						scout: "haiku",
						planner: "sonnet",
						builder: "sonnet",
						reviewer: "sonnet",
					},
					contextSize: "medium",
				},
			},
			{
				name: "Swarm Mode",
				description: "Parallel execution with maximum concurrency",
				weight: 0.5,
				parameters: {
					parallelismLevel: "maximum",
					maxAgents: 5,
					agentsComposition: ["scout", "planner", "builder", "reviewer"],
					modelChoices: {
						scout: "haiku",
						planner: "sonnet",
						builder: "sonnet",
						reviewer: "sonnet",
					},
					contextSize: "medium",
				},
			},
		];

		const experiment = this.framework.createExperiment(
			"Linear vs Swarm Efficiency Analysis",
			"Compare first-order (initial tokens) vs second-order (total tokens including rework) efficiency between linear and swarm execution modes",
			"Swarm mode will reduce time-to-completion by 40% but increase total tokens by 20% due to coordination overhead and rework",
			variants,
			{
				targetSampleSize: 60,
				minimumDetectableEffect: 0.2,
				tags: ["efficiency", "parallelism", "tokens", "coordination", "rework"],
			},
		);

		return experiment.id;
	}

	/**
	 * Test aggressive swarm vs conservative sequential for high-complexity tasks
	 */
	createComplexityModeExperiment(): string {
		const variants: Omit<ExperimentVariant, "id">[] = [
			{
				name: "Conservative Sequential (Control)",
				description: "High-quality sequential execution for complex tasks",
				weight: 0.4,
				isControl: true,
				parameters: {
					parallelismLevel: "sequential",
					maxAgents: 4,
					agentsComposition: ["scout", "planner", "builder", "reviewer"],
					modelChoices: {
						scout: "sonnet", // Upgraded for complexity
						planner: "opus", // Upgraded for planning
						builder: "sonnet",
						reviewer: "opus", // Upgraded for review
					},
					contextSize: "large",
					autoApprove: false, // Human oversight for complex tasks
				},
			},
			{
				name: "Aggressive Swarm",
				description: "Fast parallel execution with risk of higher rework",
				weight: 0.3,
				parameters: {
					parallelismLevel: "maximum",
					maxAgents: 5,
					agentsComposition: ["scout", "planner", "builder", "reviewer"],
					modelChoices: {
						scout: "haiku", // Fast recon
						planner: "sonnet",
						builder: "sonnet",
						reviewer: "sonnet", // Faster review
					},
					contextSize: "medium",
					autoApprove: true, // No human bottleneck
				},
			},
			{
				name: "Hybrid Approach",
				description: "Sequential planning, parallel execution",
				weight: 0.3,
				parameters: {
					parallelismLevel: "limited", // Controlled parallelism
					maxAgents: 4,
					agentsComposition: ["scout", "planner", "builder", "reviewer"],
					modelChoices: {
						scout: "haiku",
						planner: "opus", // Strong planning
						builder: "sonnet",
						reviewer: "sonnet",
					},
					contextSize: "medium",
					autoApprove: false,
				},
			},
		];

		const experiment = this.framework.createExperiment(
			"Complexity Handling Strategies",
			"Test different approaches to handling complex tasks: conservative sequential vs aggressive parallel vs hybrid",
			"Conservative approach will have highest success rate but longest time, aggressive will be fastest but highest rework, hybrid will balance both",
			variants,
			{
				targetSampleSize: 90,
				minimumDetectableEffect: 0.15,
				tags: ["complexity", "strategy", "risk-reward", "optimization"],
			},
		);

		return experiment.id;
	}
}
