/**
 * Experimentation CLI Commands
 *
 * Command line interface for managing experiments
 */

import { writeFileSync, existsSync } from "node:fs";
import { ExperimentFramework } from "./framework.js";
import { QuestExperimentIntegrator } from "./integration.js";
import { ExperimentTemplates } from "./examples.js";
import { Experiment, ExperimentStatus } from "./types.js";

export class ExperimentCLI {
  private framework: ExperimentFramework;
  private integrator: QuestExperimentIntegrator;
  private templates: ExperimentTemplates;

  constructor(storagePath?: string) {
    this.framework = new ExperimentFramework(storagePath);
    this.integrator = new QuestExperimentIntegrator(this.framework);
    this.templates = new ExperimentTemplates(this.framework);
  }

  /**
   * List all experiments with their status
   */
  listExperiments(status?: ExperimentStatus): void {
    const experiments = this.framework.listExperiments();
    const filtered = status ? experiments.filter(exp => exp.status === status) : experiments;

    if (filtered.length === 0) {
      console.log(status ? `No experiments with status: ${status}` : "No experiments found");
      return;
    }

    console.log(`\n📊 Experiments ${status ? `(${status})` : ''}\n`);
    console.log("ID".padEnd(12) + "Name".padEnd(25) + "Status".padEnd(12) + "Variants".padEnd(10) + "Created");
    console.log("-".repeat(70));

    for (const exp of filtered) {
      const id = exp.id.substring(0, 10) + "..";
      const name = exp.name.substring(0, 22) + (exp.name.length > 22 ? "..." : "");
      const status = exp.status;
      const variantCount = exp.variants.length.toString();
      const created = exp.createdAt.toISOString().split('T')[0];

      console.log(
        id.padEnd(12) +
        name.padEnd(25) +
        status.padEnd(12) +
        variantCount.padEnd(10) +
        created
      );
    }
    console.log();
  }

  /**
   * Show detailed information about a specific experiment
   */
  showExperiment(experimentId: string): void {
    const experiment = this.framework.getExperiment(experimentId);

    if (!experiment) {
      console.error(`❌ Experiment not found: ${experimentId}`);
      return;
    }

    const analysis = this.framework.analyzeExperiment(experimentId);

    console.log(`\n🔬 ${experiment.name}`);
    console.log("=".repeat(50));
    console.log(`ID: ${experiment.id}`);
    console.log(`Status: ${experiment.status}`);
    console.log(`Hypothesis: ${experiment.hypothesis}`);
    console.log(`Created: ${experiment.createdAt.toISOString()}`);
    console.log(`Tags: ${experiment.tags.join(", ") || "None"}`);

    if (experiment.startedAt) {
      console.log(`Started: ${experiment.startedAt.toISOString()}`);
    }
    if (experiment.endedAt) {
      console.log(`Ended: ${experiment.endedAt.toISOString()}`);
    }

    console.log("\n📋 Variants:");
    for (const variant of experiment.variants) {
      const sampleSize = analysis.sampleSizes[variant.id] || 0;
      const metrics = analysis.variantMetrics[variant.id];
      const isWinner = analysis.winningVariant === variant.id;

      console.log(`  ${isWinner ? "🏆" : variant.isControl ? "🎯" : "🔬"} ${variant.name} (${sampleSize} samples)`);
      console.log(`     ${variant.description}`);

      if (metrics) {
        console.log(`     Success: ${(metrics.successRate * 100).toFixed(1)}% | ` +
                   `Tokens: ${metrics.avgTokensPerQuest.toFixed(0)} | ` +
                   `Time: ${(metrics.avgExecutionTimeMs / 1000).toFixed(1)}s`);
      }
      console.log();
    }

    if (analysis.significanceTests.length > 0) {
      console.log("📈 Statistical Results:");
      for (const test of analysis.significanceTests) {
        const significant = test.isSignificant ? "✅" : "❌";
        console.log(`  ${significant} ${test.metric}: ${test.improvement.toFixed(1)}% improvement (p=${test.pValue.toFixed(4)})`);
      }
      console.log();
    }

    console.log(`🎯 Analysis: ${analysis.status}`);
    console.log(`💡 Recommendation: ${analysis.recommendation}`);
    if (analysis.confidence > 0) {
      console.log(`🔒 Confidence: ${(analysis.confidence * 100).toFixed(1)}%`);
    }
    console.log();
  }

  /**
   * Create a new experiment from template
   */
  createTemplate(templateName: string): void {
    let experimentId: string;

    try {
      switch (templateName.toLowerCase()) {
        case "opus-vs-mixed":
          experimentId = this.templates.createOpusVsMixedExperiment();
          break;
        case "squad-composition":
          experimentId = this.templates.createSquadCompositionExperiment();
          break;
        case "parallelism":
          experimentId = this.templates.createParallelismExperiment();
          break;
        case "context-size":
          experimentId = this.templates.createContextSizeExperiment();
          break;
        case "auto-approval":
          experimentId = this.templates.createAutoApprovalExperiment();
          break;
        case "comprehensive":
          experimentId = this.templates.createComprehensiveExperiment();
          break;
        default:
          console.error(`❌ Unknown template: ${templateName}`);
          console.log("Available templates: opus-vs-mixed, squad-composition, parallelism, context-size, auto-approval, comprehensive");
          return;
      }

      console.log(`✅ Created experiment: ${experimentId}`);
      console.log(`Use 'experiment start ${experimentId}' to begin testing`);
    } catch (error) {
      console.error(`❌ Failed to create experiment: ${error}`);
    }
  }

  /**
   * Start an experiment
   */
  startExperiment(experimentId: string): void {
    try {
      this.framework.startExperiment(experimentId);
      console.log(`✅ Started experiment: ${experimentId}`);
    } catch (error) {
      console.error(`❌ Failed to start experiment: ${error}`);
    }
  }

  /**
   * Stop an experiment
   */
  stopExperiment(experimentId: string): void {
    try {
      this.framework.stopExperiment(experimentId);
      console.log(`🛑 Stopped experiment: ${experimentId}`);
    } catch (error) {
      console.error(`❌ Failed to stop experiment: ${error}`);
    }
  }

  /**
   * Analyze an experiment and show results
   */
  analyzeExperiment(experimentId: string): void {
    try {
      const analysis = this.framework.analyzeExperiment(experimentId);
      const experiment = this.framework.getExperiment(experimentId);

      if (!experiment) {
        console.error(`❌ Experiment not found: ${experimentId}`);
        return;
      }

      console.log(`\n📊 Analysis for: ${experiment.name}\n`);

      const totalSamples = Object.values(analysis.sampleSizes).reduce((sum, size) => sum + size, 0);
      console.log(`Total samples: ${totalSamples}`);
      console.log(`Status: ${analysis.status}`);
      console.log(`Recommendation: ${analysis.recommendation}\n`);

      if (analysis.winningVariant) {
        const winner = experiment.variants.find(v => v.id === analysis.winningVariant);
        console.log(`🏆 Winner: ${winner?.name} (${(analysis.confidence * 100).toFixed(1)}% confidence)\n`);
      }

      if (analysis.significanceTests.length > 0) {
        console.log("Statistical Tests:");
        for (const test of analysis.significanceTests) {
          const status = test.isSignificant ? "SIGNIFICANT" : "not significant";
          console.log(`  ${test.metric}: ${test.improvement.toFixed(1)}% improvement (${status}, p=${test.pValue.toFixed(4)})`);
        }
        console.log();
      }

      // Show per-variant metrics
      console.log("Variant Performance:");
      for (const variant of experiment.variants) {
        const metrics = analysis.variantMetrics[variant.id];
        const samples = analysis.sampleSizes[variant.id] || 0;

        if (metrics && samples > 0) {
          console.log(`  ${variant.name}: ${(metrics.successRate * 100).toFixed(1)}% success, ` +
                     `${metrics.avgTokensPerQuest.toFixed(0)} tokens, ` +
                     `${(metrics.avgExecutionTimeMs / 1000).toFixed(1)}s (${samples} samples)`);
        }
      }
      console.log();

    } catch (error) {
      console.error(`❌ Failed to analyze experiment: ${error}`);
    }
  }

  /**
   * Generate and save experiment report
   */
  generateReport(experimentId: string, outputPath?: string): void {
    try {
      const report = this.integrator.generateExperimentReport(experimentId);

      if (outputPath) {
        writeFileSync(outputPath, report);
        console.log(`✅ Report saved to: ${outputPath}`);
      } else {
        console.log(report);
      }
    } catch (error) {
      console.error(`❌ Failed to generate report: ${error}`);
    }
  }

  /**
   * Show summary of all active experiments
   */
  showSummary(): void {
    const summary = this.integrator.getExperimentsSummary();
    console.log(summary);
  }

  /**
   * Delete an experiment
   */
  deleteExperiment(experimentId: string, confirm: boolean = false): void {
    if (!confirm) {
      console.log(`❓ Are you sure you want to delete experiment ${experimentId}?`);
      console.log("This will remove all experiment data including outcomes.");
      console.log("Run with --confirm to proceed.");
      return;
    }

    try {
      this.framework.deleteExperiment(experimentId);
      console.log(`✅ Deleted experiment: ${experimentId}`);
    } catch (error) {
      console.error(`❌ Failed to delete experiment: ${error}`);
    }
  }

  /**
   * Auto-analyze all active experiments
   */
  autoAnalyze(): void {
    try {
      this.integrator.analyzeExperimentsWithSufficientData();
      console.log("✅ Auto-analysis complete");
    } catch (error) {
      console.error(`❌ Auto-analysis failed: ${error}`);
    }
  }

  /**
   * Import experiment definitions from JSON file
   */
  importExperiment(filePath: string): void {
    if (!existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`);
      return;
    }

    try {
      // Implementation would read JSON and create experiment
      console.log(`📥 Importing experiment from: ${filePath}`);
      console.log("⚠️  Import functionality not yet implemented");
    } catch (error) {
      console.error(`❌ Failed to import experiment: ${error}`);
    }
  }

  /**
   * Export experiment definition to JSON file
   */
  exportExperiment(experimentId: string, outputPath: string): void {
    try {
      const experiment = this.framework.getExperiment(experimentId);

      if (!experiment) {
        console.error(`❌ Experiment not found: ${experimentId}`);
        return;
      }

      writeFileSync(outputPath, JSON.stringify(experiment, null, 2));
      console.log(`✅ Exported experiment to: ${outputPath}`);
    } catch (error) {
      console.error(`❌ Failed to export experiment: ${error}`);
    }
  }

  /**
   * Show available template names
   */
  listTemplates(): void {
    console.log("\n📋 Available Experiment Templates:\n");
    console.log("opus-vs-mixed     - Test Opus vs mixed model configuration");
    console.log("squad-composition - Test different squad member combinations");
    console.log("parallelism       - Test sequential vs parallel execution");
    console.log("context-size      - Test different context size configurations");
    console.log("auto-approval     - Test human approval vs auto-approval");
    console.log("comprehensive     - Test speed vs quality configurations");
    console.log();
    console.log("Usage: experiment create-template <template-name>");
    console.log();
  }

  /**
   * Show CLI help
   */
  showHelp(): void {
    console.log(`
🔬 Undercity Experimentation Framework

USAGE:
  experiment <command> [options]

COMMANDS:
  list [status]              List experiments (optionally filter by status)
  show <id>                  Show detailed experiment information
  create-template <name>     Create experiment from template
  start <id>                 Start an experiment
  stop <id>                  Stop an experiment
  analyze <id>               Analyze experiment results
  report <id> [output]       Generate experiment report
  summary                    Show summary of active experiments
  delete <id> [--confirm]    Delete an experiment
  auto-analyze              Auto-analyze all active experiments
  import <file>             Import experiment from JSON
  export <id> <file>        Export experiment to JSON
  templates                 List available templates
  help                      Show this help

EXAMPLES:
  experiment list
  experiment create-template opus-vs-mixed
  experiment start exp-123456
  experiment analyze exp-123456
  experiment report exp-123456 report.md

For more information, see the experimentation documentation.
`);
  }
}