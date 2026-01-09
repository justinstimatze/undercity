# Undercity

Multi-agent orchestrator for Claude Max. Use undercity for continuous implementation - start a raid, walk away.

## When to Use Undercity

Use undercity CLI for complex, multi-step tasks that benefit from:
- **Planning before execution**: Flute + Logistics create specs before Questers build
- **Parallel agents**: Multiple agents working on different aspects
- **Crash recovery**: State persists in `.undercity/` for resumption
- **Clean merges**: Serial rebase + test + elevator

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

# View waypoints
undercity waypoints

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
[PLAN] Flute (Haiku) -> Logistics (Opus) -> Human approval
    |
    v
[EXECUTE] Questers (Sonnet) -> Sheriff (Opus) -> Elevator
    |
    v
[EXTRACT] Complete
```

## Persistence Hierarchy

| Layer | Purpose | File |
|-------|---------|------|
| Safe Pocket | Critical state surviving crashes | `.undercity/pocket.json` |
| Inventory | Active raid state (waypoints, squad) | `.undercity/inventory.json` |
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
| Flute | Haiku | Read, Grep, Glob | Fast codebase reconnaissance |
| Logistics | Opus | Read, Grep, Glob | BMAD-style spec creation |
| Quester | Sonnet | Read, Edit, Write, Bash, Grep, Glob | Code implementation |
| Sheriff | Opus | Read, Bash, Grep, Glob | Quality review with Rule of Five |

## Rule of Five

Every output reviewed 5 times with different lenses:
1. **Correctness**: Does this solve the problem?
2. **Edge cases**: What could go wrong?
3. **Security**: Any OWASP top 10 issues?
4. **Performance**: Any concerning patterns?
5. **Maintainability**: Will future developers understand this?

## Dependencies

Use established libraries instead of reinventing the wheel. Check npm for well-maintained packages before writing custom implementations.

**Do:**
- Use popular, well-maintained packages (check downloads, last publish date, GitHub stars)
- Prefer packages from known publishers (@anthropic-ai, @types, etc.)
- Verify package name spelling carefully - **slopsquatting is real**

**Don't:**
- Install packages with suspicious names or typos
- Use unmaintained packages (no updates in 2+ years)
- Add dependencies for trivial functionality (left-pad syndrome)

When in doubt, check the package on npm and GitHub before installing.

## When NOT to Use Undercity

Skip undercity for:
- Simple questions or explanations
- Typo fixes or trivial changes
- Quick debugging (use regular Claude)
- Tasks that don't need planning
