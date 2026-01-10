# Undercity

> *"It only has to make sense for me."*
> — Tamara, on her 365 buttons

Multi-agent orchestrator built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Inspired by [Gas Town](https://github.com/steveyegge/gastown) but designed for solo developers who want autonomous coding without managing 20+ parallel agents.

Uses extraction shooter metaphors and ARC Raiders lore because it's fun. If flutes, questers, and the elevator help you ship code, that's all that matters.

## Overview

Undercity orchestrates multiple Claude agents to complete complex tasks. Start a raid, walk away, come back to completed work.

```
undercity slingshot "Add dark mode toggle"
    │
    ▼
[PLAN] Flute (Haiku) → Logistics (Opus)
    │
    ▼
[EXECUTE] Quester (Sonnet) → Sheriff (Opus) → Elevator
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

Requires Node.js 24+ and either a Claude Max subscription or Anthropic API key.

## Quickstart

The recommended setup uses three terminals:

**Terminal 1: Claude Code**
```bash
claude
```
Your interactive Claude instance. Use it to review work, make decisions, and handle anything that needs human judgment.

**Terminal 2: Undercity**
```bash
undercity work --stream
```
Runs autonomously through the quest board. Picks up quests from `quests.json`, runs the full flute→logistics→quester→sheriff pipeline, merges via elevator, repeats.

**Terminal 3: Status monitor**
```bash
watch -n 5 undercity status
```
Shows current raid progress, active agents, and queue status. Refreshes every 5 seconds.

**The workflow:**
1. Tell Claude Code what you want to build (it adds quests to `intel.txt`)
2. Run `undercity work --stream` to process quests autonomously
3. Watch progress in the status terminal
4. Use Claude Code to intervene when needed (review failures, adjust priorities, add urgent quests)

Claude Code stays interactive for high-judgment tasks while undercity handles the grind.

## Usage

### Launch a Raid

```bash
undercity slingshot "Add user authentication"
```

This runs the full pipeline:
1. **Flute** (Haiku) - Fast codebase reconnaissance
2. **Logistics** (Opus) - Creates detailed implementation spec
3. **Quester** (Sonnet) - Implements the plan
4. **Sheriff** (Opus) - Reviews work with Rule of Five

### Check Status

```bash
undercity status
```

### Complete the Raid

```bash
undercity extract
```

### Other Commands

```bash
undercity squad      # Show active agents
undercity quests     # Show quest board
undercity surrender  # Abort current raid
undercity clear      # Clear all state
undercity setup      # Check authentication
```

## Agent Types

| Agent | Model | Tools | Purpose |
|-------|-------|-------|---------|
| Flute | Haiku | Read, Grep, Glob | Fast codebase reconnaissance |
| Logistics | Opus | Read, Grep, Glob | BMAD-style spec creation |
| Quester | Sonnet | Read, Edit, Write, Bash, Grep, Glob | Code implementation |
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

Gas Town runs 20-30 parallel agents across multiple Claude accounts. Undercity takes the same core ideas but optimizes for a single developer on a single account.

| Constraint | Undercity Approach |
|------------|-------------------|
| Rate limits | Smaller squad, serial execution |
| Single account | Controlled parallelism, not swarm |
| Context limits | On-demand loading, not everything upfront |
| Session crashes | Persistence hierarchy for resumption |

**Looted from:**
- **Gas Town** (Steve Yegge): GUPP principle, session persistence, agent identities
- **Jeffrey Emanuel**: Rule of Five (via Gas Town)
- **Beads** (Steve Yegge): Git-backed state, resumption philosophy
- **BMAD**: Planning before execution

## Configuration

### Authentication

Undercity uses the Claude Agent SDK which supports:

- **API Key**: Set `ANTHROPIC_API_KEY`
- **Claude Max**: Set `CLAUDE_CODE_OAUTH_TOKEN`

Run `undercity setup` to check your configuration.

## Goop

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
