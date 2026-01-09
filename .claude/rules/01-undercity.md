# Undercity

Multi-agent orchestrator for Claude Max. Use undercity for continuous implementation - start a raid, walk away.

## When to Use Undercity

Use undercity CLI for complex, multi-step tasks that benefit from:
- **Planning before execution**: Scout + Planner create specs before Fabricators build
- **Parallel agents**: Multiple agents working on different aspects
- **Crash recovery**: State persists in `.undercity/` for resumption
- **Clean merges**: Serial rebase + test + merge queue

## Basic Commands

```bash
# Launch a raid via the Tubes (or resume existing)
undercity slingshot "Add dark mode toggle"

# Check status
undercity status

# Approve the plan (after planning phase)
undercity approve

# View squad members
undercity squad

# View tasks
undercity tasks

# Complete the raid
undercity extract

# Surrender if needed
undercity surrender
```

## Raid Flow

```
undercity slingshot "goal"
    |
    v
[PLAN] Scout (Haiku) -> Planner (Opus) -> Human approval
    |
    v
[EXECUTE] Fabricators (Opus) -> Auditor (Opus) -> Merge Queue
    |
    v
[EXTRACT] Complete
```

## Persistence Hierarchy

| Layer | Purpose | File |
|-------|---------|------|
| Safe Pocket | Critical state surviving crashes | `.undercity/pocket.json` |
| Inventory | Active raid state (tasks, squad) | `.undercity/inventory.json` |
| Loadout | Pre-raid configuration | `.undercity/loadout.json` |
| Stash | Long-term storage between raids | `.undercity/stash.json` |

## The Extraction Principle (GUPP)

> "If there is work in progress, continue it first."

On session start:
1. Check `.undercity/pocket.json`
2. If raid active, resume from last state
3. Don't start new work until previous raid completes

## Agent Types

| Agent | Model | Tools | Purpose |
|-------|-------|-------|---------|
| Scout | Haiku | Read, Grep, Glob | Fast codebase reconnaissance |
| Planner | Opus | Read, Grep, Glob | BMAD-style spec creation |
| Fabricator | Opus | Read, Edit, Write, Bash, Grep, Glob | Code implementation |
| Auditor | Opus | Read, Bash, Grep, Glob | Quality review with Rule of Five |

## Rule of Five

Every output reviewed 5 times with different lenses:
1. **Correctness**: Does this solve the problem?
2. **Edge cases**: What could go wrong?
3. **Security**: Any OWASP top 10 issues?
4. **Performance**: Any concerning patterns?
5. **Maintainability**: Will future developers understand this?

## When NOT to Use Undercity

Skip undercity for:
- Simple questions or explanations
- Typo fixes or trivial changes
- Quick debugging (use regular Claude)
- Tasks that don't need planning
