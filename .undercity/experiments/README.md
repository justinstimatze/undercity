# Undercity Experimentation Framework

The Undercity Experimentation Framework enables systematic A/B testing of quest execution parameters to optimize performance, cost, and quality.

## Overview

This framework allows you to:

- **Define experiments** with multiple variants testing different configurations
- **Automatically assign quests** to experiment variants using deterministic randomization
- **Track outcomes** including success rate, token usage, execution time, and rework count
- **Analyze statistical significance** using proper statistical tests
- **Get recommendations** on whether to stop experiments with clear winners

## Quick Start

### 1. Create an Experiment

```bash
# List available templates
undercity experiment templates

# Create an experiment from template
undercity experiment create-template opus-vs-mixed

# Start the experiment
undercity experiment start <experiment-id>
```

### 2. Monitor Progress

```bash
# View all experiments
undercity experiment list

# See detailed analysis
undercity experiment analyze <experiment-id>

# Auto-analyze all active experiments
undercity experiment auto-analyze
```

### 3. Generate Reports

```bash
# Generate detailed report
undercity experiment report <experiment-id>

# Save report to file
undercity experiment report <experiment-id> report.md
```

## Experiment Types

### Available Templates

1. **opus-vs-mixed** - Test Opus vs mixed model configuration
2. **squad-composition** - Test different squad member combinations
3. **parallelism** - Test sequential vs parallel execution
4. **context-size** - Test different context size configurations
5. **auto-approval** - Test human approval vs auto-approval
6. **comprehensive** - Test speed vs quality configurations

### Parameters You Can Test

- **Model choices** (haiku/sonnet/opus) for each agent type
- **Squad composition** (which agents to include)
- **Context size** (small/medium/large)
- **Parallelism level** (sequential/limited/maximum)
- **Auto-approval** settings
- **Custom parameters** for specific hypotheses

## How It Works

### 1. Deterministic Assignment

Quests are assigned to variants using deterministic randomization based on quest ID and experiment ID. This ensures:

- **Reproducible results** - the same quest always gets the same variant
- **Proper distribution** - assignments follow configured weights
- **No assignment bias** - randomization is cryptographically secure

### 2. Automatic Integration

When experiments are active, the framework automatically:

- **Intercepts quest execution** to apply variant parameters
- **Modifies loadout configuration** based on variant settings
- **Records outcomes** when quests complete
- **Tracks metrics** like success rate, tokens used, execution time

### 3. Statistical Analysis

The framework performs proper statistical tests:

- **Two-proportion z-tests** for success rate comparisons
- **Confidence intervals** for effect size estimation
- **Significance testing** at configured alpha levels (default 0.05)
- **Sample size tracking** to ensure adequate power

## Example Workflow

```bash
# 1. Create and start an experiment
undercity experiment create-template opus-vs-mixed
undercity experiment start exp-abc123

# 2. Run quests normally - they'll be automatically assigned
undercity slingshot "Add user authentication"
undercity slingshot "Fix performance bug"
undercity slingshot "Update documentation"

# 3. Monitor progress
undercity experiment summary

# 4. Analyze when you have enough data
undercity experiment analyze exp-abc123

# 5. Generate final report
undercity experiment report exp-abc123 auth-experiment-report.md
```

## Understanding Results

### Experiment Status

- **insufficient_data** - Need more samples to detect effects
- **running** - Collecting data, no significant effects yet
- **significant** - Found statistically significant differences
- **inconclusive** - Adequate sample size but no clear winner

### Recommendations

- **continue** - Keep collecting data
- **stop_winner** - Found clear winner, can stop experiment
- **stop_no_effect** - No meaningful difference detected
- **increase_sample_size** - Need more samples for conclusive results

### Key Metrics

- **Success Rate** - % of quests that complete successfully
- **Token Usage** - Average tokens consumed per quest
- **Execution Time** - Average time from start to completion
- **Rework Count** - Average number of retry/revision cycles

## Best Practices

### Experiment Design

1. **Clear Hypothesis** - Define what you expect to improve and by how much
2. **Single Variable** - Test one thing at a time for clearest results
3. **Adequate Sample Size** - Use at least 20-50 quests per variant
4. **Control Group** - Always include a baseline control variant

### Statistical Guidelines

1. **Multiple Comparisons** - Be cautious when testing many variants
2. **Effect Size** - Consider practical significance, not just statistical
3. **Confidence Intervals** - Look at ranges, not just point estimates
4. **Early Stopping** - Don't stop experiments too early

### Operational Tips

1. **Monitor Regularly** - Check experiment progress frequently
2. **Document Learnings** - Save reports for future reference
3. **Iterate Quickly** - Run small experiments to learn fast
4. **Share Results** - Communicate findings to team

## Data Storage

Experiments are stored in `.undercity/experiments/storage.json` with:

- **Experiment definitions** with variants and parameters
- **Quest assignments** mapping quests to variants
- **Outcome records** with all tracked metrics
- **Analysis results** with statistical test results

The storage format is versioned for future migrations and includes proper date handling for all timestamps.

## CLI Reference

```bash
# Management
undercity experiment list [status]         # List experiments
undercity experiment show <id>             # Show experiment details
undercity experiment start <id>            # Start experiment
undercity experiment stop <id>             # Stop experiment
undercity experiment delete <id> --confirm # Delete experiment

# Creation
undercity experiment create-template <name> # Create from template
undercity experiment templates              # List available templates

# Analysis
undercity experiment analyze <id>           # Analyze specific experiment
undercity experiment summary                # Show all active experiments
undercity experiment auto-analyze           # Auto-analyze all experiments
undercity experiment report <id> [file]     # Generate report

# Data
undercity experiment export <id> <file>     # Export to JSON
undercity experiment import <file>          # Import from JSON (planned)
```

## Advanced Usage

### Custom Experiments

While templates cover common scenarios, you can create custom experiments programmatically:

```typescript
import { ExperimentFramework } from './src/experiments/index.js';

const framework = new ExperimentFramework();

const experiment = framework.createExperiment(
  "Custom Test",
  "Test custom parameters",
  "Custom hypothesis",
  [
    {
      name: "Control",
      description: "Baseline configuration",
      weight: 0.5,
      isControl: true,
      parameters: { /* control parameters */ }
    },
    {
      name: "Treatment",
      description: "New configuration",
      weight: 0.5,
      parameters: { /* treatment parameters */ }
    }
  ]
);
```

### Integration with Quest System

The framework automatically integrates with quest execution through:

1. **QuestExperimentIntegrator** - Handles quest assignment and outcome recording
2. **Parameter Application** - Modifies loadout configurations based on variants
3. **Outcome Tracking** - Records metrics when quests complete

This integration is transparent and requires no changes to existing quest execution code.

## Troubleshooting

### Common Issues

**No assignments happening**
- Check experiment status is "active"
- Verify experiments exist: `undercity experiment list`

**Insufficient data warnings**
- Run more quests to increase sample size
- Check target sample size in experiment definition

**No significant results**
- Increase effect size being tested
- Run more samples for better statistical power
- Consider if true effect exists

**Test failures**
- Check for proper control variant designation
- Verify variant weights sum to 1.0
- Ensure adequate sample sizes per variant

For more help, check the test files in `src/__tests__/experiments.test.ts` for usage examples.
