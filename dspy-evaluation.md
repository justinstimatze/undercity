# DSPy Evaluation for Undercity

## Executive Summary

After analyzing the Undercity codebase, **DSPy is not recommended for immediate implementation**. The system already has sophisticated prompt optimization infrastructure that would be undermined by adding DSPy. However, specific DSPy modules could provide value in targeted areas once we have sufficient metrics data.

## Current State Analysis

### Existing Prompt Optimization Infrastructure

**Knowledge Tracking System** (`knowledge-tracker.ts`):
- Already tracks successful prompts by task type
- Records performance metrics (tokens, execution time, success ratings)
- Implements institutional learning with success counts
- Provides A/B testing capabilities for prompt variants

**Metrics Collection** (`metrics.ts`):
- Comprehensive token usage tracking
- Success rate monitoring by complexity level
- Model escalation pattern analysis
- Efficiency analytics across agent types

**Experimental Framework** (`experiments/framework.ts`):
- Statistical A/B testing with proper control groups
- Variant assignment and outcome tracking
- Significance testing and confidence intervals
- Already supports prompt variant testing

**Smart Routing** (`router.ts`):
- Model selection based on task complexity
- Cost optimization (local tools → Haiku → Sonnet → Opus)
- Pattern-based task classification

### Key Strengths Over DSPy

1. **Domain-Specific**: Tailored for multi-agent orchestration patterns
2. **Cost-Aware**: Explicit token budgeting and rate limit management
3. **Human-in-Loop**: Approval workflows and escalation paths
4. **Statistical Rigor**: Proper experimental design with controls
5. **Persistence**: Crash-resistant state management across sessions

## DSPy Integration Assessment

### Where DSPy Could Add Value

**1. Signature Optimization** (`types.ts` agent definitions):
```typescript
// Current static prompts in squad.ts
prompt: `You are a quester. Your job is to EXECUTE the approved plan...`

// Could become DSPy signatures with learned optimizations
signature: dspy.Signature("plan, context -> implementation")
```

**2. Chain-of-Thought Optimization** (Annealing Review):
```typescript
// Current manual review passes in annealing-review.ts
// Could optimize prompt chains for better review coverage
```

**3. Few-Shot Example Selection** (Knowledge Tracker):
```typescript
// Current manual approach selection
// Could use DSPy's example selection for better demonstrations
```

### Where DSPy Would Conflict

**1. Token Budget Management**: DSPy's optimization process requires many inference calls that would exceed rate limits during training.

**2. Multi-Model Strategy**: Undercity's tiered model approach (Haiku→Sonnet→Opus) doesn't align with DSPy's single-model optimization.

**3. Human Approval Loops**: DSPy assumes automated evaluation, but Undercity requires human review for safety.

**4. Existing Investment**: The current knowledge tracking system already provides many DSPy benefits without the complexity.

## Data Readiness Assessment

### Required Metrics (Missing)
- [ ] **Success rate by prompt variant**: Need to A/B test existing prompts
- [ ] **Error categorization**: Map failure types to prompt quality issues
- [ ] **Human feedback correlation**: Link user satisfaction to prompt performance
- [ ] **Cross-task generalization**: Measure prompt transfer between task types

### Available Metrics (Present)
- [x] Token usage by agent type and complexity
- [x] Execution time tracking
- [x] Model escalation patterns
- [x] Success rates by complexity level

## Recommendations

### Phase 1: Data Collection (Next 2-4 weeks)
```typescript
// Extend existing KnowledgeTracker
interface PromptVariantMetrics extends PromptKnowledge {
  errorCategories: ErrorCategory[];
  humanSatisfactionScore: number;
  transferabilityScore: number;
  contextAdaptation: number;
}
```

### Phase 2: Bottleneck Analysis (4-6 weeks)
1. **Run systematic A/B tests** using existing experiment framework
2. **Measure prompt quality vs. routing effectiveness**
3. **Quantify human intervention triggers**
4. **Assess diminishing returns** from current optimization

### Phase 3: Targeted DSPy Integration (8+ weeks)
**If and only if** data shows prompt quality is the primary bottleneck:

```typescript
// Limited DSPy integration for specific use cases
class DSPyPromptOptimizer {
  async optimizeSignature(
    taskType: string,
    existingKnowledge: PromptKnowledge[],
    budget: TokenBudget
  ): Promise<OptimizedPrompt> {
    // Use DSPy only where existing system shows poor performance
  }
}
```

## Implementation Strategy (If Warranted)

### Minimal Integration Approach
```typescript
// Wrap DSPy in existing architecture
export class HybridPromptManager {
  private knowledgeTracker: KnowledgeTracker;
  private dspyOptimizer?: DSPyOptimizer;

  async selectPrompt(taskType: string, context: TaskContext): Promise<string> {
    // 1. Check existing knowledge first
    const existingApproach = this.knowledgeTracker.findMostSuccessfulPrompt(taskType);

    // 2. Use DSPy only for low-performance areas
    if (existingApproach.successCount < THRESHOLD) {
      return this.dspyOptimizer?.optimize(taskType, context);
    }

    // 3. Fall back to proven approaches
    return existingApproach.prompt;
  }
}
```

### Risk Mitigation
- **Token Budget Protection**: Hard limits on DSPy training costs
- **Human Override**: Always allow manual prompt selection
- **Rollback Strategy**: Easy revert to existing system
- **Gradual Deployment**: Start with non-critical agent types

## Conclusion

**Wait until we have 6-8 weeks of comprehensive metrics data** before pursuing DSPy integration. The current system likely has significant untapped optimization potential that should be exhausted first.

**Key Success Criteria for DSPy Consideration:**
1. Clear evidence that prompt quality (not routing/models) is the bottleneck
2. >30% of tasks showing poor prompt performance
3. Human intervention primarily due to prompt issues (not model capacity)
4. Quantified ROI showing DSPy would outperform existing optimization

The sophisticated infrastructure already in place suggests the team understands prompt optimization challenges. DSPy would add significant complexity for potentially marginal gains over the existing system.