# Undercity

Undercity is a multi-agent orchestrator for parallel task execution. It manages a task board and runs multiple Claude agents in isolated git worktrees to complete tasks concurrently.

## Quick Reference

```bash
undercity tasks                    # View task board
undercity tasks add "description"  # Add a task
undercity grind                    # Run tasks (default: 1 task, sequential)
undercity grind --parallel 3       # Run 3 agents in parallel
undercity grind -n 5               # Process up to 5 tasks total
undercity grind --parallel 3 -n 10 # 3 parallel agents, 10 tasks max
undercity watch                    # Monitor running grind session
undercity drain                    # Graceful stop: finish current, start no more
```

## Task Board

Tasks live in `.undercity/tasks.json`. Each task has:
- `id`: Unique identifier
- `objective`: What needs to be done
- `status`: pending | in_progress | complete | failed
- `priority`: Lower number = higher priority
- `tags`: Optional categorization (bugfix, feature, refactor, critical)
- `packageHints`: Optional hints about which packages are affected
- `estimatedFiles`: Optional list of files likely to be modified

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

## Adding Tasks Programmatically

You can add tasks directly to `.undercity/tasks.json` or use the CLI:

```bash
# Single task
undercity tasks add "Fix authentication timeout in login flow"

# With priority (lower = higher priority)
undercity tasks add "Critical security fix" --priority 0

# Multiple tasks (edit tasks.json directly)
```

## Editing Tasks

To update a task's objective or properties, use jq:

```bash
# Update objective
cat .undercity/tasks.json | jq '(.tasks[] | select(.id == "task-xxx")) |= . + {objective: "New objective"}' > /tmp/tasks.json && mv /tmp/tasks.json .undercity/tasks.json

# Update tags
cat .undercity/tasks.json | jq '(.tasks[] | select(.id == "task-xxx")) |= . + {tags: ["feature", "critical"]}' > /tmp/tasks.json && mv /tmp/tasks.json .undercity/tasks.json

# Delete a task
cat .undercity/tasks.json | jq '.tasks |= map(select(.id != "task-xxx"))' > /tmp/tasks.json && mv /tmp/tasks.json .undercity/tasks.json
```

To find a task ID, use: `cat .undercity/tasks.json | jq '.tasks[] | {id, objective}'`

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

## File Locking

The task board uses file locking to prevent race conditions. Multiple processes can safely read/write `tasks.json` concurrently without losing changes.
