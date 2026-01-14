# Undercity

Multi-agent orchestrator with learning. Processes tasks from board with verification, crash recovery, parallel execution, and knowledge compounding.

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
- Knowledge injection from past tasks
- Pattern-based file suggestions

**Workers**:
- SDK agents executing in worktrees (Claude Max OAuth)
- No direct push access (orchestrator controls merges)
- Verification loop before commit

**Learning Systems**:
- Knowledge compounding (`.undercity/knowledge.json`)
- Decision tracking (`.undercity/decisions.json`)
- Task→file patterns (`.undercity/task-file-patterns.json`)
- Error→fix patterns (`.undercity/error-fix-patterns.json`)
- Self-tuning routing (`.undercity/routing-profile.json`)

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
undercity complete <task-id> --reason "Already implemented"  # With explanation
undercity reconcile                        # Mark duplicate/done tasks complete

# Autonomous execution
undercity grind                            # Process all tasks
undercity grind -n 10                      # Process 10 tasks
undercity grind --parallel 3               # Max 3 concurrent
undercity grind --dry-run                  # Show what would run without executing

# Monitoring
undercity status                           # Current state (JSON default)
undercity pulse                            # Quick state: workers, queue, health
undercity brief                            # Narrative summary
undercity watch                            # Live TUI dashboard
undercity limits                           # Local rate limit state
undercity usage                            # Live Claude Max usage from claude.ai
undercity usage --login                    # One-time browser auth setup

# Learning & intelligence
undercity knowledge "query"                # Search accumulated learnings
undercity knowledge --stats                # Knowledge base statistics
undercity decide                           # View pending decisions
undercity decide --resolve <id> --decision "choice"  # Resolve decision
undercity patterns                         # Task→file correlations, risks
undercity prime-patterns                   # Seed patterns from git history
undercity tuning                           # View learned routing profile
undercity introspect                       # Analyze own metrics
undercity decisions                        # Decision tracking stats
undercity decisions --process              # Have PM process pending

# Analysis
undercity metrics                          # Performance metrics
undercity complexity-metrics               # Success by complexity
undercity insights                         # Routing recommendations
undercity semantic-check                   # Semantic density analysis

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

| File | Purpose | Tracked |
|------|---------|---------|
| `tasks.json` | Task board | Yes |
| `knowledge.json` | Accumulated learnings | No |
| `decisions.json` | Decision history | No |
| `task-file-patterns.json` | Task→file correlations | No |
| `error-fix-patterns.json` | Error→fix patterns | No |
| `routing-profile.json` | Learned routing | No |
| `parallel-recovery.json` | Crash recovery | No |
| `rate-limit-state.json` | Rate limit state | No |
| `live-metrics.json` | Token usage | No |
| `grind-events.jsonl` | Event log (append) | No |
| `worktree-state.json` | Active worktrees | No |
| `ast-index.json` | Symbol index | No |
| `ax-training.json` | Ax/DSPy examples | No |

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

Dynamic pacing based on live Claude Max usage:
- Fetches real-time limits from claude.ai (`undercity usage`)
- Auto-pauses when approaching limits
- Resumes when headroom available
- Usage cached 5 minutes

First-time setup: `undercity usage --login` (one-time browser auth)

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
