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

# Run quests in parallel (isolated worktrees)
undercity grind --parallel 3
```

### Worktree Isolation (Default)

All tasks run in isolated git worktrees by default. This keeps your working directory clean and enables parallelism.

```bash
undercity grind                 # Process all quests (1 at a time, isolated)
undercity grind -p 3            # Process 3 quests concurrently
undercity grind -n 5 -p 2       # Process 5 quests, 2 at a time
undercity grind --sequential    # Legacy mode (no worktree isolation)
```

**How it works:**
1. Creates isolated git worktree for each task
2. Each task gets its own branch
3. Runs concurrently (up to `-p` limit)
4. Successful branches merge serially (rebase → verify → merge)
5. Worktrees cleaned up after completion

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

### Metrics

```bash
# View performance metrics
undercity metrics
```

## How It Works

### Complexity Routing

Tasks are analyzed using quantitative code metrics:

| Signal | What It Measures |
|--------|------------------|
| Lines of code | Total lines in target files |
| Function count | Number of functions to modify |
| CodeScene health | Code quality scores when available |
| Git hotspots | Frequently changed files |
| Bug-prone files | Files with many "fix" commits |
| Cross-package | Changes spanning multiple packages |

**Routing:**
- Trivial/Simple → Haiku (fast, cheap)
- Standard → Sonnet (balanced)
- Complex/Critical → Opus (best quality)

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
│   ├── parallel-solo.ts  # Parallel execution via worktrees
│   ├── worktree-manager.ts # Git worktree isolation
│   ├── complexity.ts     # Quantitative task analysis
│   ├── context.ts        # Pre-flight briefing generation
│   ├── annealing-review.ts # Multi-angle review system
│   └── cli.ts            # Command interface
└── .undercity/
    ├── quests.json       # Quest board
    ├── metrics.jsonl     # Performance history
    ├── worktrees/        # Isolated worktrees for parallel tasks
    └── logs/             # Agent activity
```

## Roadmap: Dynamically Optimal

The goal is **fully autonomous, dynamically optimal** - no human gating, no manual tuning.

**Current (working):**
- Quantitative complexity analysis (lines, functions, CodeScene health, git history)
- Adaptive escalation with same-tier retries for trivial errors
- Escalating review system (haiku → sonnet → opus)
- Annealing review at opus tier (tarot-inspired multi-angle analysis)
- Post-mortem analysis on tier escalation
- Error category tracking for learning

**Next:**
- **Auto-planning**: Complex tasks get a planning phase, trivial ones skip it
- **Learning from metrics**: Route better based on what's worked before
- **Knowledge tracking**: Build understanding of codebase over time

**Future:**
- **Self-improving prompts**: Analyze failures, tune prompts automatically
- **Predictive routing**: Learn which task patterns need which models

## Legacy: The Raid Model

The original design used extraction shooter metaphors (raids, flutes, questers, sheriffs). While fun to build, the multi-agent coordination added complexity without proportional benefit for the solo use case.

**What we kept:**
- Quest terminology (tasks → quests)
- GUPP principle ("If work exists, continue it")
- Persistence hierarchy (crash recovery)

**What we simplified:**
- Planning/execution phases → auto-plan based on complexity (coming)
- Multiple agent types → one agent, multiple model tiers
- Human approval gates → fully autonomous

The themed commands still exist (`undercity slingshot`, etc.) but are **deprecated**. Use `solo` and `grind` instead.

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
- **Zeroshot** ([covibes/zeroshot](https://github.com/covibes/zeroshot)): Complexity-based team composition, independent validators, model ceiling controls
- **Sisyphus** ([oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode)): 7-section structured delegation prompts, phase-based workflows

**Extraction shooter theme** from ARC Raiders - because it's fun, even if the raid model got simplified.

## License

MIT
