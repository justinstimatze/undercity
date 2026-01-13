---
name: undercity
description: Dispatch tasks to the undercity orchestrator for autonomous batch execution. Use when adding tasks, checking status, or running parallel work. Ideal for multi-task workloads that benefit from autonomous verification.
allowed-tools: Bash(node ./bin/undercity.js:*), Bash(pnpm start:*)
---

# Undercity Task Orchestrator

Dispatch work to undercity for autonomous, parallel execution with built-in verification (typecheck, test, lint).

## When to Use Undercity

**Good fit:**
- Multi-step tasks that can run independently
- Batch refactoring across many files
- Work that benefits from verification loops
- Tasks to run overnight/in background

**Skip undercity for:**
- Single quick fixes (do directly)
- Questions/explanations
- Exploratory debugging

## Commands

### Add a Task

```bash
node ./bin/undercity.js add "task description"
```

Examples:
```bash
node ./bin/undercity.js add "Fix all TypeScript strict null check errors in src/"
node ./bin/undercity.js add "Add JSDoc comments to all exported functions"
node ./bin/undercity.js add "Migrate deprecated API calls to v2"
```

### Check Task Board

```bash
# All tasks
node ./bin/undercity.js tasks

# Only pending
node ./bin/undercity.js tasks pending

# Only completed
node ./bin/undercity.js tasks complete
```

### Start Autonomous Execution

```bash
# Process all pending tasks
node ./bin/undercity.js grind

# Limit concurrent workers
node ./bin/undercity.js grind --parallel 2

# Process specific number of tasks
node ./bin/undercity.js grind -n 5
```

### Monitor Progress

```bash
# Live TUI dashboard
node ./bin/undercity.js watch

# Current status snapshot
node ./bin/undercity.js status

# Rate limit status
node ./bin/undercity.js limits
```

## Workflow Patterns

### Batch Task Setup
Add multiple related tasks, then let grind handle them:
```bash
node ./bin/undercity.js add "Migrate UserService to new auth pattern"
node ./bin/undercity.js add "Migrate OrderService to new auth pattern"
node ./bin/undercity.js add "Migrate PaymentService to new auth pattern"
node ./bin/undercity.js grind --parallel 3
```

### Conservative Execution
For careful work, run single-threaded:
```bash
node ./bin/undercity.js grind --parallel 1
```

### Check Before Starting
Always verify what's queued:
```bash
node ./bin/undercity.js tasks pending
```

## Task Description Guidelines

Write clear, actionable task descriptions:

**Good:**
- "Fix TypeScript error TS2345 in src/api/client.ts"
- "Add input validation to all POST endpoints in src/routes/"
- "Replace deprecated lodash _.pluck with _.map"

**Vague (avoid):**
- "Fix bugs" (which bugs?)
- "Improve performance" (where? how?)
- "Clean up code" (too broad)

## Output Modes

Undercity auto-detects output format:
- **TTY**: Human-friendly with colors
- **Pipe**: Machine-readable JSON

Force a mode:
```bash
node ./bin/undercity.js tasks --human
node ./bin/undercity.js tasks --agent
```

## Important Notes

- Tasks execute in isolated git worktrees
- All changes verified (typecheck, test, lint) before commit
- Tasks merge to main serially (no conflicts)
- Failed tasks can be retried with model escalation
- Check `node ./bin/undercity.js limits` before large batches
