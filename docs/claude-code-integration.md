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

## Getting Started (For Agents)

### Check Availability

```bash
# Verify undercity is installed and accessible
which undercity        # Should return path
undercity --version    # Should show version number
```

### First-Time Setup

If undercity isn't initialized in the current project:

```bash
undercity init         # Creates .undercity/ directory
```

### Quick Start

```bash
# 1. Add tasks to the board
undercity add "Implement user authentication"
undercity add "Add unit tests for auth module" --priority 100

# 2. Start autonomous execution
undercity grind                    # Process 1 task
undercity grind -n 5               # Process up to 5 tasks
undercity grind --parallel 3       # Run 3 concurrent workers

# 3. Check progress
undercity status                   # Grind session status (JSON)
```

## Commands

### Monitoring (JSON default)

| Command | Purpose | Output |
|---------|---------|--------|
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
| `add "task"` | Add task to board | Task ID |
| `add "task" --context <file>` | Add with handoff context | Task ID |
| `add "task" --priority 100` | Add with priority (lower = higher) | Task ID |
| `tasks` | View all tasks | Task list |
| `tasks --status pending` | View pending tasks | Task list |
| `complete <id>` | Mark task complete | - |
| `remove <id>` | Remove task from board | - |

All commands output JSON by default for programmatic use. Use `--human` for readable output.

## Daily Workflow

### Morning Reconnect
```bash
undercity status             # What happened overnight?
undercity decide             # Any decisions need me?
```

### During the Day
```bash
undercity status             # Quick status check
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
- **Tasks**: `undercity add "objective"` - add work to the board
- **Context**: `--context file.json` - pass structured handoff data
- **Priority**: `--priority 100` - control execution order (lower = sooner)
- **Decisions**: `undercity decide --resolve <id> --decision "choice"` - provide judgment

### Undercity → Claude Code
- **Status**: `undercity status` returns current/recent grind events
- **Decisions**: `undercity decide` returns pending decisions needing judgment
- **Knowledge**: `undercity knowledge "query"` returns relevant learnings
- **Research**: `.undercity/research/` contains PM-generated design docs

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

## Research Tasks

Tasks prefixed with `[research]` are routed through the automated PM system:

```bash
undercity add "[research] Investigate caching strategies for API responses"
```

**What happens:**
1. PM researches the topic (web search, codebase analysis)
2. Generates a design doc in `.undercity/research/`
3. Creates follow-up implementation tasks automatically
4. Original task marked complete

**Reading research results:**
```bash
ls .undercity/research/                    # List design docs
cat .undercity/research/2026-01-19-*.md    # Read specific doc
```

## State Files

| File | Purpose | Tracked |
|------|---------|---------|
| `undercity.db` | Task board (SQLite) | No |
| `rag.db` | RAG embeddings (SQLite) | No |
| `research/` | PM-generated design docs | Yes |
| `knowledge.json` | Accumulated learnings | No |
| `task-file-patterns.json` | Task→file correlations | No |
| `error-fix-patterns.json` | Error→fix patterns | No |
| `routing-profile.json` | Learned model routing | No |
| `usage-cache.json` | Claude Max usage cache (5min TTL) | No |
| `live-metrics.json` | Token usage tracking | No |
| `grind-events.jsonl` | Event log | No |

Browser auth stored in `.undercity/browser-data/` (gitignored).
