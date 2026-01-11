# Undercity

| Attribute | Value |
|-----------|-------|
| Purpose | Multi-agent task orchestrator for autonomous task execution |
| Runtime | Node.js 24+ |
| Authentication | `ANTHROPIC_API_KEY` required |
| Package Manager | pnpm |
| CLI Global Name | undercity |

## Core Features

| Feature | Implementation | State File |
|---------|----------------|------------|
| Task Board | Queue with priorities/dependencies | `.undercity/tasks.json` |
| Parallel Execution | Isolated git worktrees | `.undercity/worktrees.json` |
| Model Routing | haiku → sonnet → opus by complexity | `.undercity/metrics.json` |
| Crash Recovery | Auto-resume interrupted batches | `.undercity/recovery.json` |
| Rate Limiting | 429 handling + exponential backoff | `.undercity/rate-limit.json` |
| Merge Queue | Serial git merge pipeline | `.undercity/elevator.json` |

## Installation

```bash
git clone https://github.com/justinstimatze/undercity.git
cd undercity
pnpm install && pnpm build
ln -sf $(pwd)/bin/undercity.js ~/.local/bin/undercity
```

## Commands

### Task Management

| Command | Behavior | State Change |
|---------|----------|--------------|
| `undercity add "task"` | Add to task board | Appends to `tasks.json` |
| `undercity tasks` | List all tasks | Read-only |
| `undercity tasks pending` | Show pending only | Read-only |
| `undercity load <file>` | Bulk add from file (one per line) | Appends multiple to `tasks.json` |

### Execution

| Command | Behavior | Parallelism | Recovery |
|---------|----------|-------------|----------|
| `undercity grind` | Process task board | Default: 1 | Auto-resume |
| `undercity grind "goal"` | Single task directly | N/A | N/A |
| `undercity grind -n 5` | Process 5 tasks max | Default: 1 | Auto-resume |
| `undercity grind --parallel 3` | Max 3 concurrent | 1-5 | Auto-resume |

### Monitoring

| Command | Data Source | Output Format |
|---------|-------------|---------------|
| `undercity limits` | `rate-limit.json` + `metrics.json` | Human summary |
| `undercity watch` | Live TUI | Matrix-style dashboard |
| `undercity status` | `grind-events.jsonl` | JSON (agent-optimized) |

### Planning

| Command | Input | Behavior |
|---------|-------|----------|
| `undercity import-plan <file>` | Markdown plan | Extract steps → task board |
| `undercity plan <file>` | Markdown plan | Execute with context |
| `undercity plan <file> -c` | Markdown plan | Continuous execution |

### Infrastructure

| Command | Purpose | Dependencies |
|---------|---------|--------------|
| `undercity init` | Setup in new repo | Creates `.undercity/`, `.gitignore` entry |
| `undercity serve -p 7331` | HTTP daemon | None |
| `undercity daemon status` | Check daemon | Running daemon |
| `undercity setup` | Verify auth | `ANTHROPIC_API_KEY` |

## Model Routing

| Complexity | Model | Use Cases | Token Cost |
|------------|-------|-----------|------------|
| Simple | haiku | Docs, typos, single-file changes | Lowest |
| Medium | sonnet | Features, refactoring, multi-file | Medium |
| Complex | opus | Architecture, critical debugging | Highest |

| Property | Value |
|----------|-------|
| Assessment | `src/task-decomposer.ts` |
| Execution order | haiku → sonnet → opus (cheapest first) |
| On failure | Auto-escalate to next tier |

## State Files

| File | Purpose | Format | Persistence |
|------|---------|--------|-------------|
| `tasks.json` | Task board | Array of Task objects | Git tracked |
| `worktrees.json` | Active worktrees | taskId → {path, branch} | Runtime only |
| `elevator.json` | Merge queue | Array of ElevatorItem | Runtime only |
| `recovery.json` | Crash recovery | {batchId, tasks, checkpoint} | Runtime only |
| `rate-limit.json` | Rate limit state | {pausedUntil, history} | Persistent |
| `metrics.json` | Token usage/cost | {byModel, total, queries} | Persistent |
| `grind-events.jsonl` | Event log | One JSON event per line | Append-only |

## Task Execution Flow

```
Task Board → Complexity Assessment → Model Assignment → Worktree Creation →
AI Execution → Verification Loop → Merge Queue → Serial Merge →
Task Complete
```

| Step | File | Failure Action |
|------|------|----------------|
| Complexity Assessment | `task-decomposer.ts` | Decompose into subtasks |
| Worktree Creation | `worktree-manager.ts` | Log error, skip task |
| AI Execution | `parallel-solo.ts` | Retry with escalation |
| Verification | Built-in hooks | Fix attempt → escalation |
| Merge | `git.ts` Elevator | 3 retry strategies |

## Verification Loop

| Check | Command | Failure Handling |
|-------|---------|------------------|
| Typecheck | `pnpm typecheck` | Fix attempt → escalation |
| Tests | `pnpm test` | Fix attempt → escalation |
| Lint | `pnpm lint` | Fix attempt → escalation |
| Build | `pnpm build` | Fix attempt → escalation |

| Escalation | Path |
|------------|------|
| Step 1 | Retry with same model |
| Step 2 | Escalate to higher tier |
| Step 3 | Escalate to opus |
| Step 4 | Human notification |

## Configuration

| Source | Priority | Format | Example |
|--------|----------|--------|---------|
| CLI flags | 1 (highest) | `--flag value` | `--parallel 3` |
| `.undercityrc` (cwd) | 2 | JSON | `{"parallel": 3}` |
| `~/.undercityrc` | 3 | JSON | `{"model": "sonnet"}` |
| Built-in defaults | 4 (lowest) | Hardcoded | `parallel: 1` |

| Environment Variable | Required | Values |
|---------------------|----------|--------|
| `ANTHROPIC_API_KEY` | Yes | `sk-ant-...` |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error` |

## Error Recovery

| Scenario | Detection | Recovery Action |
|----------|-----------|----------------|
| Grind crash | `recovery.json` exists | Auto-resume on next `grind` |
| Rate limit hit | 429 response | Pause + exponential backoff |
| Git conflict | Pre-merge file check | Task fails, manual resolution |
| Verification failure | Hook exit code | Fix attempt → escalation |
| Worktree leak | Manual check | `git worktree prune` |

## Development

| Command | Purpose |
|---------|---------|
| `pnpm build` | Compile TypeScript |
| `pnpm test` | Run tests |
| `pnpm lint` | Check code style |
| `pnpm semantic-check` | Analyze semantic density |

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI entry point |
| `src/commands/` | Command implementations |
| `src/parallel-solo.ts` | Main orchestrator |
| `src/task.ts` | Task board CRUD |
| `src/git.ts` | Git operations |
| `src/types.ts` | Core types |

## Output Modes

| Context | Mode | Format |
|---------|------|--------|
| TTY (human) | human | Colored, formatted |
| Pipe (agent) | agent | Structured JSON |
| `--human` flag | human | Force human mode |
| `--agent` flag | agent | Force agent mode |

## Daemon Mode

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/status` | GET | Session/agent/task summary |
| `/tasks` | GET | Full task board |
| `/tasks` | POST | Add task `{"objective": "..."}` |
| `/metrics` | GET | Usage metrics |
| `/pause` | POST | Pause grind |
| `/resume` | POST | Resume grind |
| `/stop` | POST | Stop daemon |

| Operation | Command |
|-----------|---------|
| Start | `undercity serve -p 7331` |
| Status | `undercity daemon status` |

## Rate Limits

| Limit | Window | Action at 95% |
|-------|--------|---------------|
| 1M tokens | 5 hours | Auto-pause |
| 5M tokens | 1 week | Auto-pause |

| Operation | Command |
|-----------|---------|
| Check | `undercity limits` |
| Monitor | `undercity watch` |
