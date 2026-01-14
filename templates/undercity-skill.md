# Undercity

Undercity is a multi-agent orchestrator for parallel task execution. It manages a task board and runs multiple Claude agents in isolated git worktrees to complete tasks concurrently.

## Quick Reference

```bash
# Task board
undercity tasks                    # View task board
undercity add "description"        # Add a task
undercity complete <task-id>       # Mark task complete manually

# Execution
undercity grind                    # Run tasks (default: 1 task, sequential)
undercity grind --parallel 3       # Run 3 agents in parallel
undercity grind -n 5               # Process up to 5 tasks total
undercity watch                    # Monitor running grind session

# Proactive PM (task generation)
undercity pm --propose             # Generate tasks from codebase analysis
undercity pm "topic" --research    # Research a topic via web search
undercity pm "topic" --ideate      # Full session: research + propose
undercity pm "topic" --ideate --add # Add generated tasks to board
```

## When to Use PM Commands

Use `undercity pm` when:
- **Board is empty**: Generate tasks from codebase analysis with `--propose`
- **New direction**: Research a topic before adding tasks with `--research`
- **Feature planning**: Full ideation session with `--ideate`
- **User asks**: "what should we work on?" or "generate tasks for X"

The PM uses web research, codebase analysis, and past patterns to generate relevant, actionable tasks.

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

## Recovery

If a grind session crashes:
- State is preserved in `.undercity/parallel-recovery.json`
- Worktrees remain in `.undercity/worktrees/`
- Running `undercity grind` will offer to resume or clean up

## File Locking

The task board uses file locking to prevent race conditions. Multiple processes can safely read/write `tasks.json` concurrently without losing changes.
