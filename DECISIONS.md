# Undercity Decision Framework

**When to use what, when to escalate, and how routing works.**

## Command Selection

### `solo` vs `grind`

| Command | Use Case | Execution Mode | Infrastructure | Status |
|---------|----------|----------------|---------------|---------|
| `solo <goal>` | **DEPRECATED** - single task with adaptive escalation | Sequential | Basic (LiveMetrics only) | Use `grind` instead |
| `grind [goal]` | **RECOMMENDED** - autonomous task processing | Parallel | Full (Worktree, Elevator, RateLimit, FileTracker, Recovery) | Main production command |
| `grind <goal>` | Single task execution (direct goal) | Parallel (concurrency=1) | Full infrastructure | Quick single-task execution |
| `grind` | Process task board | Parallel | Full infrastructure | Batch processing mode |

**Decision rule:** Always use `grind`. It's the main production orchestrator (`ParallelSoloOrchestrator`) with full infrastructure even for single tasks.

### When to Add to Task Board vs Direct Execution

```bash
# Direct execution (immediate)
undercity grind "fix typo in README"

# Task board (queue for later)
undercity add "implement user authentication"
undercity grind  # Process all queued tasks
```

**Add to task board when:**
- Multiple related tasks
- Tasks requiring coordination
- Long-running development sessions
- Tasks that can wait

**Execute directly when:**
- Urgent single fixes
- Quick experiments
- Immediate debugging needs

## Model Selection & Routing

### Complexity Assessment → Model Assignment

The system uses quantitative metrics + keyword analysis to route tasks:

#### Trivial/Simple → Haiku (Fast, Cheap: ~$0.01 per 1K tokens)
- **Score: 0-3 points**
- **Examples:** typos, comments, version bumps, small edits
- **File scope:** Single file, 1-3 files max
- **Keywords:** "typo", "comment", "rename", "add log", "minor"
- **Quantitative:** <500 lines, <10 functions, healthy code

#### Standard → Sonnet (Balanced: ~$0.15 per 1K tokens)
- **Score: 3-6 points**
- **Examples:** features, bug fixes, tests, moderate changes
- **File scope:** 2-5 files typically
- **Keywords:** "implement", "add feature", "fix bug", "create"
- **Quantitative:** 500-1000 lines, 10-20 functions, good health

#### Complex/Critical → Opus (Expensive, Capable: ~$0.75 per 1K tokens)
- **Score: 6+ points**
- **Examples:** refactoring, security, auth, migrations, architecture
- **File scope:** 5+ files, cross-package changes
- **Keywords:** "refactor", "security", "auth", "migrate", "architecture"
- **Quantitative:** >1000 lines, >20 functions, hotspots, unhealthy code

#### Scoring System (from `complexity.ts`):
```typescript
// File count: 1 file = 0, 3 files = +1, 7+ files = +2
// Lines: >500 = +1, >1000 = +2
// Functions: >10 = +1, >20 = +2
// Cross-package = +3
// Code health < 7 = +2, < 5 = +3
// Git hotspots = +1 per file
// Bug-prone files = +2 per file
```

### Model Routing Logic

1. **Free Local Tool Detection** (0 tokens)
   ```typescript
   // Patterns checked first - no LLM needed
   /^(run\s+)?(format|prettier)/i → "pnpm format"
   /^(run\s+)?(lint|biome)/i → "pnpm lint:fix"
   /^(run\s+)?typecheck/i → "pnpm typecheck"
   /^(run\s+)?test/i → "pnpm test"
   ```

2. **Fast Complexity Assessment** (`assessComplexityFast` - 0 tokens)
   - Keyword and pattern matching
   - Instant results for initial triage
   - **Scoring system:**
     * File count: 1 file = 0 pts, 3+ files = +2 pts
     * Keywords: "security" = +4 pts, "refactor" = +3 pts, "typo" = 0 pts
     * Scope: cross-package = +3 pts, single-file = 0 pts

3. **Quantitative Assessment** (when target files known)
   - Uses actual code metrics: LOC, function count, git hotspots
   - Code health scores from CodeScene
   - Git history analysis (bug-prone files, change frequency)
   - **More accurate than keyword matching**

4. **Task Decomposition Check** (`checkAndDecompose` - ~500 tokens)
   - Uses Haiku to assess atomicity
   - **Decomposition triggers:**
     * Multiple distinct objectives
     * Cross-package changes
     * >5 estimated files affected
   - Creates subtasks with individual model recommendations

5. **Adaptive Routing Override** (`applyAdaptiveRouting`)
   - Historical success rate tracking
   - **Override triggers:**
     * Haiku success rate < 70% for "simple" → route to sonnet
     * Sonnet success rate < 60% for assigned level → route to opus
   - Requires minimum 5 samples before overriding defaults

6. **Execution Order** (in `grind` mode)
   ```typescript
   // Process by model tier for cost efficiency
   modelOrder = ["haiku", "sonnet", "opus"]
   for (tier of modelOrder) {
     await processTasksWithModel(tier)
   }
   ```

## Escalation Strategy

### When Tasks Escalate (SoloOrchestrator logic)

**Escalation decision factors (`shouldEscalate`):**

1. **No changes made** → escalate immediately (agent is stuck)
2. **Error type affects retry count:**
   - **Trivial errors** (lint/spell only): Full `maxRetriesPerTier` attempts (default: 3)
   - **Serious errors** (typecheck/build/test): Faster escalation (`maxRetriesPerTier - 1`)
3. **Scope underestimation:**
   - Single-file task → touches 3+ files
   - Few-files task → touches 10+ files

**Escalation path:** `haiku → sonnet → opus → fail`

### Retry vs Escalation Strategy

```typescript
// Configuration (SoloOrchestrator)
{
  maxRetriesPerTier: 3,        // Retries at same tier before escalating
  maxReviewPassesPerTier: 2,   // Review passes per tier
  maxOpusReviewPasses: 6       // Opus gets more attempts (final tier)
}
```

**Decision logic:**
- **No progress**: Immediate escalation (agent stuck)
- **Trivial errors**: Allow full retries (lint often fixable by same model)
- **Serious errors**: Escalate faster (type errors usually need smarter model)

### Manual Escalation

```bash
# Force specific model for task
undercity grind "complex task" --model opus

# Enable escalating review passes
undercity grind --review  # haiku → sonnet → opus review chain
```

## Verification & Quality Gates

### Standard Verification Loop

Every task goes through (in order):
1. **Typecheck** (`pnpm typecheck`)
2. **Tests** (`pnpm test`)
3. **Lint** (`pnpm lint`)
4. **Build** (`pnpm build`)

**Failure handling:**
- First failure → immediate fix attempt (same model)
- Repeated failures → escalate to next model tier
- Max retries exceeded → task marked failed

### Review Passes (Escalating Review System)

```bash
undercity grind --review  # Enable escalating review (default: enabled)
undercity grind --annealing  # Enable annealing review at opus tier
```

**Review chain:** haiku review → sonnet review → opus review

**Team Composition (inspired by Zeroshot):**
```typescript
// From getTeamComposition() in complexity.ts
{
  trivial: { validators: 0, independentValidators: false },
  simple: { validators: 1, independentValidators: true },
  standard: { validators: 2, independentValidators: true },
  complex: { validators: 3, independentValidators: true },
  critical: { validators: 5, independentValidators: true }
}
```

**Key insight from Zeroshot:** Independent validators who didn't write the code can't lie about whether tests pass - they catch bugs the original agent missed.

**Review convergence:**
- Each tier reviews until it finds no issues (converges)
- If tier exhausted without convergence → escalate to next tier
- At opus tier: generate tickets for unresolved issues

### When to Skip Verification

**Never skip verification** in production. For development:
```bash
undercity grind --no-typecheck  # Skip type checking
undercity grind --no-review     # Skip review passes
```

Use only for rapid prototyping or known-safe changes.

## Parallel vs Sequential Execution

### Parallelism Configuration

```bash
undercity grind --parallel 1   # Sequential (safe)
undercity grind --parallel 3   # Moderate parallelism (default)
undercity grind --parallel 5   # Maximum parallelism
```

### When to Use Each Level

| Level | Use Case | Risk | Throughput |
|-------|----------|------|------------|
| 1 | Conflicting tasks, critical changes | Lowest | Lowest |
| 3 | Standard development batch | Moderate | Good |
| 5 | Independent tasks, non-critical | Highest | Highest |

### Conflict Detection

**Pre-merge conflict detection** via `FileTracker`:
- Detects when parallel tasks modify same files
- Fails conflicting tasks early (before merge)
- Requires manual resolution

**Safe parallelism indicators:**
- Tasks modify different packages
- Different feature areas
- Tests vs implementation vs docs

## Recovery & State Management

### Crash Recovery

```bash
undercity grind  # Auto-resumes interrupted batch
```

**Recovery state** (`.undercity/parallel-recovery.json`):
- Task completion status
- Worktree locations
- Partial results
- Error context

### State Files

| File | Purpose | When to Clear |
|------|---------|---------------|
| `parallel-recovery.json` | Crash recovery | After successful completion |
| `tasks.json` | Task board | Never (persistent queue) |
| `grind-events.jsonl` | Audit log | Periodically for space |
| `rate-limit-state.json` | Token tracking | Never |

**Clean stale state:**
```bash
pnpm cleanup  # Clears stale state, creates backups
```

## Rate Limiting & Cost Control

### Rate Limit Thresholds

- **1M tokens per 5 hours**
- **5M tokens per week**
- **Auto-pause at 95% usage**

### Cost Optimization Strategy

1. **Model tier ordering:** Process haiku tasks first (cheapest)
2. **Task decomposition:** Break expensive tasks into cheaper subtasks
3. **Early escalation:** Don't waste tokens on wrong model tier
4. **Local tool detection:** Route formatting/linting to local tools (0 cost)

### Local Tool Routing (Free)

Tasks automatically routed to local tools when possible:
- `run format` → `pnpm format`
- `run lint` → `pnpm lint:fix`
- `run typecheck` → `pnpm typecheck`
- `run test` → `pnpm test`
- `run build` → `pnpm build`

**Zero token cost** for these operations.

## Monitoring & Debugging

### Real-time Monitoring

```bash
undercity watch      # TUI dashboard
undercity status     # Current grind state
undercity limits     # Token usage snapshot
```

### Event Logging

All execution events logged to `.undercity/grind-events.jsonl`:
- Task queued/started/completed/failed
- Model escalations
- Merge operations
- Rate limit hits

### Debugging Failed Tasks

1. Check event log: `undercity status --events`
2. Examine worktree state: `git worktree list`
3. Review task decomposition: enable verbose logging
4. Check rate limits: `undercity limits`

## Performance Tuning

### Optimal Parallelism

**Rule of thumb:** `min(3, pending_tasks / 2, available_cpu_cores - 1)`

**Factors affecting parallelism:**
- Git worktree overhead
- Token rate limits
- Task interdependencies
- System resources

### Batch Size Guidelines

| Task Type | Optimal Batch Size | Reasoning |
|-----------|-------------------|-----------|
| Independent fixes | 10-20 | High parallelism |
| Feature work | 3-5 | Moderate complexity |
| Architectural | 1-2 | High review needs |
| Mixed batch | 5-10 | Balanced approach |

### Supervised Mode & Advanced Review Techniques

#### Supervised Execution
```bash
undercity solo --supervised --worker sonnet
```

**Use supervised mode when:**
- Very complex architectural tasks
- Need Opus-level planning with Sonnet execution
- High-stakes changes requiring careful orchestration

**Standard mode is sufficient for:**
- Routine development tasks
- Well-defined feature work
- Bug fixes with clear scope

#### Annealing Review System (Advanced)

**Tarot-card based multi-angle analysis:**
```bash
undercity grind --annealing  # Enable annealing at opus tier
```

**How it works (`AnnealingReview` class):**
```typescript
// Uses tarot cards to examine code from different angles
const schedule = generateSchedule().slice(0, 3)  // 3 random perspectives
for (const pass of schedule) {
  const cardName = pass.isMajor ? pass.card.name : `${pass.card.rank} of ${pass.card.suit}`
  // Each card provides a unique lens for analysis
}
```

**Example review angles:**
- **The Tower**: "What would break under sudden load?"
- **Seven of Swords**: "Where are the security vulnerabilities?"
- **The Fool**: "What would a newcomer find confusing?"
- **Three of Pentacles**: "How does this affect team collaboration?"

**Advisory mode only:**
- Provides insights, doesn't make direct changes
- Complements standard review passes
- Uses opus model for creative analysis
- Triggered automatically for complex/critical tasks

**Benefits:**
- Catches issues traditional review might miss
- Creative perspective on code quality
- Low-cost addition to standard review pipeline

## Command Decision Tree

```
Need to run a task?
├─ Urgent single task? → undercity grind "task"
├─ Multiple related tasks? → undercity add "task1" → undercity add "task2" → undercity grind
├─ Complex architectural work? → undercity grind --model opus
├─ Need review? → undercity grind --review
├─ Safe batch processing? → undercity grind --parallel 3
└─ Overnight processing? → pnpm daemon:start → undercity serve --grind
```

## Best Practices

### Do's
- ✅ Use `grind` for everything (not `solo` or `work`)
- ✅ Let system auto-route models based on complexity
- ✅ Enable review passes for critical changes
- ✅ Use task board for related work
- ✅ Check `undercity limits` before large batches
- ✅ Use `--parallel 3` for most workloads

### Don'ts
- ❌ Force models unless you understand the tradeoffs
- ❌ Skip verification in production
- ❌ Run high parallelism on conflicting tasks
- ❌ Push commits directly (let orchestrator handle merges)
- ❌ Clear state files manually (use `pnpm cleanup`)

### Common Anti-patterns

**Model misalignment:**
```bash
# BAD: Forcing opus for simple tasks
undercity grind "fix typo" --model opus  # Waste $1+ on $0.01 task

# GOOD: Let system choose
undercity grind "fix typo"  # Auto-routes to haiku
```

**Parallel conflicts:**
```bash
# BAD: High parallelism on related tasks
undercity grind --parallel 5  # When tasks modify same files

# GOOD: Sequential for conflicting work
undercity grind --parallel 1  # When in doubt
```

**Premature escalation:**
```bash
# BAD: Going straight to opus
undercity grind "add feature" --model opus

# GOOD: Let escalation happen naturally
undercity grind "add feature" --review  # Escalates as needed
```