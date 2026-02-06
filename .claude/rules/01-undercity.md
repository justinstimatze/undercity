---
paths:
  - src/commands/**
  - src/cli.ts
  - bin/**
---

# Undercity

Multi-agent orchestrator with learning. Processes tasks from board with verification, crash recovery, parallel execution, and knowledge compounding.

## Core Concepts

**Task Board** (`.undercity/undercity.db` SQLite):
- Queue of work items with priorities
- Add via `undercity add "task description"`
- Persists across runs in SQLite database

**Grind** (main execution mode):
- Autonomous task processing with auto-refinement
- Parallel execution in isolated git worktrees
- Model routing by complexity (sonnet -> opus)
- Built-in verification (typecheck, test, lint)
- Crash recovery, knowledge injection, pattern-based file suggestions

**Workers**: SDK agents in worktrees (Claude Max OAuth). No push access. Verification loop before commit.

**Learning Systems**: Knowledge compounding, decision tracking, task-file patterns, error-fix patterns, self-tuning routing. Details in ADRs and codebase map.

**Automated PM**: Resolves decisions inline during plan review. Generates tasks via web research + codebase analysis. Use when board is empty or exploring new directions.

## Basic Commands

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
undercity grind --continuous --duration 6h # Auto-propose when board empties, stop after 6h
undercity grind --continuous "perf"        # Continuous with topic focus
undercity drain                            # Graceful stop: finish current, start no more

# PM (research and task generation)
undercity pm "topic" --ideate              # Full ideation: research + propose
undercity pm "topic" --research            # Web research on a topic
undercity pm --propose                     # Generate tasks from codebase analysis
undercity pm "topic" --ideate --add        # Add proposals to board

# Plans
undercity plans --list                     # List linked plans
undercity plans my-plan.md --status        # Show progress bar + task status
undercity plans my-plan.md --link "task-123,task-456"

# Monitoring
undercity status                           # Session summary
undercity usage                            # Claude Max usage
undercity watch                            # TUI dashboard (htop-style)
undercity usage --login                    # One-time browser auth

# Learning & Intelligence
undercity knowledge "query"                # Search accumulated learnings
undercity patterns                         # View all learning patterns
undercity decide                           # View/resolve pending decisions

# RAG
undercity rag index <file-or-dir>          # Index file or directory
undercity rag search "query"               # Hybrid search (vector + keyword)
undercity rag list                         # List indexed documents
undercity rag stats                        # Show index statistics

# Analysis
undercity postmortem                       # Analyze last grind
undercity grind --postmortem               # Auto-run postmortem after grind
undercity metrics                          # Performance overview
undercity introspect                       # Self-analysis
undercity effectiveness                    # Learning systems effectiveness

# Experiments
undercity experiment list                  # List experiments
undercity experiment create <name>         # Create with variants
undercity experiment results               # View per-variant metrics
undercity experiment recommend             # Get statistical winner

# Board management
undercity reconcile                        # Sync completed tasks with git
undercity triage                           # Analyze board health
undercity prune                            # Remove stale/duplicate tasks
undercity refine                           # Enrich tasks with rich content
undercity refine --all                     # Refine all tasks
undercity maintain                         # Auto: triage -> prune -> refine
undercity maintain --dry-run               # Preview maintenance actions

# Daemon
pnpm daemon:start                          # Start HTTP daemon
pnpm daemon:status                         # Check status
pnpm daemon:logs                           # View logs
```

## Command Decision Tree

**"Is grind running?"** -> `undercity status` or `undercity watch`
**"How much usage left?"** -> `undercity usage`
**"What went wrong?"** -> `undercity postmortem` or `undercity status --events`
**"What should I work on?"** -> `undercity pm --propose`
**"Tasks need more context?"** -> `undercity refine` or `undercity refine --all`
**"Board maintenance needed?"** -> `undercity maintain`
**"Overnight autonomous run?"** -> `undercity grind --continuous --duration 6h --parallel 3`

## Persistence Files

| File | Purpose | Tracked |
|------|---------|---------|
| `undercity.db` | Task board (SQLite) | No |
| `knowledge.json` | Accumulated learnings | No |
| `decisions.json` | Decision history | No |
| `task-file-patterns.json` | Task-file correlations | No |
| `error-fix-patterns.json` | Error-fix patterns | No |
| `routing-profile.json` | Learned routing | No |
| `parallel-recovery.json` | Crash recovery | No |
| `rate-limit-state.json` | Rate limit state | No |
| `live-metrics.json` | Token usage | No |
| `grind-events.jsonl` | Event log (append) | No |
| `worktree-state.json` | Active worktrees | No |
| `ast-index.json` | Symbol index | No |
| `rag.db` | RAG SQLite database | No |

## Model Routing

**Sonnet** (default): Most tasks - features, bugs, refactoring, docs.
**Opus 4.6** (premium): Architecture changes, complex debugging, critical path, security-sensitive.

## Crash Recovery

If grind crashes: `undercity grind` auto-resumes from `parallel-recovery.json`.

## Rate Limiting

Dynamic pacing from live Claude Max usage. Auto-pauses near limits. First-time: `undercity usage --login`.

## When NOT to Use Undercity

Skip for: simple questions, single-file typos, quick interactive debugging, tasks not worth verification overhead.
