# Ollama Diff Generation Experiments

This document describes the new experiment framework for testing local LLM code generation using Ollama against cloud models like Haiku.

## Overview

The experiment framework allows you to A/B test different approaches to code generation, specifically comparing:

- **Local Ollama models** (free, private, potentially faster)
- **Claude Haiku** (cloud, cost per token, highly reliable)

## Prerequisites

1. **Ollama Installation**: Download and install Ollama from [https://ollama.com/](https://ollama.com/)
2. **Start Ollama**: Run `ollama serve` in a terminal
3. **Pull Models**: Download the models you want to test:
   ```bash
   ollama pull qwen2:0.5b     # Very fast, small model
   ollama pull qwen2:1.5b     # Good balance of speed/quality
   ollama pull qwen2:3b       # Better quality, slower
   ollama pull codellama:7b-code        # Code-specialized model
   ollama pull deepseek-coder:6.7b-instruct  # Another code model
   ```

## Quick Start

### Run a Quick Test

```bash
# Run a quick comparison between Ollama and Haiku
undercity quick-ollama-test
```

This will:
1. Create a quick experiment comparing Haiku vs Qwen2:1.5B
2. Run a few simple diff generation tests
3. Show you the experiment ID for detailed results

### View Results

```bash
# Show detailed results
undercity experiment show <experiment-id>

# Generate a markdown report
undercity experiment report <experiment-id> results.md
```

## Available Experiment Templates

### 1. Ollama vs Haiku Diff Generation

Tests local Ollama models against Claude Haiku for simple code edits:

```bash
# Create the experiment
undercity experiment create-template ollama-vs-haiku

# Start the experiment with custom trial count
undercity experiment start <experiment-id> --trials 20

# Monitor progress
undercity experiment show <experiment-id>
```

**Variants tested:**
- **Haiku Cloud (Control)**: Claude Haiku via cloud API
- **Ollama Qwen2 1.5B**: Local Ollama with medium-sized model
- **Ollama DeepSeek Coder**: Local code-specialized model

### 2. Local Model Comparison

Compares different Ollama model sizes and specializations:

```bash
undercity experiment create-template local-model-comparison
```

**Variants tested:**
- Qwen2 0.5B (fastest, baseline)
- Qwen2 1.5B (balanced)
- Qwen2 3B (better quality)
- CodeLlama 7B (code-specialized)
- DeepSeek Coder 6.7B (instruction-tuned)

## Experiment Commands

```bash
# List all experiments
undercity experiment list

# List only active experiments
undercity experiment list active

# Show available templates
undercity experiment templates

# Create from template
undercity experiment create-template <template-name>

# Start experiment
undercity experiment start <experiment-id>

# Stop experiment
undercity experiment stop <experiment-id>

# Analyze results
undercity experiment analyze <experiment-id>

# Generate report
undercity experiment report <experiment-id> [output-file.md]

# Show summary of all active experiments
undercity experiment summary

# Auto-analyze all experiments with sufficient data
undercity experiment auto-analyze

# Delete experiment (with confirmation)
undercity experiment delete <experiment-id> --confirm
```

## Metrics Tracked

The experiments track several key metrics:

### Success Metrics
- **Success Rate**: Percentage of successful diff generations
- **Avg Tokens Per Quest**: Token usage per generation
- **Avg Execution Time**: Time to generate each diff
- **Avg Rework Count**: Number of retry attempts needed

### Diff-Specific Metrics
- **Diff Success Rate**: Whether diffs were successfully generated
- **Diff Application Success**: Whether generated diffs were valid
- **Diff Generation Time**: Time specifically for diff generation
- **Diff Size**: Character count of generated diffs

## Example Workflow

1. **Setup Ollama**:
   ```bash
   ollama serve
   ollama pull qwen2:1.5b
   ollama pull deepseek-coder:6.7b-instruct
   ```

2. **Create Experiment**:
   ```bash
   undercity experiment create-template ollama-vs-haiku
   # Output: ✅ Created experiment: exp-mk85paa6-8cxu
   ```

3. **Start Testing**:
   ```bash
   undercity experiment start exp-mk85paa6-8cxu --trials 15
   ```

4. **Monitor Progress**:
   ```bash
   undercity experiment show exp-mk85paa6-8cxu
   ```

5. **Analyze Results**:
   ```bash
   undercity experiment analyze exp-mk85paa6-8cxu
   undercity experiment report exp-mk85paa6-8cxu ollama-results.md
   ```

## Expected Results

Based on preliminary testing, you should expect:

### Ollama Advantages
- **Faster response times** (no network latency)
- **Zero API costs** (runs locally)
- **Privacy** (code never leaves your machine)
- **Offline capability** (no internet required)

### Haiku Advantages
- **Higher success rates** (more reliable)
- **Better code understanding** (larger model)
- **Consistent quality** (cloud infrastructure)
- **No local resource usage** (CPU/memory)

### Model Size Trade-offs
- **Smaller models (0.5B-1.5B)**: Very fast, good for simple edits
- **Larger models (3B-7B)**: Better quality, slower, more resource usage
- **Code-specialized models**: Better for complex programming tasks

## Integration with Undercity

The experiment framework integrates seamlessly with the existing Undercity quest system:

- Experiments can be assigned to actual quests for real-world testing
- Results are automatically tracked and analyzed
- Statistical significance testing determines when experiments are complete
- Winners can be automatically adopted as default configurations

## Troubleshooting

### Ollama Not Available
```
❌ Ollama is not available
```
**Solution**: Make sure Ollama is installed and running (`ollama serve`)

### Model Not Found
```
❌ Model qwen2:1.5b is not available
```
**Solution**: Pull the model first (`ollama pull qwen2:1.5b`)

### Experiment Shows No Data
**Solution**: Make sure the experiment is started and has run some trials:
```bash
undercity experiment start <experiment-id> --trials 10
```

## Future Enhancements

- **More model types**: Support for additional local LLM providers
- **Real-time monitoring**: Live dashboard for experiment progress
- **Auto-tuning**: Automatic hyperparameter optimization
- **Integration testing**: Full end-to-end quest validation
- **Cost analysis**: Detailed cost comparison including compute costs