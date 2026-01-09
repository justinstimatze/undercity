/**
 * Example Experiment Definitions
 *
 * Pre-built experiment templates for common hypotheses
 */

import { ExperimentFramework } from "./framework.js";
import { ExperimentVariant } from "./types.js";

/**
 * Create common experiment templates
 */
export class ExperimentTemplates {
  constructor(private framework: ExperimentFramework) {}

  /**
   * Test if using Opus for all agents improves quality vs mixed models
   */
  createOpusVsMixedExperiment(): string {
    const variants: Omit<ExperimentVariant, "id">[] = [
      {
        name: "Mixed Models (Control)",
        description: "Standard loadout: Haiku for Flute, Sonnet for others, Opus for Sheriff",
        weight: 0.5,
        isControl: true,
        parameters: {
          modelChoices: {
            flute: "haiku",
            logistics: "sonnet",
            quester: "sonnet",
            sheriff: "opus",
          },
        },
      },
      {
        name: "All Opus",
        description: "Use Opus for all agent types for maximum quality",
        weight: 0.5,
        parameters: {
          modelChoices: {
            flute: "opus",
            logistics: "opus",
            quester: "opus",
            sheriff: "opus",
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
      }
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
          squadComposition: ["flute", "logistics", "quester", "sheriff"],
          maxSquadSize: 4,
        },
      },
      {
        name: "Lean Squad",
        description: "Skip Flute recon, go straight to Logistics + Quester",
        weight: 0.33,
        parameters: {
          squadComposition: ["logistics", "quester", "sheriff"],
          maxSquadSize: 3,
        },
      },
      {
        name: "Speed Squad",
        description: "Skip Sheriff review for faster iteration",
        weight: 0.34,
        parameters: {
          squadComposition: ["flute", "logistics", "quester"],
          maxSquadSize: 3,
        },
      },
    ];

    const experiment = this.framework.createExperiment(
      "Squad Composition Test",
      "Test different squad compositions to find the optimal balance of speed vs quality",
      "Lean squad (no Flute) will be 25% faster with <10% quality reduction",
      variants,
      {
        targetSampleSize: 75,
        minimumDetectableEffect: 0.2,
        tags: ["squad-composition", "speed", "efficiency"],
      }
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
      }
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
      }
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
      }
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
            flute: "haiku",
            logistics: "sonnet",
            quester: "sonnet",
            sheriff: "opus",
          },
          squadComposition: ["flute", "logistics", "quester", "sheriff"],
          maxSquadSize: 4,
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
            flute: "haiku",
            logistics: "sonnet",
            quester: "sonnet",
            sheriff: "sonnet",
          },
          squadComposition: ["logistics", "quester"],
          maxSquadSize: 2,
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
            flute: "sonnet",
            logistics: "opus",
            quester: "opus",
            sheriff: "opus",
          },
          squadComposition: ["flute", "logistics", "quester", "sheriff"],
          maxSquadSize: 4,
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
      }
    );

    return experiment.id;
  }
}