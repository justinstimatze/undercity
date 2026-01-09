# Undercity

> *"It only has to make sense for me."*
> — Tamara, on her 365 buttons

Multi-agent orchestrator for Claude Max. Inspired by [Gas Town](https://github.com/steveyegge/gastown) but built for normal people with a Claude Max subscription.

Undercity uses extraction shooter metaphors, ARC Raiders lore, and unconventional terminology. None of it needs to be explained or justified. If flutes, questers, and the elevator help you ship code, that's all that matters.

## Overview

Undercity orchestrates multiple Claude agents to complete complex tasks. Start a raid, walk away, come back to completed work.

```
undercity slingshot "Add dark mode toggle"
    │
    ▼
[PLAN] Flute (Haiku) → Logistics (Opus) → Human approval
    │
    ▼
[EXECUTE] Quester (Opus) → Sheriff (Opus) → Elevator
    │
    ▼
[EXTRACT] Complete
```

## Installation

```bash
# Clone the repo
git clone https://github.com/justinstimatze/undercity.git
cd undercity

# Install dependencies
pnpm install

# Build
pnpm build

# Link globally (optional)
ln -sf $(pwd)/bin/undercity.js ~/.local/bin/undercity
```

Requires Node.js 24+ and a Claude Max subscription (or API key).

## Usage

### Launch a Raid

```bash
undercity slingshot "Add user authentication"
```

This starts the planning phase:
1. **Flute** (Haiku) - Fast codebase reconnaissance
2. **Logistics** (Opus) - Creates detailed implementation spec

### Check Status

```bash
undercity status
```

### Approve the Plan

```bash
undercity approve
```

This starts the execution phase:
1. **Quester** (Opus) - Implements the approved plan
2. **Sheriff** (Opus) - Reviews work with Rule of Five

### Complete the Raid

```bash
undercity extract
```

### Other Commands

```bash
undercity squad      # Show active agents
undercity tasks      # Show task status
undercity surrender  # Abort current raid
undercity clear      # Clear all state
undercity setup      # Check authentication
```

## Agent Types

| Agent | Model | Tools | Purpose |
|-------|-------|-------|---------|
| Flute | Haiku | Read, Grep, Glob | Fast codebase reconnaissance |
| Logistics | Opus | Read, Grep, Glob | BMAD-style spec creation |
| Quester | Opus | Read, Edit, Write, Bash, Grep, Glob | Code implementation |
| Sheriff | Opus | Read, Bash, Grep, Glob | Quality review (Rule of Five) |

## Persistence

State survives crashes via the persistence hierarchy:

| Layer | Purpose | File |
|-------|---------|------|
| Safe Pocket | Critical raid state | `.undercity/pocket.json` |
| Inventory | Active tasks and squad | `.undercity/inventory.json` |
| Loadout | Pre-raid configuration | `.undercity/loadout.json` |
| Stash | Long-term storage | `.undercity/stash.json` |

## The GUPP Principle

> "If there is work in progress, continue it first."

On startup, Undercity checks for active raids and resumes them automatically.

## Rule of Five

Every output is reviewed 5 times with different lenses:

1. **Correctness** - Does this solve the problem?
2. **Edge cases** - What could go wrong?
3. **Security** - Any OWASP top 10 issues?
4. **Performance** - Any concerning patterns?
5. **Maintainability** - Will future developers understand this?

## Philosophy

Gas Town runs 20-30 parallel agents across multiple Claude accounts. Undercity is built for budget extraction - same core ideas, Claude Max constraints.

| Constraint | Undercity Approach |
|------------|-------------------|
| Rate limits | Smaller squad (5-10 agents max) |
| Single account | Sequential phases, not swarm |
| Context limits | On-demand loading, not everything upfront |
| Session crashes | Persistence hierarchy for recovery |

**What we stole:**
- **Gas Town**: GUPP principle, session persistence, agent identities
- **Beads**: Git-backed state, crash recovery philosophy
- **BMAD**: Planning before execution, spec approval gates

## Configuration

### Authentication

Undercity uses the Claude Agent SDK which supports:

- **Claude Max** (recommended): Set `CLAUDE_CODE_OAUTH_TOKEN`
- **API Key**: Set `ANTHROPIC_API_KEY`

Run `undercity setup` to check your configuration.

## Inspiration

**Community projects:**
- [Gas Town](https://github.com/steveyegge/gastown) by Steve Yegge - Multi-agent orchestrator
- [Beads](https://github.com/steveyegge/beads) - Git-backed task tracking
- [BMAD Method](https://github.com/bmad-method/bmad-method) - Planning before execution

**Personal projects:**
- [tttc-light-js](https://github.com/AIObjectives/tttc-light-js) - CI/tooling patterns

**Other:**
- ARC Raiders - Thematic inspiration (extraction shooter setting)

## License

MIT
