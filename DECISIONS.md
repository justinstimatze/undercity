# Undercity Decision Framework

**When to use what, when to escalate, and how routing works.**

## Command Selection

### `solo` vs `grind` vs `work`

| Command | Use Case | Execution Mode | Status |
|---------|----------|----------------|---------|
| `solo <goal>` | **DEPRECATED** - single task with adaptive escalation | Sequential | Use `grind` instead |
| `grind [goal]` | **RECOMMENDED** - autonomous task processing | Parallel | Main production command |
| `grind <goal>` | Single task execution (direct goal) | Parallel (concurrency=1) | Quick single-task execution |
| `grind` | Process task board | Parallel | Batch processing mode |
| `work` | **LEGACY** - continuous backlog processing | Sequential | Use `grind` instead |

**Decision rule:** Always use `grind`. It handles both single tasks and batches with superior infrastructure.

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

#### Haiku (Fast, Cheap: ~$0.01 per 1K tokens)
- **File deletions, moves, renames**
- **Simple edits (typos, comments, formatting)**
- **Documentation updates**
- **Import organization**
- **Test additions (non-complex)**

**Signals:** Single file, clear objective, `fix typo`, `update comment`, `format code`

#### Sonnet (Balanced: ~$0.15 per 1K tokens)
- **Feature implementation**
- **Bug fixes with logic changes**
- **Moderate refactoring**
- **Most standard development tasks**
- **Multi-file changes (2-5 files)**

**Signals:** `implement`, `add feature`, `fix bug`, moderate scope

#### Opus (Expensive, Capable: ~$0.75 per 1K tokens)
- **Architectural changes**
- **Cross-package integration**
- **Security-sensitive code**
- **Complex debugging**
- **Breaking API changes**
- **Database migrations**

**Signals:** `refactor`, `architecture`, `security`, `auth`, `migration`, cross-package scope

### Model Routing Logic

1. **Task Decomposition Check** (`task-decomposer.ts`)
   - Uses Haiku for fast complexity assessment (~500 tokens)
   - If task is **atomic** → proceed with recommended model
   - If task is **complex** → decompose into subtasks

2. **Quantitative Assessment** (`complexity.ts`)
   - Analyzes target files when available
   - Considers: file count, LOC, function count, Git history
   - Overrides keyword-based assessment with hard metrics

3. **Execution Order**
   - Tasks grouped by model tier: **haiku → sonnet → opus**
   - Cheapest models run first for cost efficiency

## Escalation Strategy

### When Tasks Escalate

**Automatic escalation triggers:**
- Verification failures (typecheck, test, lint, build)
- High error count from current model
- Scope underestimation (single-file task touches 5+ files)

**Escalation path:** `haiku → sonnet → opus`

### Escalation Decision Matrix

| Current Model | Escalate When | Next Model |
|---------------|---------------|------------|
| Haiku | Type errors, test failures, touches 3+ files | Sonnet |
| Sonnet | Architecture errors, complex bugs, integration failures | Opus |
| Opus | **No escalation** - human intervention required | Manual review |

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

### Review Passes (Optional)

```bash
undercity grind --review  # Enable escalating review
```

**Review chain:** haiku review → sonnet review → opus review
- Independent agents review code without writing it
- Inspired by Zeroshot paper: reviewers can't lie about test results
- Higher-tier models provide architectural feedback

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

### When to Use Supervised Mode

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