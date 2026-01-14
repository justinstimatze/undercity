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

### Monitoring (JSON default)

| Command | Purpose | Output |
|---------|---------|--------|
| `pulse` | Quick state check | JSON: workers, queue, health, attention |
| `brief --hours <n>` | Narrative summary | JSON: accomplishments, failures, recommendations |
| `status` | Grind session status | JSON: current/recent events |
| `usage` | Live Claude Max usage | JSON: limits, consumed, remaining |

### Learning (JSON default)

| Command | Purpose | Output |
|---------|---------|--------|
| `knowledge <query>` | Search accumulated learnings | JSON: matching learnings |
| `knowledge --stats` | Knowledge base statistics | JSON: counts by category |
| `decide` | View pending decisions | JSON: decisions needing resolution |
| `decide --resolve <id> --decision "choice"` | Resolve decision | - |
| `patterns` | Task→file correlations | Human: top keywords, files, risks |
| `tuning` | Learned routing profile | Human: model thresholds |
| `introspect --json` | Self-analysis | JSON: success rates, patterns |

### Task Management

| Command | Purpose | Output |
|---------|---------|--------|
| `add "task" --context <file>` | Delegate with context | Task ID |
| `tasks --status pending` | View pending tasks | Task list |
| `complete <id> --reason "..."` | Mark task complete | - |

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

## State Files

| File | Purpose | Tracked |
|------|---------|---------|
| `tasks.json` | Task board | Yes |
| `knowledge.json` | Accumulated learnings | No |
| `decisions.json` | Decision history | No |
| `task-file-patterns.json` | Task→file correlations | No |
| `error-fix-patterns.json` | Error→fix patterns | No |
| `routing-profile.json` | Learned model routing | No |
| `usage-cache.json` | Claude Max usage cache (5min TTL) | No |
| `live-metrics.json` | Token usage tracking | No |
| `grind-events.jsonl` | Event log | No |

Browser auth stored in `.undercity/browser-data/` (gitignored).
