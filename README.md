# Undercity

Autonomous coding orchestrator built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

## Usage

```bash
undercity solo "Fix the auth bug"     # Single task, adaptive model
undercity grind                        # Batch process task board
```

**The core loop:**
```
┌─────────────────────────────────────────────────────────────────┐
│  Task → Agent → Verify → Commit (or Escalate)                   │
│                                                                  │
│  Verification: biome → typecheck → build → tests                │
│                                                                  │
│  Escalation:   haiku ──┬──> sonnet ──┬──> opus                  │
│                        │             │                           │
│                  post-mortem   post-mortem                       │
│                   analysis      analysis                         │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

```bash
git clone https://github.com/anthropics/undercity.git
cd undercity
pnpm install && pnpm build
ln -sf $(pwd)/bin/undercity.js ~/.local/bin/undercity
```

Requires Node.js 24+ and either Claude Max subscription or `ANTHROPIC_API_KEY`.

## Commands

### Solo Mode (Single Task)

```bash
undercity solo "Add dark mode toggle"
undercity solo "Fix the null check" --stream
undercity solo "Refactor auth module" --model opus
```

### Grind Mode (Batch Processing)

```bash
undercity grind                 # Process all tasks
undercity grind -n 5            # Process 5 tasks then stop
undercity grind -p 3            # Run 3 tasks concurrently
undercity grind --no-commit     # Don't auto-commit on success
```

### Task Board

```bash
undercity task add "Fix the login bug"
undercity tasks                  # List all tasks
undercity task clear             # Remove completed tasks
```

### Metrics

```bash
undercity metrics
```

## How It Works

### Complexity Routing

Tasks are analyzed and routed to the cheapest capable model:

| Complexity | Model | Use Case |
|------------|-------|----------|
| Trivial/Simple | Haiku | Fast, cheap tasks |
| Standard | Sonnet | Balanced |
| Complex/Critical | Opus | Best quality |

### Verification Loop

Every commit runs:
```bash
pnpm check       # biome lint + format
pnpm build       # typecheck + compile
pnpm test        # vitest
```

If verification fails, agent retries. After 3 attempts, escalates to next model tier.

### Worktree Isolation

All tasks run in isolated git worktrees:
1. Creates worktree per task
2. Each task gets its own branch
3. Successful branches merge serially (rebase → verify → merge)
4. Worktrees cleaned up after completion

## Configuration

```bash
# API key (pay per use)
export ANTHROPIC_API_KEY=sk-ant-...

# Claude Max (subscription)
export CLAUDE_CODE_OAUTH_TOKEN=...
```

Task board location: `.undercity/tasks.json`

## Architecture

```
undercity/
├── src/
│   ├── solo.ts           # Core task execution with escalation
│   ├── parallel-solo.ts  # Parallel execution via worktrees
│   ├── worktree-manager.ts # Git worktree isolation
│   ├── complexity.ts     # Task analysis and routing
│   ├── context.ts        # Pre-flight briefing generation
│   ├── task.ts           # Task board CRUD
│   └── cli.ts            # Command interface
└── .undercity/
    ├── tasks.json        # Task board
    ├── metrics.jsonl     # Performance history
    ├── worktrees/        # Isolated worktrees
    └── logs/             # Agent activity
```

### Agent Types

Cheapest capable model for each role:

| Type | Model | Purpose |
|------|-------|---------|
| scout | Haiku | Fast reconnaissance, read-only |
| planner | Sonnet | Specification writing |
| builder | Sonnet | Code implementation |
| reviewer | Opus | Quality assurance (final gate) |

## License

MIT
