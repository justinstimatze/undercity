# Undercity: Multi-Agent Autonomous Task Orchestrator

| Property | Value |
|----------|-------|
| Purpose | Multi-agent autonomous task orchestrator |
| Runtime | Node.js 24+ |
| Auth | `ANTHROPIC_API_KEY` required |
| Package Manager | pnpm |
| CLI Command | `undercity` |

## Core Capabilities

| Capability | Implementation | State File |
|------------|----------------|------------|
| Task Management | Priority queuing | `.undercity/tasks.json` |
| Parallel Execution | Isolated git worktrees | `.undercity/worktrees.json` |
| Model Routing | Complexity-based model selection | `.undercity/metrics.json` |
| Crash Recovery | Auto-resume batch | `.undercity/recovery.json` |
| Rate Limiting | Exponential backoff | `.undercity/rate-limit.json` |
| Merge Pipeline | Serial git merge | In-memory (MergeQueue) |

## Quick Setup

```bash
git clone https://github.com/justinstimatze/undercity.git
cd undercity
pnpm install && pnpm build
ln -sf $(pwd)/bin/undercity.js ~/.local/bin/undercity
```

## Task Operations

| Command | Behavior | State Impact |
|---------|----------|--------------|
| `undercity add "task"` | Add task | Append to `tasks.json` |
| `undercity tasks` | List tasks | Read-only |
| `undercity tasks pending` | Show pending | Read-only |
| `undercity load <file>` | Bulk import | Append multiple tasks |

## Execution Modes

| Command | Parallelism | Recovery | Scope |
|---------|-------------|----------|-------|
| `undercity grind` | 1 task | Auto-resume | Task board |
| `undercity grind "goal"` | Single task | N/A | Direct execution |
| `undercity grind -n 5` | 1 task | Auto-resume | Max 5 tasks |
| `undercity grind --parallel 3` | 1-5 tasks | Auto-resume | Concurrent |

## Planning Commands

| Command | Input | Behavior |
|---------|-------|----------|
| `undercity import-plan <file>` | Markdown | Extract task steps |
| `undercity plan <file>` | Markdown | Execute with context |
| `undercity plan <file> -c` | Markdown | Continuous execution |

## Infrastructure Commands

| Command | Purpose |
|---------|---------|
| `undercity init` | Setup `.undercity/` |
| `undercity serve -p 7331` | Start HTTP daemon |
| `undercity daemon status` | Check daemon |
| `undercity setup` | Verify API key |

## Model Routing Strategy

| Complexity | Model | Use Cases | Token Cost |
|------------|-------|-----------|------------|
| Simple | haiku | Docs, typos | Lowest |
| Medium | sonnet | Features, refactoring | Medium |
| Complex | opus | Architecture, critical bugs | Highest |

## Verification Stages

| Stage | Command | Failure Handling |
|-------|---------|-----------------|
| Typecheck | `pnpm typecheck` | Fix → Escalate |
| Tests | `pnpm test` | Fix → Escalate |
| Lint | `pnpm lint` | Fix → Escalate |
| Build | `pnpm build` | Fix → Escalate |

## Escalation Path

| Step | Action |
|------|--------|
| 1 | Retry with same model |
| 2 | Escalate: haiku → sonnet → opus |
| 3 | Human notification |

## Configuration Precedence

| Source | Priority | Format | Example |
|--------|----------|--------|---------|
| CLI flags | Highest | `--flag value` | `--parallel 3` |
| `.undercityrc` (cwd) | 2 | JSON | `{"parallel": 3}` |
| `~/.undercityrc` | 3 | JSON | `{"model": "sonnet"}` |
| Built-in defaults | Lowest | Hardcoded | `parallel: 1` |

## Runtime Configuration

| Env Var | Required | Values |
|---------|----------|--------|
| `ANTHROPIC_API_KEY` | Yes | API key |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error` |

## Error Recovery Strategies

| Scenario | Detection | Action |
|----------|-----------|--------|
| Grind interruption | `recovery.json` exists | Auto-resume |
| Rate limit | 429 response | Pause + backoff |
| Git conflict | Pre-merge check | Manual resolve |
| Verification fail | Hook exit code | Fix → Escalate |
| Worktree leak | `git worktree list` | `git worktree prune` |

## Monitoring Commands

| Command | Data Source | Output |
|---------|-------------|--------|
| `undercity limits` | Rate/metrics JSON | Usage summary |
| `undercity watch` | Live state | TUI dashboard |
| `undercity status` | Event log | JSON status |

## State Files

| File | Purpose | Persistence |
|------|---------|-------------|
| `tasks.json` | Task board | Git tracked |
| `worktree-state.json` | Active worktrees | Runtime |
| `parallel-recovery.json` | Crash recovery | Runtime |
| `rate-limit.json` | Rate limit state | Persistent |
| `metrics.json` | Token usage/cost | Persistent |
| `grind-events.jsonl` | Event log | Append-only |

## Development Commands

| Command | Purpose |
|---------|---------|
| `pnpm build` | Compile TypeScript |
| `pnpm test` | Run tests |
| `pnpm lint` | Check code style |
| `pnpm typecheck` | Type check |
| `pnpm semantic-check` | Analyze semantic density |

## Output Modes

| Context | Mode | Format |
|---------|------|--------|
| TTY (terminal) | human | Colored, formatted |
| Pipe (agent) | agent | Structured JSON |
| `--human` flag | human | Force human mode |
| `--agent` flag | agent | Force agent mode |

## Daemon Mode Commands

| Command | Purpose |
|---------|---------|
| `pnpm daemon:start` | Start daemon |
| `pnpm daemon:status` | Check status |
| `pnpm daemon:logs` | View logs |

## Daemon HTTP Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/status` | GET | Session/agent/task summary |
| `/tasks` | GET | Full task board |
| `/tasks` | POST | Add task `{"objective": "..."}` |
| `/metrics` | GET | Usage metrics |
| `/pause` | POST | Pause grind |
| `/resume` | POST | Resume grind |
| `/stop` | POST | Stop daemon |

## Rate Limits

| Limit | Window | Threshold |
|-------|--------|-----------|
| 1M tokens | 5 hours | Pause at 95% |
| 5M tokens | 1 week | Pause at 95% |