#!/usr/bin/env node
/**
 * Demo script for local LLM diff generation experiments
 *
 * Shows how to set up and run experiments comparing Ollama models vs Haiku for code diffs
 */

import { ExperimentFramework, ExperimentTemplates, ExperimentCLI, DiffGenerationService } from "../experiments/index.js";
import { isOllamaAvailable, getAvailableModels } from "../local-llm.js";

async function demonstrateDiffExperiment() {
  console.log("🔬 Undercity Local LLM Diff Generation Experiment Demo\n");

  // Create framework and CLI
  const framework = new ExperimentFramework();
  const templates = new ExperimentTemplates(framework);
  const cli = new ExperimentCLI();
  const diffService = new DiffGenerationService(framework);

  // Check Ollama availability
  console.log("1. Checking Ollama availability...");
  const isAvailable = isOllamaAvailable();

  if (!isAvailable) {
    console.log("❌ Ollama is not available.");
    console.log("   Please install Ollama from https://ollama.ai");
    console.log("   Then run: ollama pull qwen2:1.5b");
    console.log("   And: ollama pull deepseek-coder:6.7b-instruct");
    console.log("\n   This demo will show setup only.\n");
  } else {
    console.log("✅ Ollama is available!");
    const models = getAvailableModels();
    console.log(`   Available models: ${models.join(", ")}`);
    console.log();

    // Test models
    console.log("2. Testing available models...");
    await cli.testOllama();
    console.log();
  }

  // Create experiment
  console.log("3. Creating diff generation experiment...");
  const experimentId = templates.createOllamaDiffExperiment();
  console.log(`✅ Created experiment: ${experimentId}`);

  const experiment = framework.getExperiment(experimentId);
  console.log(`   Name: ${experiment!.name}`);
  console.log(`   Variants: ${experiment!.variants.length}`);
  console.log(`   Tags: ${experiment!.tags.join(", ")}`);
  console.log();

  // Show experiment details
  console.log("4. Experiment variants:");
  for (const variant of experiment!.variants) {
    const marker = variant.isControl ? "🎯 (Control)" : "🔬";
    console.log(`   ${marker} ${variant.name}`);
    console.log(`      ${variant.description}`);
    console.log(`      Weight: ${(variant.weight * 100).toFixed(1)}%`);
    if (variant.parameters.localModel) {
      console.log(`      Model: ${variant.parameters.localModel}`);
    }
    console.log();
  }

  // Show sample tasks
  console.log("5. Sample edit tasks for testing:");
  const tasks = diffService.generateSampleTasks();
  for (const task of tasks.slice(0, 3)) { // Show first 3
    console.log(`   📝 ${task.id} (${task.difficulty})`);
    console.log(`      File: ${task.filePath}`);
    console.log(`      Task: ${task.instruction}`);
    console.log(`      Original:\n${task.originalContent.split('\n').map(l => `         ${l}`).join('\n')}`);
    console.log();
  }

  if (isAvailable) {
    console.log("6. To run the experiment:");
    console.log(`   undercity experiment start ${experimentId}`);
    console.log(`   undercity experiment run-diff ${experimentId} 3`);
    console.log(`   undercity experiment analyze ${experimentId}`);
    console.log();

    console.log("7. Example analysis output:");
    console.log("   After running trials, you'll see metrics like:");
    console.log("   - Success rate: How often diffs were generated successfully");
    console.log("   - Diff application rate: How often generated diffs could be applied");
    console.log("   - Average generation time: Speed comparison between models");
    console.log("   - Token usage: Cost comparison (local models use zero API tokens)");
    console.log("   - Statistical significance: Which approach performs better");
  } else {
    console.log("6. Once Ollama is set up, you can run:");
    console.log("   node dist/examples/diff-experiment-demo.js");
    console.log("   to see the full demonstration with actual model testing.");
  }

  console.log("\n🎯 This experiment will help determine:");
  console.log("   • Whether local models can match cloud API quality");
  console.log("   • Speed advantages of local inference");
  console.log("   • Cost savings from eliminating API calls");
  console.log("   • Best local model for your use case");
}

// Run the demo if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateDiffExperiment().catch(console.error);
}

export { demonstrateDiffExperiment };