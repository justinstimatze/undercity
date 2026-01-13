# Undercity

Multi-agent orchestrator for autonomous task execution. Processes tasks from board with verification, crash recovery, and parallel execution.

## Core Concepts

**Task Board** (`.undercity/tasks.json`):
- Queue of work items with priorities
- Add via `undercity add "task description"`
- Persists across runs

**Grind** (main execution mode):
- Autonomous task processing
- Parallel execution in isolated git worktrees
- Model routing by complexity (haiku → sonnet → opus)
- Built-in verification (typecheck, test, lint)
- Crash recovery from `.undercity/parallel-recovery.json`

**Workers**:
- SDK agents executing in worktrees
- No direct push access (orchestrator controls merges)
- Verification loop before commit

## Basic Commands

```bash
# Task board (ALWAYS use CLI, never edit tasks.json directly)
undercity add "task description"           # Add task
undercity add "task" --priority 5          # Add with priority
undercity tasks                            # List all tasks
undercity tasks --status pending           # Filter by status
undercity tasks --status complete          # Show completed
undercity tasks --tag context              # Filter by tag
undercity tasks --all                      # Show all (not just 10)
undercity tasks --count 20                 # Show first 20
undercity complete <task-id>               # Mark task complete
undercity reconcile                        # Mark duplicate/done tasks complete

# Autonomous execution
undercity grind                            # Process all tasks
undercity grind -n 10                      # Process 10 tasks
undercity grind --parallel 3               # Max 3 concurrent
undercity grind --dry-run                  # Show what would run without executing

# Monitoring
undercity status                           # Current state
undercity watch                            # Live dashboard
undercity limits                           # Rate limit status

# Daemon (for overnight)
pnpm daemon:start                          # Start HTTP daemon
pnpm daemon:status                         # Check status
pnpm daemon:logs                           # View logs
```

## Task Execution Flow

```
Task Board (.undercity/tasks.json)
    ↓
Grind picks task → Assess complexity
    ↓
Route to model tier:
    - Simple (haiku): typos, docs, trivial fixes
    - Medium (sonnet): features, refactoring, most code
    - Complex (opus): architecture, critical bugs
    ↓
Create worktree (.undercity/worktrees/task-{id}/)
    ↓
Worker executes → Verification loop
    ↓
    ├─ typecheck fails? → Fix or escalate
    ├─ tests fail? → Fix or escalate
    ├─ lint fails? → Fix or escalate
    └─ All pass → Commit to worktree
    ↓
Queue for merge → MergeQueue processes serially
    ↓
Rebase onto local main → Verify → Fast-forward merge
    ↓
Task marked complete
```

## Persistence Files

| File | Purpose | When Used |
|------|---------|-----------|
| `tasks.json` | Task board | Always (tracked in git) |
| `pocket.json` | Active session state | During execution |
| `parallel-recovery.json` | Crash recovery state | During parallel execution |
| `rate-limit-state.json` | Token usage tracking | Always |
| `grind-events.jsonl` | Execution audit log | During grind |
| `worktree-state.json` | Active worktree tracking | During parallel execution |

## Model Routing

Tasks routed by complexity assessment:

**Haiku** (fast, cheap):
- Documentation updates
- Typo fixes
- Simple refactoring
- Test additions (non-complex)

**Sonnet** (balanced):
- Feature implementation
- Bug fixes
- Refactoring with logic changes
- Most standard tasks

**Opus** (expensive, capable):
- Architecture changes
- Complex debugging
- Critical path changes
- Security-sensitive code

## Verification Loop

Every task goes through:
1. **Typecheck** (`pnpm typecheck`)
2. **Tests** (`pnpm test`)
3. **Lint** (`pnpm lint`)
4. **Build** (`pnpm build`)

Failures trigger:
- Immediate fix attempt (same model)
- Escalation (haiku → sonnet → opus)
- User notification (after max retries)

## Crash Recovery

If grind crashes:
```bash
undercity grind  # Auto-resumes from parallel-recovery.json
```

Recovery state includes:
- Tasks in progress
- Worktree paths
- Partial results
- Error context

## Rate Limiting

Conservative defaults:
- 1M tokens per 5 hours
- 5M tokens per week
- Auto-pause at 95% usage
- Resume when usage drops

Check status: `undercity limits`

## Worktree Isolation

Each task runs in isolated worktree:
- Branch from local main HEAD
- No conflicts with other tasks
- Merge serially via MergeQueue
- Push blocked (orchestrator controls)

Benefits:
- True parallelism
- No git conflicts
- Clean rollback per task
- Verification in isolation

## Interactive vs Autonomous

**Interactive (dispatch mode)**:
- Add tasks to board
- Monitor progress
- Quick fixes (trivial changes)
- Coordination, not execution

**Autonomous (grind mode)**:
- Process task board
- Parallel execution
- Verification loops
- Persistent state

Default: Add to board, let grind execute.

## Dependencies

Prefer established libraries over custom implementations.

**Check before installing:**
- npm downloads (popularity)
- Last publish date (maintained)
- GitHub stars/issues
- Publisher reputation
- Package name spelling (typosquatting risk)

**Avoid:**
- Unmaintained packages (2+ years stale)
- Suspicious names/typos
- Trivial utilities (left-pad syndrome)

## Agent-Optimized Docs

Documentation should optimize for agent efficiency:

**Good:**
- Decision trees
- File → behavior mappings
- Exact commands for common tasks
- Gotchas and edge cases upfront

**Bad:**
- Marketing prose
- Motivation/history
- Long explanations of "why"
- Human-friendly formatting over clarity

Agents can infer intent - provide facts and mappings.

## Task Reconciliation

**When to use `undercity reconcile`:**
- After manual commits that completed tasks outside grind
- When task board has duplicates or stale entries
- Before starting a fresh grind session
- After importing tasks from an external source

**How it works:**
1. Scans recent git history (default: 100 commits)
2. Matches commit messages against pending task keywords
3. Marks matched tasks as complete automatically

```bash
undercity reconcile              # Auto-mark completed tasks
undercity reconcile --dry-run    # Preview without changes
undercity reconcile --lookback 50  # Search last 50 commits
```

**Typical workflow:**
```bash
# You completed work manually, now sync the board
undercity reconcile --dry-run    # See what would be marked
undercity reconcile              # Apply the changes
undercity tasks                  # Verify board state
```

## When NOT to Use Undercity

Skip undercity for:
- Simple questions or explanations
- Single-file trivial changes (typos)
- Quick interactive debugging
- Tasks not worth verification overhead
