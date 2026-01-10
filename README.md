# Undercity

> *"It only has to make sense for me."*
> — Tamara, on her 365 buttons

Autonomous coding orchestrator built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Inspired by [Gas Town](https://github.com/steveyegge/gastown) but designed for solo developers who want autonomous coding without the overhead.

## What Actually Works

After experimenting with multi-agent pipelines (flutes, questers, sheriffs, etc.), the system converged on something simpler and more effective:

```
undercity solo "Fix the auth bug"     # Single task, adaptive model
undercity grind                        # Batch process quest board
```

**The core loop:**
```
┌─────────────────────────────────────────────────────────┐
│  Task → Agent → Verify → Commit (or Escalate)          │
│                                                         │
│  Verification: biome → typecheck → build → tests       │
│                                                         │
│  Escalation:   haiku ──┬──> sonnet ──┬──> opus         │
│                        │             │                  │
│                  post-mortem   post-mortem              │
│                   analysis      analysis                │
└─────────────────────────────────────────────────────────┘
```

1. **Complexity routing**: Task analyzed, routed to cheapest capable model
2. **Verification loop**: Every change must pass biome, typecheck, build, tests
3. **Adaptive escalation**: If verification fails, escalate to smarter model
4. **Post-mortem on escalation**: Failed tier explains what went wrong
5. **Git cleanup**: Dirty state cleaned between tasks (no cascade failures)

## Installation

```bash
git clone https://github.com/justinstimatze/undercity.git
cd undercity
pnpm install && pnpm build
ln -sf $(pwd)/bin/undercity.js ~/.local/bin/undercity
```

Requires Node.js 24+ and either Claude Max subscription or `ANTHROPIC_API_KEY`.

## Usage

### Solo Mode (Single Task)

```bash
# Basic - routes to appropriate model automatically
undercity solo "Add dark mode toggle"

# Watch the agent work
undercity solo "Fix the null check" --stream

# Specific model (skip complexity routing)
undercity solo "Refactor auth module" --model opus
```

### Grind Mode (Batch Processing)

```bash
# Process quest board automatically
undercity grind

# Limit number of quests
undercity grind --limit 5

# Just show what would run
undercity grind --dry-run
```

### Quest Board

```bash
# Add quests
undercity quest add "Fix the login bug"
undercity quest add "[feature] Add export to CSV"

# List quests
undercity quests

# Clear completed
undercity quest clear
```

### Metrics & Improvement

```bash
# View performance metrics
undercity metrics

# Generate improvement quests from metrics
undercity improve
```

## How It Works

### Complexity Routing

Tasks are analyzed for complexity signals:

| Signal | Points | Example |
|--------|--------|---------|
| Multiple files | +2 | "Update auth across services" |
| New feature | +2 | "Add dark mode" |
| Refactoring | +2 | "Extract helper functions" |
| Simple fix | -1 | "Fix typo" |

**Routing:**
- Low complexity → Haiku (fast, cheap)
- Medium → Sonnet (balanced)
- High → Opus (best quality)

### Verification Loop

Every commit attempt runs:

```bash
pnpm check       # biome lint + format
pnpm build       # typecheck + compile
pnpm test        # vitest
```

If any step fails, agent gets feedback and retries. After 3 attempts at current tier, escalates to next model.

### Post-Mortem Analysis

When escalating (haiku→sonnet or sonnet→opus), the failed tier provides a quick analysis:

> "I tried adding a new function but didn't realize this module uses a class pattern. The type errors suggest I should extend the existing class instead. The next attempt should look at how similar features are implemented."

This helps the next tier avoid the same mistake.

### Git Cleanup

After each failed task, working directory is reset:

```bash
git checkout -- .  # Revert changes
git clean -fd      # Remove untracked files
```

This prevents cascade failures where one task's mess breaks subsequent tasks.

## Configuration

### Authentication

```bash
# API key (pay per use)
export ANTHROPIC_API_KEY=sk-ant-...

# Claude Max (subscription)
export CLAUDE_CODE_OAUTH_TOKEN=...
```

Run `undercity setup` to verify.

### Quest Board Location

Default: `.undercity/quests.json`

```bash
undercity --directory /other/project grind
```

## Architecture

```
undercity/
├── src/
│   ├── solo.ts           # Core task execution with escalation
│   ├── grind.ts          # Batch processing
│   ├── complexity.ts     # Task routing
│   ├── context.ts        # Pre-flight briefing generation
│   ├── verification.ts   # biome/typecheck/build/test runner
│   └── cli.ts            # Command interface
└── .undercity/
    ├── quests.json       # Quest board
    ├── metrics.jsonl     # Performance history
    └── logs/             # Agent activity
```

## Legacy: The Raid Model

The original design used extraction shooter metaphors (raids, flutes, questers, sheriffs). While fun to build, the multi-agent coordination added complexity without proportional benefit.

**What we kept:**
- Quest terminology (tasks → quests)
- GUPP principle ("If work exists, continue it")
- Persistence (crash recovery)

**What we simplified:**
- No planning/execution phases (just do the work)
- No multiple agent types (one agent, multiple model tiers)
- No elevator/merge queue (direct commits)

The themed commands still exist (`undercity slingshot`, etc.) but `solo` and `grind` are the recommended path.

## Philosophy

| Principle | Implementation |
|-----------|----------------|
| Start cheap | Haiku first, escalate only when needed |
| Verify everything | No commit without passing verification |
| Learn from failure | Post-mortem analysis guides retries |
| Clean slate | Git cleanup prevents cascade failures |
| Measure what matters | Metrics track what actually works |

## Credits

**Looted from:**
- **Gas Town** (Steve Yegge): GUPP principle, persistence philosophy
- **Jeffrey Emanuel**: Rule of Five (via Gas Town)
- **Beads** (Steve Yegge): Git-backed state

**Extraction shooter theme** from ARC Raiders - because it's fun, even if the raid model got simplified.

## License

MIT
