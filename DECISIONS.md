# Undercity Decision Matrix

Comprehensive guide for when to use solo vs grind, escalation strategies, model routing logic, and parallel execution decisions.

## Quick Reference

| Task Type | Complexity | Command | Model | Parallelism | Review |
|-----------|------------|---------|--------|-------------|--------|
| Trivial (format, lint) | Local Tool | `pnpm format` | None | N/A | No |
| Single file fix | Simple | `grind "goal"` | haiku/sonnet | 1 | No |
| Feature implementation | Standard | `grind` | sonnet | 1-3 | Yes |
| Multi-package refactor | Complex | `grind --parallel 1` | opus | 1 | Yes |
| Security/Auth changes | Critical | `grind --parallel 1 --review` | opus | 1 | Yes |

## Command Selection

### `solo` vs `grind`

| Command | Use Case | Execution Mode | Infrastructure | Status |
|---------|----------|----------------|---------------|---------|
| `solo <goal>` | **DEPRECATED** - single task with adaptive escalation | Sequential | Basic (LiveMetrics only) | Use `grind` instead |
| `grind [goal]` | **RECOMMENDED** - autonomous task processing | Parallel | Full (Worktree, MergeQueue, RateLimit, FileTracker, Recovery) | Main production command |
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

### Complexity Assessment Pipeline

Undercity uses a multi-stage assessment pipeline to route tasks to the optimal model tier:

```
Task Description → Local Tool Check → Fast Assessment → Quantitative Assessment → Model Selection
```

#### Stage 1: Local Tool Detection (FREE - No Tokens)

**Pattern matching for zero-cost operations:**
```typescript
const LOCAL_TOOL_PATTERNS = [
  { pattern: /^(run\s+)?(format|prettier|biome\s+format)/i, command: "pnpm format" },
  { pattern: /^(run\s+)?(lint|biome\s+lint)/i, command: "pnpm lint:fix" },
  { pattern: /^(run\s+)?typecheck/i, command: "pnpm typecheck" },
  { pattern: /^(run\s+)?test($|\s)/i, command: "pnpm test" },
  { pattern: /^(run\s+)?build($|\s)/i, command: "pnpm build" }
]
```

**Key insight:** These operations are handled directly by shell commands with no AI involvement.

#### Stage 2: Fast Complexity Assessment (assessComplexityFast - No Tokens)

**Keyword-based scoring:**
- **Trivial keywords:** "typo", "comment", "rename", "version bump" → 0 points
- **Simple keywords:** "add log", "minor", "tweak", "adjust" → 1 point
- **Standard keywords:** "implement", "create", "fix bug", "add feature" → 2 points
- **Complex keywords:** "refactor", "migrate", "integrate", "cross-package" → 3 points
- **Critical keywords:** "security", "auth", "payment", "production" → 4+ points

**Scope assessment:**
- Single-file indicators: "in file", "this file", "the function" → 0 points
- Multi-file indicators: "multiple files", "across files" → +2 points
- Cross-package indicators: "cross-package", "common and server" → +3 points

#### Stage 3: Quantitative Assessment (When Target Files Known)

**File metrics scoring:**
```typescript
// File count scoring
1 file = 0 points, 2-3 files = +1, 4-7 files = +2, 8+ files = +3

// Lines of code scoring
>500 lines = +1, >1000 lines = +2

// Function complexity
>10 functions = +1, >20 functions = +2

// Cross-package penalty
Multiple packages = +3

// Code health (from CodeScene)
Health < 5 = +3, Health 5-7 = +2, Healthy = 0

// Git history signals
Change hotspots (>10 commits) = +1 per file
Bug-prone files (>2 fix commits) = +2 per file
High churn (avg >5 changes) = +1
```

#### Model Tier Assignment

**Haiku (Fast + Cheap: ~$0.25 per 1K input tokens):**
- **Score:** 0-1 points
- **Examples:** typos, comments, version bumps, single-file fixes
- **File scope:** Single file, healthy code
- **Best for:** Trivial maintenance tasks

**Sonnet (Balanced: ~$3 per 1K input tokens):**
- **Score:** 2-6 points
- **Examples:** feature implementation, bug fixes, test additions
- **File scope:** 2-5 files, standard complexity
- **Best for:** Most development tasks

**Opus (Capable: ~$15 per 1K input tokens):**
- **Score:** 7+ points
- **Examples:** refactoring, security changes, architecture work
- **File scope:** 5+ files, cross-package changes
- **Best for:** Complex reasoning, critical systems

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

### Task Decomposition & Model Assignment

**Atomicity Check (`checkAndDecompose` - uses Haiku):**
- Assesses if task is atomic or needs breaking down
- **Decomposition triggers:**
  * Multiple distinct objectives in description
  * Cross-package changes detected
  * >5 estimated files affected
  * Complex compound tasks

**Execution Order (Cost Optimization):**
```typescript
// Process tasks by model tier for cost efficiency
modelOrder = ["haiku", "sonnet", "opus"]
for (tier of modelOrder) {
  await processTasksWithModel(tier)
}
```

**Grind mode task flow:**
1. Load all pending tasks from task board
2. Run decomposition check on each task
3. Group tasks by recommended model tier
4. Execute haiku tasks first (cheapest)
5. Then sonnet tasks (moderate cost)
6. Finally opus tasks (most expensive)

## Escalation Strategy

### Automatic Escalation Triggers

**Within-task escalation (SoloOrchestrator):**
1. **No Changes Made:** Immediate escalation (agent is stuck)
2. **Verification Failures:**
   - TypeScript errors → escalate after 1-2 retries
   - Test failures → escalate after 1-2 retries
   - Build errors → escalate after 1-2 retries
   - Lint-only errors → allow full retries (often fixable)
3. **Scope Underestimation:**
   - Single-file assessment → task touches 3+ files
   - Few-files assessment → task touches 10+ files
4. **Max Retries Exceeded:** Escalate to next tier

**Escalation path:** `haiku → sonnet → opus → fail`

### Retry vs Escalation Configuration

```typescript
// From SoloOrchestrator options
{
  maxRetriesPerTier: 3,        // Retries at same tier before escalating
  maxReviewPassesPerTier: 2,   // Review passes per tier
  maxOpusReviewPasses: 6       // Opus gets more attempts (final tier)
}
```

**Decision logic:**
```typescript
function shouldEscalate(attempt: AttemptResult): boolean {
  // No changes made → immediate escalation
  if (attempt.filesChanged === 0) return true;

  // Error type determines retry strategy
  if (attempt.hasTypeErrors || attempt.hasBuildErrors || attempt.hasTestFailures) {
    return attempt.retryCount >= maxRetriesPerTier - 1; // Faster escalation
  }

  // Lint-only errors get full retries
  return attempt.retryCount >= maxRetriesPerTier;
}
```

### Manual Escalation Options

```bash
# Force specific starting model
undercity grind "complex task" --model opus

# Enable escalating review passes (default: enabled)
undercity grind --review

# Disable review (for quick iteration)
undercity grind --no-review

# Use supervised mode (Opus orchestrates workers)
undercity solo --supervised --worker sonnet
```

### Post-Completion Escalation

**shouldEscalateToFullChain() triggers:**
- Type or build errors remain
- Scope was significantly underestimated
- Large changes (>200 lines) without tests
- Task complexity was "complex" or "critical"

**Review passes (when --review enabled):**
1. **Haiku Review:** Quick syntax/style check
2. **Sonnet Review:** Comprehensive logic review
3. **Opus Review:** Architectural review + edge cases

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

### Parallelism Decision Matrix

| Task Characteristics | Recommended Parallelism | Reasoning |
|----------------------|------------------------|-----------|
| Independent bug fixes | `--parallel 3-5` | No file conflicts expected |
| Different packages | `--parallel 3-5` | Isolated changes |
| Documentation updates | `--parallel 5` | No code conflicts |
| Feature development | `--parallel 1-3` | Moderate risk of conflicts |
| Refactoring tasks | `--parallel 1` | High conflict probability |
| Database migrations | `--parallel 1` | Sequential dependency |
| Security changes | `--parallel 1` | Critical, needs careful review |
| Breaking changes | `--parallel 1` | System-wide impact |

### Parallelism Configuration

```bash
# Conservative (sequential)
undercity grind --parallel 1

# Moderate (default)
undercity grind --parallel 3

# Aggressive (maximum throughput)
undercity grind --parallel 5

# Direct task (always parallel=1)
undercity grind "specific goal"
```

### Conflict Detection & Resolution

**Pre-merge conflict detection (FileTracker):**
```typescript
// Detects file conflicts before merge attempt
interface FileConflict {
  path: string;
  touchedBy: Array<{
    agentId: string;
    stepId: string;
    operation: FileOperation;
    timestamp: Date;
  }>;
}
```

**Conflict resolution strategies:**
- **Warning level:** Log conflict, proceed with caution
- **Error level:** Serialize conflicting tasks
- **Critical level:** Fail task, require manual intervention

**Safe parallel execution indicators:**
- Tasks target different packages (`src/common` vs `src/pyserver`)
- Different file types (tests vs implementation vs docs)
- Independent feature areas (auth vs billing vs UI)
- Pure additions (no modifications)

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
undercity grind "fix typo" --model opus  # Waste $15+ on $0.25 task

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

## Decision Tree Summary

```
Task Input
    ↓
Local Tool Check (canHandleWithLocalTools)
    ↓ (if no match)
Fast Complexity Assessment (assessComplexityFast)
    ↓
High confidence? → Use assessment
    ↓ (if low confidence)
Deep Assessment (assessComplexityDeep - uses Haiku)
    ↓
Target Files Known? → Quantitative Assessment
    ↓
Decomposition Check (checkAndDecompose)
    ↓
Route to Model Tier:
    Score 0-1: haiku
    Score 2-6: sonnet
    Score 7+:  opus
    ↓
Parallelism Decision:
    Single task → maxConcurrent = 1
    Multiple tasks → Check conflicts → Set parallelism
    ↓
Execute with Verification Pipeline
    ↓
Escalate on failures (haiku → sonnet → opus)
    ↓
Review if enabled (--review flag)
    ↓
Merge via MergeQueue (serial queue)
    ↓
Manual push when ready
```

## Usage Examples by Scenario

### Single Task Execution
```bash
# Quick fix
undercity grind "fix authentication timeout"

# Complex architectural work
undercity grind "refactor auth system for multi-tenant" --model opus --review

# Force specific model (override complexity assessment)
undercity grind "simple task" --model opus  # Usually not recommended
```

### Task Board Processing
```bash
# Add multiple tasks
undercity add "fix user profile bug"
undercity add "add email validation"
undercity add "update documentation"

# Process with moderate parallelism
undercity grind --parallel 3

# Conservative batch processing
undercity grind --parallel 1 --review
```

### Emergency Workflows
```bash
# Production hotfix (force opus, sequential)
undercity grind "fix critical security vulnerability" --model opus --parallel 1

# Bulk maintenance (high parallelism)
undercity add "fix all TypeScript strict errors"
undercity grind --parallel 5 --no-decompose
```

This decision matrix provides comprehensive guidance for routing decisions in Undercity, optimizing for efficiency, safety, and code quality while minimizing costs.