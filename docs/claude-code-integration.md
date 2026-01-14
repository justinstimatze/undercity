# Claude Code + Undercity Integration

## Overview

Claude Code delegates to Undercity for autonomous execution. Undercity runs continuously, reports back, and surfaces decisions that need judgment.

```
┌─────────────────────────────────────────────────────────────┐
│  CLAUDE CODE                                                │
│  - Strategic direction (what to work on)                    │
│  - Judgment calls (decisions workers can't make)            │
│  - Context provision (what workers need to know)            │
│  - Knowledge consumption (learn from outcomes)              │
└─────────────────────────────────────────────────────────────┘
        │                                          ▲
        │ delegate tasks                           │ report outcomes
        │ provide context                          │ surface decisions
        ▼                                          │
┌─────────────────────────────────────────────────────────────┐
│  UNDERCITY                                                  │
│  - Autonomous execution (grind overnight)                   │
│  - Parallel work (multiple worktrees)                       │
│  - Verification (typecheck, test, lint)                     │
│  - Knowledge accumulation (learn from outcomes)             │
│  - Decision escalation (surface what needs judgment)        │
└─────────────────────────────────────────────────────────────┘
```

## Commands

| Command | Purpose | Output |
|---------|---------|--------|
| `pulse` | Quick state check - workers, queue, health | JSON (default) |
| `brief` | Narrative summary - accomplishments, failures, recommendations | JSON (default) |
| `decide` | View/resolve pending decisions from workers | JSON (default) |
| `knowledge <query>` | Search accumulated learnings | JSON (default) |
| `usage` | Fetch live Claude Max usage from claude.ai | JSON (default) |
| `add --context <file>` | Delegate task with context JSON | - |

All commands output JSON by default for programmatic use. Use `--human` for readable output.

## Daily Workflow

### Morning Reconnect
```bash
undercity brief              # What happened overnight?
undercity decide             # Any decisions need me?
```

### During the Day
```bash
undercity pulse              # Quick status check
undercity add "task" -c context.json  # Delegate with context
```

### Before Disconnecting
```bash
undercity add "task 1"
undercity add "task 2"
undercity grind              # Start autonomous processing
```

## Data Flow

### Claude Code → Undercity
- **Tasks**: `undercity add "objective"`
- **Context**: `--context file.json` with handoff data
- **Decisions**: `undercity decide --resolve <id> --decision "choice"`

### Undercity → Claude Code
- **Status**: `undercity pulse` returns queue, health, attention items
- **Summary**: `undercity brief` returns accomplishments, failures, recommendations
- **Decisions**: `undercity decide` returns pending decisions needing judgment
- **Knowledge**: `undercity knowledge "query"` returns relevant learnings

## Rate Limit Awareness

Undercity fetches live Claude Max usage from claude.ai (via Playwright scraping). This data:
- Populates `health.rateLimit` in pulse output
- Drives pacing calculations
- Cached for 5 minutes to avoid excessive scraping

First-time setup: `undercity usage --login` to authenticate.

## Knowledge Compounding

Workers extract learnings from completed tasks:
- Patterns discovered
- Gotchas encountered
- Preferences learned

Query with: `undercity knowledge "search term"`

Learnings are injected into future task prompts when relevant.

## Files

```
.undercity/
├── tasks.json           # Task board (tracked in git)
├── knowledge.json       # Accumulated learnings
├── decisions.json       # Decision history
├── usage-cache.json     # Cached Claude Max usage
└── browser-data/        # Playwright session (gitignored)
```
