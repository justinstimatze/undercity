/**
 * Quest-Experiment Integration
 *
 * Integrates the experimentation framework with the quest execution system
 * to automatically assign quests to experiments and track outcomes.
 */

import { Quest } from "../quest.js";
import { LoadoutConfiguration } from "../types.js";
import { ExperimentFramework } from "./framework.js";
import { VariantParameters } from "./types.js";

export class QuestExperimentIntegrator {
  constructor(private experimentFramework: ExperimentFramework) {}

  /**
   * Get experiment assignments for a quest and apply parameter overrides
   */
  async processQuestForExperiments(
    quest: Quest,
    baseLoadout: LoadoutConfiguration
  ): Promise<{
    loadout: LoadoutConfiguration;
    assignments: Array<{ experimentId: string; variantId: string }>;
  }> {
    const activeExperiments = this.experimentFramework.getActiveExperiments();
    const assignments: Array<{ experimentId: string; variantId: string }> = [];
    let modifiedLoadout = { ...baseLoadout };

    // Process each active experiment
    for (const experiment of activeExperiments) {
      const assignment = this.experimentFramework.assignQuestToVariant(
        quest.id,
        experiment.id
      );

      if (assignment) {
        assignments.push({
          experimentId: experiment.id,
          variantId: assignment.variantId,
        });

        // Apply variant parameters to the loadout
        const variantParams = this.experimentFramework.getVariantParameters(
          quest.id,
          experiment.id
        );

        if (variantParams) {
          modifiedLoadout = this.applyVariantParameters(modifiedLoadout, variantParams);
        }
      }
    }

    return {
      loadout: modifiedLoadout,
      assignments,
    };
  }

  /**
   * Apply variant parameters to a loadout configuration
   */
  private applyVariantParameters(
    baseLoadout: LoadoutConfiguration,
    parameters: VariantParameters
  ): LoadoutConfiguration {
    const modifiedLoadout = { ...baseLoadout };

    // Apply model choices
    if (parameters.modelChoices) {
      modifiedLoadout.modelChoices = {
        ...modifiedLoadout.modelChoices,
        ...parameters.modelChoices,
      };
    }

    // Apply squad composition
    if (parameters.squadComposition) {
      modifiedLoadout.enabledAgentTypes = parameters.squadComposition;
    }

    // Apply max squad size
    if (parameters.maxSquadSize !== undefined) {
      modifiedLoadout.maxSquadSize = parameters.maxSquadSize;
    }

    // Apply context size
    if (parameters.contextSize) {
      modifiedLoadout.contextSize = parameters.contextSize;
    }

    // Apply parallelism level
    if (parameters.parallelismLevel) {
      modifiedLoadout.parallelismLevel = parameters.parallelismLevel;
    }

    // Apply auto-approval setting
    if (parameters.autoApprove !== undefined) {
      modifiedLoadout.autoApprove = parameters.autoApprove;
    }

    return modifiedLoadout;
  }

  /**
   * Record quest completion outcome for all assigned experiments
   */
  async recordQuestOutcome(
    quest: Quest,
    assignments: Array<{ experimentId: string; variantId: string }>,
    outcome: {
      success: boolean;
      tokensUsed: number;
      executionTimeMs: number;
      reworkCount: number;
      humanRating?: number;
      metadata?: Record<string, any>;
    }
  ): Promise<void> {
    for (const assignment of assignments) {
      try {
        this.experimentFramework.recordOutcome(
          assignment.experimentId,
          quest.id,
          outcome
        );
      } catch (error) {
        console.warn(
          `Failed to record outcome for experiment ${assignment.experimentId}:`,
          error
        );
      }
    }
  }

  /**
   * Auto-analyze experiments that have enough data
   */
  async analyzeExperimentsWithSufficientData(): Promise<void> {
    const activeExperiments = this.experimentFramework.getActiveExperiments();

    for (const experiment of activeExperiments) {
      try {
        const analysis = this.experimentFramework.analyzeExperiment(experiment.id);

        // Check if experiment should be stopped
        if (analysis.recommendation === "stop_winner" && analysis.winningVariant) {
          console.log(
            `Experiment "${experiment.name}" has significant results! ` +
            `Winning variant: ${experiment.variants.find(v => v.id === analysis.winningVariant)?.name}`
          );
          console.log(`Confidence: ${(analysis.confidence * 100).toFixed(1)}%`);

          // Optionally auto-stop experiments with clear winners
          // this.experimentFramework.stopExperiment(experiment.id);
        } else if (analysis.recommendation === "stop_no_effect") {
          console.log(
            `Experiment "${experiment.name}" shows no significant effect. ` +
            `Consider stopping or redesigning.`
          );
        } else if (analysis.status === "insufficient_data") {
          const minSamples = Object.values(analysis.sampleSizes)
            .reduce((min, size) => Math.min(min, size), Infinity);
          const needed = experiment.targetSampleSize - minSamples;

          if (needed > 0) {
            console.log(
              `Experiment "${experiment.name}" needs ${needed} more samples per variant`
            );
          }
        }
      } catch (error) {
        console.warn(`Failed to analyze experiment ${experiment.id}:`, error);
      }
    }
  }

  /**
   * Check if a quest should be included in experiments based on criteria
   */
  shouldIncludeQuestInExperiments(quest: Quest): boolean {
    // Exclude already completed or failed quests
    if (quest.status === "complete" || quest.status === "failed") {
      return false;
    }

    // Exclude test quests or specific patterns
    if (quest.objective.toLowerCase().includes("test") &&
        quest.objective.toLowerCase().includes("experiment")) {
      return false;
    }

    // Include all other quests
    return true;
  }

  /**
   * Generate experiment report for a specific experiment
   */
  generateExperimentReport(experimentId: string): string {
    const experiment = this.experimentFramework.getExperiment(experimentId);
    if (!experiment) {
      return `Experiment ${experimentId} not found`;
    }

    const analysis = this.experimentFramework.analyzeExperiment(experimentId);

    let report = `# Experiment Report: ${experiment.name}\n\n`;
    report += `**Hypothesis:** ${experiment.hypothesis}\n\n`;
    report += `**Status:** ${experiment.status} (${analysis.status})\n`;
    report += `**Recommendation:** ${analysis.recommendation}\n\n`;

    if (analysis.winningVariant) {
      const winner = experiment.variants.find(v => v.id === analysis.winningVariant);
      report += `**Winner:** ${winner?.name}\n\n`;
    }

    report += `## Variants\n\n`;
    for (const variant of experiment.variants) {
      const sampleSize = analysis.sampleSizes[variant.id] || 0;
      const metrics = analysis.variantMetrics[variant.id];

      report += `### ${variant.name} ${variant.isControl ? '(Control)' : ''}\n`;
      report += `- Sample size: ${sampleSize}\n`;

      if (metrics) {
        report += `- Success rate: ${(metrics.successRate * 100).toFixed(1)}%\n`;
        report += `- Avg tokens: ${metrics.avgTokensPerQuest.toFixed(0)}\n`;
        report += `- Avg time: ${(metrics.avgExecutionTimeMs / 1000).toFixed(1)}s\n`;
        report += `- Avg rework: ${metrics.avgReworkCount.toFixed(1)}\n`;
        if (metrics.humanSatisfaction) {
          report += `- Human rating: ${metrics.humanSatisfaction.toFixed(1)}/5\n`;
        }
      }
      report += '\n';
    }

    if (analysis.significanceTests.length > 0) {
      report += `## Statistical Results\n\n`;
      for (const test of analysis.significanceTests) {
        report += `### ${test.metric}\n`;
        report += `- Improvement: ${test.improvement.toFixed(1)}%\n`;
        report += `- P-value: ${test.pValue.toFixed(4)}\n`;
        report += `- Significant: ${test.isSignificant ? 'Yes' : 'No'}\n`;
        report += `- Confidence interval: [${test.confidenceInterval[0].toFixed(3)}, ${test.confidenceInterval[1].toFixed(3)}]\n\n`;
      }
    }

    return report;
  }

  /**
   * Get summary of all active experiments
   */
  getExperimentsSummary(): string {
    const activeExperiments = this.experimentFramework.getActiveExperiments();

    if (activeExperiments.length === 0) {
      return "No active experiments running.";
    }

    let summary = `# Active Experiments (${activeExperiments.length})\n\n`;

    for (const experiment of activeExperiments) {
      const analysis = this.experimentFramework.analyzeExperiment(experiment.id);
      const totalSamples = Object.values(analysis.sampleSizes).reduce((sum, size) => sum + size, 0);

      summary += `## ${experiment.name}\n`;
      summary += `- Status: ${analysis.status}\n`;
      summary += `- Total samples: ${totalSamples}/${experiment.targetSampleSize * experiment.variants.length}\n`;
      summary += `- Recommendation: ${analysis.recommendation}\n`;

      if (analysis.winningVariant) {
        const winner = experiment.variants.find(v => v.id === analysis.winningVariant);
        summary += `- Winner: ${winner?.name} (${(analysis.confidence * 100).toFixed(1)}% confidence)\n`;
      }

      summary += '\n';
    }

    return summary;
  }
}