# Local LLM Diff Generation Experiments

This module provides a framework for testing local LLM code generation capabilities against cloud APIs like Claude Haiku. It's specifically designed to measure the effectiveness of Ollama models for generating code diffs in simple editing scenarios.

## Overview

The diff generation experiment framework allows you to:

- **Compare local vs cloud models** for code generation tasks
- **Measure success rates** across different model sizes and specializations
- **Analyze performance metrics** including speed, accuracy, and cost
- **Run statistical tests** to determine significant differences

## Quick Start

### Prerequisites

1. **Install Ollama**: Visit [ollama.ai](https://ollama.ai) and install Ollama
2. **Pull models**: Download the models you want to test:
   ```bash
   ollama pull qwen2:1.5b
   ollama pull deepseek-coder:6.7b-instruct
   ollama pull codellama:7b-code
   ```

### Running an Experiment

1. **Create the experiment**:
   ```bash
   undercity experiment create-template ollama-diff
   ```

2. **Start the experiment**:
   ```bash
   undercity experiment start exp-xxxxx
   ```

3. **Run diff generation tests**:
   ```bash
   undercity experiment run-diff exp-xxxxx 5
   ```

4. **Analyze results**:
   ```bash
   undercity experiment analyze exp-xxxxx
   ```

## Experiment Templates

### `ollama-diff`
Comprehensive comparison between Haiku and multiple Ollama models:
- **Control**: Claude Haiku (cloud API)
- **Qwen2 1.5B**: Fast local model optimized for speed
- **DeepSeek Coder 6.7B**: Code-specialized model for quality
- **CodeLlama 7B**: Alternative code-specialized model

### `local-model-comparison`
Compare different Ollama model sizes and specializations:
- Models from 0.5B to 7B parameters
- Both general and code-specialized models
- Speed vs quality trade-off analysis

## Test Tasks

The experiment uses a standard set of code editing tasks:

1. **Simple validation** - Adding input validation to functions
2. **Interface extensions** - Adding fields to TypeScript interfaces
3. **Error handling** - Adding try-catch and error responses
4. **Method additions** - Adding methods to classes with proper error handling
5. **Complex refactoring** - Adding generics, async processing, and type safety

Each task includes:
- Original code content
- Specific editing instruction
- Difficulty level (simple/medium/complex)
- Expected patterns for validation

## Metrics Tracked

### Success Metrics
- **Success Rate**: Percentage of successfully generated diffs
- **Diff Application Rate**: Percentage of diffs that can be applied without errors
- **Average Generation Time**: Speed comparison between models
- **Token Usage**: API cost comparison (local = 0 tokens)

### Quality Metrics
- **Diff Size**: Characters changed (measure of efficiency)
- **Compilation Success**: Whether generated code compiles
- **Functional Correctness**: Whether the change achieves the goal

### Statistical Analysis
- **P-values**: Statistical significance of differences
- **Confidence Intervals**: Range of expected performance
- **Sample Size Requirements**: Minimum trials for reliable results

## CLI Commands

### Test Ollama Setup
```bash
undercity experiment test-ollama
```
Checks if Ollama is running and tests each available model with a simple task.

### List Experiment Templates
```bash
undercity experiment templates
```
Shows all available experiment templates including diff generation experiments.

### Run Diff Experiment
```bash
undercity experiment run-diff <experiment-id> [trials]
```
Runs the diff generation experiment with specified number of trials per task.

### Generate Report
```bash
undercity experiment report <experiment-id> report.md
```
Creates a detailed markdown report with all results and recommendations.

## Example Results

After running an experiment, you might see results like:

```
📊 Analysis for: Ollama vs Haiku Comprehensive Diff Generation

Total samples: 75
Status: significant
Recommendation: stop_winner

🏆 Winner: Ollama DeepSeek Coder 6.7B (89.2% confidence)

Statistical Tests:
  success_rate: 12.3% improvement (SIGNIFICANT, p=0.032)

Variant Performance:
  Haiku Cloud API (Control): 85.2% success, 156 tokens, 0.45s (25 samples)
  Ollama Qwen2 1.5B: 78.4% success, 0 tokens, 0.12s (25 samples)
  Ollama DeepSeek Coder 6.7B: 95.6% success, 0 tokens, 0.38s (25 samples)
```

## Implementation Details

### Architecture

- **ExperimentFramework**: Core A/B testing infrastructure
- **DiffGenerationService**: Handles running code generation tests
- **ExperimentTemplates**: Pre-built experiment configurations
- **Statistical Analysis**: Automated significance testing

### Model Integration

- **Ollama Integration**: Direct API calls to local Ollama instance
- **Haiku Simulation**: Simulated responses for baseline comparison
- **Error Handling**: Robust handling of model failures and timeouts

### Data Storage

Experiments store data in `.undercity/experiments/` with:
- Experiment configurations
- Variant assignments (deterministic randomization)
- Outcome tracking with full metadata
- Statistical analysis results

## Contributing

To add new test tasks or model integrations:

1. **Add Test Tasks**: Extend `generateSampleTasks()` in `diff-generator.ts`
2. **Add Models**: Update `LOCAL_MODELS` in `local-llm.ts`
3. **Add Metrics**: Extend `SuccessMetrics` interface in `types.ts`
4. **Add Templates**: Create new experiment configurations in `examples.ts`

## Troubleshooting

### Ollama Not Available
- Ensure Ollama is installed and running
- Check that models are downloaded with `ollama list`
- Verify localhost:11434 is accessible

### Model Errors
- Some models may not be suitable for code generation
- Try smaller context sizes for memory-constrained models
- Check model-specific documentation for optimal parameters

### Statistical Significance
- Need sufficient sample sizes (usually 30+ per variant)
- Some differences may not be statistically significant
- Consider increasing trial count or effect size thresholds