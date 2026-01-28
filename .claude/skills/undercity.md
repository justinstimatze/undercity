# Undercity

Undercity is a multi-agent orchestrator for parallel task execution. It manages a task board and runs multiple Claude agents in isolated git worktrees to complete tasks concurrently with automatic verification and learning.

## Quick Reference

```bash
# Task management
undercity tasks                    # View task board
undercity add "description"        # Add a task
undercity add "task" -p 100        # Add with priority (lower = higher)
undercity remove <task-id>         # Remove a task

# Execution
undercity grind                    # Run tasks (default: 1 task)
undercity grind --parallel 3       # Run 3 agents in parallel
undercity grind -n 5               # Process up to 5 tasks total
undercity grind --parallel 3 -n 10 # 3 parallel agents, 10 tasks max
undercity drain                    # Graceful stop: finish current, start no more

# Plan Handoff (single command)
undercity dispatch plan.md         # Import plan + start grind (3 parallel)
undercity dispatch plan.md --parallel 5  # Custom parallelism
undercity dispatch plan.md --dry-run     # Preview without executing

# Monitoring
undercity watch                    # Live TUI dashboard
undercity status                   # Grind session status (JSON)
undercity usage                    # Live Claude Max usage from claude.ai

# Learning & intelligence
undercity knowledge "query"        # Search accumulated learnings
undercity decide                   # View pending decisions
undercity patterns                 # Task→file correlations
```

## Task Board

Tasks are stored in SQLite (`.undercity/undercity.db`). Each task has:
- `id`: Unique identifier
- `objective`: What needs to be done
- `status`: pending | in_progress | complete | failed
- `priority`: Lower number = higher priority
- `tags`: Optional categorization (bugfix, feature, refactor, critical)
- `packageHints`: Optional hints about which packages are affected
- `estimatedFiles`: Optional list of files likely to be modified

**Always use CLI commands to manage tasks** - never edit the database directly.

## Writing Good Task Descriptions

**Do:**
- Be specific about what to change: "Add retry logic to `src/api/client.ts` fetchUser function"
- Include file paths when known: "Fix null check in `src/utils/parser.ts:45`"
- Specify expected behavior: "Function should return empty array instead of throwing on invalid input"
- Use action verbs: Add, Fix, Update, Remove, Refactor

**Don't:**
- Be vague: "Fix the bug" or "Improve performance"
- Self-reference undercity internals (agents can't modify their own orchestrator)
- Combine unrelated changes in one task
- Assume context from other tasks

**Task Types (use tags):**
- `bugfix`: Fix a specific bug
- `feature`: Add new functionality
- `refactor`: Restructure without changing behavior
- `critical`: High priority, run first
- `deletion`: Remove code/files (be explicit: "Delete `src/old/` directory using git rm")

## Plan Handoff

When you have a Claude Code plan with multiple independent steps, use `dispatch` for seamless handoff to undercity:

```bash
# Single command replaces: import-plan + grind
undercity dispatch ~/.claude/plans/my-plan.md --parallel 3

# Preview what would be dispatched
undercity dispatch my-plan.md --dry-run

# Limit to first N tasks
undercity dispatch my-plan.md -n 5 --parallel 3
```

**Workflow:**
1. Create/approve plan in Claude Code (generates `~/.claude/plans/my-plan.md`)
2. Dispatch to undercity: `undercity dispatch ~/.claude/plans/my-plan.md`
3. Monitor progress: `undercity watch`

This replaces manual multi-tab parallel work with automated orchestration.

## How Grind Works

1. **Task Selection**: Picks pending tasks by priority, avoiding file/package conflicts
2. **Worktree Isolation**: Each agent works in an isolated git worktree on its own branch
3. **Parallel Execution**: Multiple agents run simultaneously without interfering
4. **Review & Merge**: Completed work is reviewed, rebased, and merged to main
5. **Cleanup**: Worktrees are removed after successful merge

## Checking Status

```bash
undercity watch          # Live dashboard of running tasks
undercity tasks          # Current task board state
cat .undercity/parallel-recovery.json  # Details of current/last grind run
```

## Adding Tasks

Use the CLI to manage tasks:

```bash
# Single task
undercity add "Fix authentication timeout in login flow"

# With priority (lower = higher priority)
undercity add "Critical security fix" --priority 0

# With context file (JSON with handoff data)
undercity add "Implement feature X" --context handoff.json

# Bulk import from file (one task per line)
undercity load tasks.txt
```

## Managing Tasks

```bash
# List all tasks
undercity tasks

# List pending tasks only
undercity tasks --status pending

# Remove a task
undercity remove <task-id>

# View tasks by status
undercity tasks --status pending
```

## Marking Tasks Complete

```bash
# Mark a task as complete
undercity complete <task-id>

# With resolution notes (what was done)
undercity complete <task-id> --resolution "Implemented in commit abc123"

# With reason (why it's being closed - alias for --resolution)
undercity complete <task-id> --reason "Already implemented"
undercity complete <task-id> --reason "Deferred to next sprint"
undercity complete <task-id> --reason "No longer needed"
```

Use `--reason` for explaining why a task is being closed (obsolete, deferred, duplicate).
Use `--resolution` for explaining how it was completed (implemented, merged, etc.).

## Graceful Shutdown (Drain)

To stop a running grind without interrupting current tasks:

```bash
undercity drain                    # Finish current tasks, start no more
undercity daemon drain             # Same, via daemon action
curl -X POST localhost:7331/drain  # Same, via HTTP API
```

The drain signal:
1. Lets in-progress tasks complete normally
2. Skips all remaining pending tasks
3. Exits cleanly after current work finishes

Use this when you need to interrupt a long grind session gracefully.

## Recovery

If a grind session crashes:
- State is preserved in `.undercity/parallel-recovery.json`
- Worktrees remain in `.undercity/worktrees/`
- Running `undercity grind` will offer to resume or clean up

## Database Locking

The task board uses SQLite with WAL mode for concurrent access. Multiple processes can safely read/write tasks concurrently without race conditions.
