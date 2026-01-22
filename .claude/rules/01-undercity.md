# Undercity

Multi-agent orchestrator with learning. Processes tasks from board with verification, crash recovery, parallel execution, and knowledge compounding.

## Core Concepts

**Task Board** (`.undercity/undercity.db` SQLite):
- Queue of work items with priorities
- Add via `undercity add "task description"`
- Persists across runs in SQLite database

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
# Task board (ALWAYS use CLI, never edit database directly)
undercity add "task description"           # Add task
undercity add "task" --priority 5          # Add with priority
undercity add "x" --from-file ticket.yaml  # Add from ticket file (YAML/JSON/MD)
undercity add "x" --from-file plan.md      # Add Claude Code plan as task
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

**Plan-task linkage** (cross-reference Claude Code plans with undercity tasks):
```bash
# List plans linked to this project
undercity plans --list                     # Project-specific plans
undercity plans --list --project           # All plans in ~/.claude/plans/

# View plan status with task completion progress
undercity plans my-plan.md --status        # Show progress bar + task status

# Link tasks to a plan (stores task IDs in plan frontmatter)
undercity plans my-plan.md --link "task-123,task-456"

# Unlink tasks from a plan
undercity plans my-plan.md --unlink "task-123"

# Mark plan as complete
undercity plans my-plan.md --complete
```

**Monitoring** (choose ONE based on need):
```bash
# Quick checks (pick one)
undercity status                           # Session summary: running/complete/failed counts
undercity usage                            # Claude Max usage from claude.ai (external API)

# Live monitoring
undercity watch                            # TUI dashboard (htop-style, real-time)

# First-time setup
undercity usage --login                    # One-time browser auth for usage tracking
```

**Learning & Intelligence**:
```bash
undercity knowledge "query"                # Search accumulated learnings
undercity patterns                         # View all learning patterns (files, errors, decisions)
undercity decide                           # View/resolve pending decisions
```

**RAG (Retrieval-Augmented Generation)**:
```bash
# Index content for semantic search
undercity rag index <file-or-dir>          # Index file or directory
undercity rag index <file> --recursive     # Recursive directory indexing
undercity rag index <file> --source docs   # Tag with source category

# Search indexed content
undercity rag search "query"               # Hybrid search (vector + keyword)
undercity rag search "query" --limit 10    # Limit results
undercity rag search "query" --source code # Filter by source

# Manage indexed documents
undercity rag list                         # List all indexed documents
undercity rag list --source docs           # Filter by source
undercity rag stats                        # Show index statistics
undercity rag remove <document-id>         # Remove document from index
```

**Analysis & Post-Mortem** (run after grind or periodically):
```bash
undercity postmortem                       # Analyze last grind: failures, recommendations
undercity postmortem --json                # Machine-readable output
undercity grind --postmortem               # Auto-run postmortem after grind
undercity metrics                          # Performance overview
undercity introspect                       # Self-analysis: success rates, routing, escalation
undercity insights                         # Routing recommendations from historical data
undercity effectiveness                    # Measure learning systems effectiveness
```

**A/B Testing (Experiments)**:
```bash
undercity experiment list                  # List all experiments
undercity experiment create <name>         # Create experiment with variants
undercity experiment create <name> --preset model-comparison  # Use preset
undercity experiment activate <id>         # Activate for data collection
undercity experiment results               # View per-variant metrics
undercity experiment recommend             # Get statistical winner recommendation
```

**Task board management**:
```bash
undercity reconcile                        # Mark done tasks as complete (syncs with git)
undercity triage                           # Analyze board for issues (persists to tasks)
undercity prune                            # Remove stale/duplicate tasks
undercity refine                           # Enrich tasks with rich ticket content
undercity refine <taskId>                  # Refine specific task
undercity refine --all                     # Refine all tasks needing enrichment
undercity maintain                         # Auto: triage → prune → refine until healthy
undercity maintain --dry-run               # Preview maintenance actions
undercity tasks --issues                   # Show tasks with triage issues
undercity tasks --issue-type duplicate     # Filter by specific issue type
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

## Command Decision Tree

**"Is grind running?"** → `undercity status` or `undercity watch`
**"How much usage left?"** → `undercity usage`
**"What went wrong?"** → `undercity postmortem` (after grind) or `undercity status --events`
**"Why did task X fail?"** → `undercity knowledge "task X error"`
**"What should I work on?"** → `undercity pm --propose`
**"Is my code healthy?"** → `undercity metrics` then `undercity introspect`
**"How do I improve?"** → `undercity postmortem` → follow recommendations
**"Are learning systems helping?"** → `undercity effectiveness`
**"Which model routing works best?"** → `undercity experiment results` or `undercity experiment recommend`
**"Find similar past work?"** → `undercity rag search "topic"`
**"Index documentation?"** → `undercity rag index ./docs --recursive`
**"Tasks need more context?"** → `undercity refine` or `undercity refine --all`
**"Board maintenance needed?"** → `undercity maintain` (autonomous triage → prune → refine)
**"Manual board cleanup?"** → `undercity triage` → `undercity prune` → `undercity refine`

## Learning Systems Integration

Undercity has 5 learning systems that compound knowledge across tasks:

| System | Stored In | When Updated | When Used |
|--------|-----------|--------------|-----------|
| **Knowledge Base** | `knowledge.json` | After task completion | Planning, PM decisions, worker context |
| **Task→File Patterns** | `task-file-patterns.json` | After task completion | File predictions, conflict detection |
| **Error→Fix Patterns** | `error-fix-patterns.json` | After verification failures | Auto-remediation hints |
| **Decision Patterns** | `decisions.json` | During planning/execution | PM decision resolution |
| **Capability Ledger** | `routing-profile.json` | After task completion | Model routing recommendations |
| **RAG Index** | `rag.db` | Auto-indexed on learning/decision + explicit | Semantic search, PM context |

**How they connect:**
1. Worker completes task → Records knowledge + patterns + ledger updates + auto-indexes to RAG
2. New task starts → Injects relevant knowledge + file predictions into context
3. Planning phase → PM uses knowledge + decisions + RAG semantic search to resolve questions
4. Decision resolved → Auto-indexes decision context to RAG for future retrieval
5. Verification fails → Checks error-fix patterns for known solutions
6. Model routing → Uses ledger to pick optimal model for task type

**MCP Knowledge Tools** (JSON-RPC 2.0 via `POST /mcp`):
```bash
# List available tools
curl -X POST http://localhost:7331/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Search knowledge base
curl -X POST http://localhost:7331/mcp -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"knowledge_search","arguments":{"query":"validation patterns"}}}'
```

Tools: `knowledge_search`, `knowledge_add`, `knowledge_stats`, `knowledge_mark_used`

## Meta Learning Loop

Undercity improves itself through a continuous feedback loop:

```
┌─────────────────────────────────────────────────────────────────┐
│                         GRIND SESSION                           │
│  Tasks execute → Successes/failures recorded → Patterns saved   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                         POST-MORTEM                             │
│  undercity postmortem analyzes:                                 │
│  • Failure breakdown (planning, tests, typecheck, no_changes)   │
│  • Success rate by task type                                    │
│  • Token efficiency                                             │
│  → Generates actionable recommendations                         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      SYSTEM ADAPTATION                          │
│  Recommendations trigger improvements:                          │
│  • Plan specificity validation (catches vague plans early)      │
│  • Test task routing (sonnet minimum, extra retries)            │
│  • Model routing adjustments (capability ledger)                │
│  • Error-fix pattern additions                                  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                    Next grind benefits from learnings

```

**Postmortem output example:**
```
📊 Grind Post-Mortem

Summary
  Tasks: 50 completed / 6 failed
  Success Rate: 89.3%

Failure Breakdown
  planning: 2
  verification_tests: 3
  no_changes: 1

Recommendations
  2 task(s) failed in planning phase. Consider:
    - Breaking vague tasks into specific subtasks
  3 task(s) failed test verification. Consider:
    - Test tasks now route to sonnet minimum
```

**Workflow:**
```bash
undercity grind --postmortem    # Run grind + auto-analyze
# OR
undercity grind                 # Run grind
undercity postmortem            # Analyze separately
```

## Proactive Health Checks

**When to run `undercity effectiveness`:**
- After completing 20+ tasks (enough data for meaningful analysis)
- When success rate drops unexpectedly
- Before major overnight grind runs
- Periodically (weekly) to monitor learning system health

**What it tells you:**
- File prediction accuracy (are we suggesting the right files?)
- Knowledge injection correlation (is knowledge helping or hurting?)
- Review ROI (are we spending tokens wisely on review?)

**When to run `undercity experiment`:**
- Testing new model routing strategies
- Comparing review vs no-review approaches
- Validating that haiku can handle certain task types
- A/B testing prompt modifications

**Typical experiment workflow:**
```bash
undercity experiment create "haiku-vs-sonnet" --variants haiku,sonnet
undercity experiment activate <exp-id>
undercity grind -n 30              # Run tasks to collect data
undercity experiment results       # Check per-variant metrics
undercity experiment recommend     # Get statistical recommendation
```

## Task Execution Flow

```
Task Board (.undercity/undercity.db)
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
| `undercity.db` | Task board (SQLite) | No |
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
| `rag.db` | RAG SQLite database (vectors + FTS5) | No |

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

## Board Maintenance Trilogy

Three commands for maintaining a healthy task board:

| Command | Purpose | What it does |
|---------|---------|--------------|
| `triage` | Analyze | Find duplicates, stale tasks, status bugs, ticket coverage |
| `prune` | Clean | Remove test cruft, fix status inconsistencies |
| `refine` | Enrich | Add rich ticket content (description, acceptance criteria) |

**When to use each:**
- **triage first** - always start here to see board health and ticket coverage
- **prune second** - fix issues triage identified (status bugs, duplicates, cruft)
- **refine third** - enrich tasks once the board is clean

**Triage output includes:**
- Health Score (0-100%)
- Ticket Coverage (% of tasks with rich tickets)
- Issue breakdown by type
- Actionable recommendations (including when to refine)

**Typical maintenance workflow:**
```bash
# 1. Analyze the board - this tells you what to do next
undercity triage                 # Shows health, ticket coverage, recommendations

# 2. Clean up cruft (if triage recommends it)
undercity prune --dry-run        # Preview removals
undercity prune                  # Apply cleanup

# 3. Enrich remaining tasks (if ticket coverage is low)
undercity refine --dry-run       # Preview refinements
undercity refine                 # Apply enrichment (default: 10 tasks)
undercity refine --all           # Refine all tasks needing content
```

**When to use `undercity refine`:**
- After importing tasks from external sources (single-line objectives)
- Before a major grind session (give workers more context)
- When success rate is low (tasks may lack sufficient guidance)
- After `triage` and `prune` to enrich the cleaned board

**What refine generates:**
- **Description**: Expanded explanation of the task
- **Acceptance criteria**: Specific conditions for "done"
- **Test plan**: How to verify completion
- **Implementation notes**: Approach hints, patterns to follow
- **Rationale**: Why the task matters

**Options:**
```bash
undercity refine                 # Refine up to 10 tasks
undercity refine -n 20           # Refine up to 20 tasks
undercity refine <taskId>        # Refine specific task
undercity refine --all           # Refine all tasks (no limit)
undercity refine --force         # Re-refine even if already has content
undercity refine --dry-run       # Preview without saving
```

## Plan-Task Linkage

Cross-reference Claude Code plan files (`~/.claude/plans/*.md`) with undercity tasks.

**How it works:**
1. Plans store task IDs in YAML frontmatter
2. Links are bidirectional (plan → tasks, task → plan)
3. Progress calculated from linked task completion status

**Frontmatter format** (added/updated by `undercity plans`):
```yaml
---
undercity:
  tasks: ["task-abc123", "task-def456"]
  project: /home/user/myproject
  linkedAt: 2026-01-18T12:00:00.000Z
  status: implementing
---

# My Plan Title
...
```

**Status values:**
| Status | Meaning |
|--------|---------|
| `draft` | Plan not yet approved |
| `approved` | Plan approved, not started |
| `implementing` | Tasks being executed |
| `complete` | All linked tasks done |

**When to use:**
- Working on a Claude Code plan that maps to multiple undercity tasks
- Want to track plan completion via task status
- Need to see which plan a task belongs to

**Example workflow (manual task creation):**
```bash
# Create plan in Claude Code (generates ~/.claude/plans/my-feature.md)

# Break plan into tasks
undercity add "Implement X from my-feature plan"
undercity add "Implement Y from my-feature plan"

# Link tasks to plan
undercity plans my-feature.md --link "task-abc,task-def"

# Check progress
undercity plans my-feature.md --status
# Shows: [████████░░░░░░░░░░░░] 50%

# After tasks complete via grind
undercity plans my-feature.md --complete
```

**Example workflow (auto-decomposition):**
```bash
# Create plan in Claude Code plan mode
# Plan saved to ~/.claude/plans/my-feature.md

# Dispatch entire plan to undercity (auto-decomposes into subtasks)
undercity add "x" --from-file ~/.claude/plans/my-feature.md

# Grind picks up the plan, decomposes into atomic subtasks, executes
undercity grind
```

The `--from-file` workflow:
1. Loads the plan file (markdown body becomes ticket description)
2. During grind, decomposer sees the full plan context (not just objective)
3. Intelligently breaks into atomic subtasks based on phases/sections
4. Subtasks execute in parallel with verification

## When NOT to Use Undercity

Skip undercity for:
- Simple questions or explanations
- Single-file trivial changes (typos)
- Quick interactive debugging
- Tasks not worth verification overhead
