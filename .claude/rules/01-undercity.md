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

**Automated PM**:
- Resolves decisions during plan review (inline, not deferred)
- Generates novel tasks via web research and codebase analysis
- Uses past decisions + knowledge for context
- Escalates only truly ambiguous decisions to human

## When to Use PM Commands

**Use `undercity pm` when:**
- Task board is empty and user wants suggestions → `undercity pm --propose`
- User asks "what should we work on?" → `undercity pm --propose`
- User wants to explore a new feature/direction → `undercity pm "topic" --ideate`
- User asks about best practices for X → `undercity pm "X best practices" --research`
- User says "research X" or "generate tasks for X" → `undercity pm "X" --ideate --add`

**Grind auto-suggests PM** when board is empty.

## Basic Commands

**Primary commands** (Claude Code should use these):
```bash
# Task board (ALWAYS use CLI, never edit tasks.json directly)
undercity add "task description"           # Add task
undercity add "task" --priority 5          # Add with priority
undercity tasks                            # List pending tasks
undercity tasks --status complete          # Show completed
undercity complete <task-id>               # Mark task complete manually

# Autonomous execution
undercity grind                            # Process all tasks
undercity grind -n 10                      # Process 10 tasks
undercity grind --parallel 3               # Max 3 concurrent
undercity drain                            # Graceful stop: finish current, start no more

# Proactive PM (research and task generation)
undercity pm "topic" --ideate              # Full ideation: research + propose
undercity pm "topic" --research            # Web research on a topic
undercity pm --propose                     # Generate tasks from codebase analysis
undercity pm "topic" --ideate --add        # Add proposals to board
```

**Secondary commands** (debugging, inspection):
```bash
# Monitoring
undercity status                           # Current state (JSON)
undercity watch                            # Live TUI dashboard
undercity usage                            # Claude Max usage from claude.ai
undercity usage --login                    # One-time browser auth setup

# Learning & intelligence
undercity knowledge "query"                # Search accumulated learnings
undercity decide                           # View/resolve pending decisions
undercity patterns                         # Task→file correlations
undercity tuning                           # View learned routing profile
undercity introspect                       # Analyze own metrics

# Analysis
undercity metrics                          # Performance metrics
undercity insights                         # Routing recommendations
undercity semantic-check                   # Semantic density analysis

# Task board management
undercity reconcile                        # Mark done tasks as complete
undercity triage                           # Analyze board for issues
undercity prune                            # Remove stale/duplicate tasks
```

**Auto-chained** (happens automatically, no command needed):
- Usage check before grind starts
- Pattern priming from git history (if empty)
- Knowledge injection during planning
- PM resolution of open questions in plans
- Pattern/knowledge recording after completion
- Empty board detection with PM suggestion

**Daemon** (for overnight runs):
```bash
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
Pre-execution planning (tiered):
    ├─ Haiku creates plan (files, steps, risks)
    ├─ PM resolves open questions inline
    └─ Sonnet/Opus reviews plan
    ↓
Route to model tier:
    - Simple (haiku): typos, docs, trivial fixes
    - Medium (sonnet): features, refactoring, most code
    - Complex (opus): architecture, critical bugs
    ↓
Create worktree (.undercity/worktrees/task-{id}/)
    ↓
Worker executes with validated plan → Verification loop
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
Task marked complete → Record learnings
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
