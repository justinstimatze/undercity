# The Mayor Model: Claude Code + Undercity Integration

## Vision

Claude Code can't run continuously, but it can **delegate to a system that can** and **reconnect** when back. Undercity becomes an autonomous extension of Claude Code, not a separate tool.

**The metaphor:** If Undercity is a small city and Claude Code is the mayor:
- Mayor sets priorities and makes judgment calls
- City runs autonomously, executing work
- City reports back: what happened, what was learned, what needs the mayor's attention
- Mayor benefits from everything the city discovers

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  CLAUDE CODE (The Mayor)                                    │
│                                                             │
│  Responsibilities:                                          │
│  - Strategic direction (what to work on)                    │
│  - Judgment calls (decisions workers can't make)            │
│  - Context provision (what I know that workers need)        │
│  - Knowledge consumption (learn from what city discovered)  │
└─────────────────────────────────────────────────────────────┘
        │                                          ▲
        │ delegate tasks                           │ report outcomes
        │ provide context                          │ surface decisions
        │ set priorities                           │ share learnings
        ▼                                          │
┌─────────────────────────────────────────────────────────────┐
│  UNDERCITY (The City)                                       │
│                                                             │
│  Responsibilities:                                          │
│  - Autonomous execution (grind overnight)                   │
│  - Parallel work (multiple worktrees)                       │
│  - Verification (typecheck, test, lint)                     │
│  - Knowledge accumulation (learn from outcomes)             │
│  - Decision bubbling (escalate what needs the mayor)        │
└─────────────────────────────────────────────────────────────┘
```

## Current State vs Needed

| Flow | Direction | Current | Status |
|------|-----------|---------|--------|
| Delegate tasks | Mayor → City | `undercity add "task"` | ✅ Works |
| Run autonomously | City | `undercity grind` | ✅ Works |
| Check status | City → Mayor | `undercity status` | ✅ Works |
| Query learnings | City → Mayor | knowledge.ts exists | ❌ No query CLI |
| See pending decisions | City → Mayor | decision-tracker exists | ❌ No inbox CLI |
| Attach context | Mayor → City | - | ❌ Not implemented |
| Get briefing | City → Mayor | - | ❌ Not implemented |

## New Commands to Build

### 1. `undercity pulse` - Quick State Check

**Purpose:** "What's happening right now?" - fast, glanceable, anytime.

**Output:**
```
$ undercity pulse

⚡ Undercity Pulse

ACTIVE (2 workers)
  🔄 task-a3f: "Add rate limiting" (sonnet, 4m elapsed, src/api/*)
  🔄 task-b72: "Fix login bug" (haiku, 1m elapsed, src/auth/*)

QUEUE (5 pending)
  1. "Improve error messages" (standard)
  2. "Add caching layer" (complex)
  3. "Update docs" (simple)
  ...

HEALTH
  Rate limit: 42% used (58% remaining)
  Last hour: 3 completed, 0 failed
  Merge queue: 2 waiting

ATTENTION (1)
  ⚠️ Decision pending: auth refactor approach
```

**Design principles:**
- Fits in one screen
- No scrolling needed
- Actionable items highlighted
- Numbers over prose

**Flags:**
- `--json` - Machine-readable for programmatic use
- `--watch` - Live updating (like `htop`)

**Implementation:**
- Query active workers from worktree-state.json
- Query pending from tasks.json
- Query rate limits from rate-limit-state.json
- Query decisions from decision-tracker
- Calculate sustainable pace based on remaining budget
- Format as compact dashboard

---

### Rate-Aware Pacing

**Problem:** Grind at full speed exhausts rate limits in ~2 hours, then idles. Not useful for overnight work.

**Solution:** Pace work to spread evenly over target duration.

**In `pulse` output:**
```
PACING
  Budget: 1M tokens/5hr window
  Used: 420K (42%)
  Remaining: 580K tokens

  Queue: 12 tasks (~50K tokens each estimated)
  At full speed: exhausts in ~1.2 hours
  Recommended: 1 task every 20min to last 4 hours

  Current mode: --pace 8h (1 task/40min)
```

**New grind flags:**
```bash
# Spread work over duration
undercity grind --pace 8h

# Auto-pace to stay under threshold (default 80%)
undercity grind --background
undercity grind --background --max-usage 60%

# Override: go fast, accept rate limit pauses
undercity grind --no-pace
```

**Pacing algorithm:**
```typescript
interface PacingConfig {
  targetDuration: number;      // e.g., 8 hours in ms
  maxUsagePercent: number;     // e.g., 80%
  tokenBudget: number;         // from rate limit config
  tokensUsed: number;          // current usage
  estimatedTokensPerTask: number; // from historical average
}

function calculateDelay(config: PacingConfig, queueSize: number): number {
  const remainingBudget = config.tokenBudget * config.maxUsagePercent - config.tokensUsed;
  const estimatedTotalTokens = queueSize * config.estimatedTokensPerTask;

  if (estimatedTotalTokens <= remainingBudget) {
    // Can finish within budget - pace over target duration
    return config.targetDuration / queueSize;
  } else {
    // Budget constrained - pace to not exceed
    const tasksAffordable = remainingBudget / config.estimatedTokensPerTask;
    return config.targetDuration / tasksAffordable;
  }
}
```

**Sharing budget with Claude Code:**
- Rate limits are per-account, shared between Claude Code and Undercity
- Pulse should show total account usage, not just undercity's
- If Claude Code is active, undercity should slow down
- Consider: `--yield-to-interactive` flag that pauses grind when Claude Code session detected

---

### 2. `undercity brief` - The Morning Report

**Purpose:** "What should I know since last time?"

**Output:**
```
$ undercity brief

📊 Undercity Status Report
Since: 2024-01-12 18:00

TASKS
  ✅ Completed: 3
     - Add caching to API endpoints (PR #234)
     - Fix login redirect bug (PR #235)
     - Update dependency versions (PR #236)

  ❌ Failed: 1
     - Refactor auth module
       Reason: Verification failed after 3 attempts
       Last error: Type error in src/auth/middleware.ts
       Suggestion: May need architectural decision

  🔄 In Progress: 2
     - Add rate limiting (worker active)
     - Improve error messages (queued)

DECISIONS PENDING (2)
  1. [architecture] Auth refactor: patch existing vs full rewrite?
  2. [priority] Bug #567 blocks Feature #890 - proceed anyway?

LEARNINGS (5 new)
  - "This codebase uses barrel exports in src/index.ts"
  - "API routes follow /api/v1/{resource} pattern"
  - "Tests use factory functions in __tests__/helpers/"
  ...

Run 'undercity decide' to handle pending decisions.
```

**Implementation:**
- Query tasks.json for completed/failed/in-progress since timestamp
- Query decision-tracker for pending decisions
- Query knowledge.ts for recent learnings
- Format as human-readable report

### 2. `undercity decide` - The Decision Inbox

**Purpose:** Handle judgment calls that workers escalated.

**Flow:**
```
$ undercity decide

Decision 1 of 2:

Task: Refactor auth module
Worker encountered: Two valid approaches, need direction

Context:
  The auth module has grown complex. Worker identified two paths:

  Option A: Patch existing
    - Faster (estimated 2-3 files)
    - Keeps backwards compatibility
    - Tech debt remains

  Option B: Full rewrite
    - Cleaner architecture
    - Breaking change for auth consumers
    - 5-7 files affected

Worker's assessment: "Option B is cleaner but Option A is safer.
I don't have enough context on downstream consumers to decide."

Your decision: [A/B/skip/context] > B

Decision recorded. Worker will proceed with full rewrite.

---

Decision 2 of 2:
...
```

**Implementation:**
- Load pending decisions from decision-tracker
- Display context and options
- Record human choice
- Mark decision as resolved so worker can continue

### 3. `undercity add --context` - Context-Aware Delegation

**Purpose:** Pass relevant context from current session to the task.

**Usage:**
```bash
# Simple - just the task
undercity add "implement caching"

# With context - what the mayor knows
undercity add "implement caching" --context "prefer Redis over in-memory, see src/config for connection setup"

# With file context - attach relevant files
undercity add "fix auth bug" --files src/auth/middleware.ts src/auth/types.ts
```

**Implementation:**
- Store context alongside task in tasks.json
- Worker receives context in initial prompt
- Context survives task decomposition (passed to subtasks)

**Task schema addition:**
```typescript
interface Task {
  id: string;
  objective: string;
  status: TaskStatus;
  // New fields
  mayorContext?: string;        // Free-form context from mayor
  relevantFiles?: string[];     // Files mayor was looking at
  sessionId?: string;           // Which session created this
  constraints?: string[];       // "must use Redis", "no breaking changes"
}
```

## Daily Workflow

### Morning Reconnect
```bash
# See what happened overnight
undercity brief

# Handle any decisions that need me
undercity decide

# Review and merge completed PRs
gh pr list --author="undercity-worker"
```

### During the Day
```bash
# In Claude Code conversation, delegate work
undercity add "implement feature X" --context "discussed approach with user, prefer option B"

# Check on progress
undercity status

# If something needs immediate attention
undercity grind --task task-123  # Run specific task now
```

### Before Disconnecting
```bash
# Queue up overnight work
undercity add "comprehensive test coverage for auth module"
undercity add "refactor database queries for performance"
undercity add "update documentation for new API endpoints"

# Set it running
undercity grind --background

# Or schedule for later
undercity grind --after "22:00"
```

## Knowledge Flow

### What the Mayor Shares → City
1. **Task context** - "We discussed X, prefer Y approach"
2. **Constraints** - "No breaking changes", "Must be backwards compatible"
3. **Relevant files** - Files the mayor was examining
4. **Session decisions** - Choices made in conversation

### What the City Shares → Mayor
1. **Outcomes** - What succeeded/failed
2. **Learnings** - Patterns discovered, gotchas found
3. **Decisions made** - What the city decided autonomously
4. **Decisions needed** - What requires the mayor's judgment

### Knowledge Persistence
```
.undercity/
├── knowledge.json        # Accumulated learnings
├── decisions.json        # Decision history
├── tasks.json           # Task board
└── mayor-context/       # Context from mayor sessions
    ├── session-abc.json
    └── session-def.json
```

## Integration with Claude Code

### Option A: CLI Commands (Simple)
Claude Code calls undercity CLI directly:
```bash
undercity brief
undercity add "task" --context "..."
undercity decide
```

### Option B: MCP Server (Rich)
Undercity exposes MCP (Model Context Protocol) interface:
```
undercity://brief          → Get status report
undercity://add            → Queue task with context
undercity://decide/123     → Make decision on specific item
undercity://knowledge/auth → Query learnings about auth
```

**Recommendation:** Start with CLI (Option A), add MCP later if needed.

## Implementation Plan

### Phase 1: Pulse Command (do this first - highest immediate value)
1. Add `undercity pulse` command
2. Query active workers, queue, health, attention items
3. Format as compact single-screen dashboard
4. Add `--json` flag for programmatic use
5. Add `--watch` flag for live updates

### Phase 2: Brief Command
1. Add `undercity brief` command
2. Query tasks, decisions, knowledge
3. Format readable report
4. Add `--since` flag for time range
5. Add `--json` flag for programmatic use

### Phase 3: Decide Command
1. Add `undercity decide` command
2. Interactive decision flow
3. Record decisions to decision-tracker
4. Signal workers to continue

### Phase 4: Context Passing
1. Extend task schema with context fields
2. Add `--context` and `--files` flags to `undercity add`
3. Inject context into worker prompts
4. Pass context through decomposition

### Phase 5: Knowledge Query
1. Add `undercity knowledge search "query"` command
2. Semantic search over learnings
3. Surface relevant learnings in brief
4. Auto-inject learnings into related tasks

## Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Tasks completed overnight | >80% success | Track in capability-ledger |
| Decisions needing mayor | <20% of tasks | Count bubbled decisions |
| Knowledge reuse | Learnings cited in tasks | Track in worker output |
| Morning review time | <10 minutes | Time to process brief + decide |

## Open Questions

1. **Decision timeout** - If mayor doesn't respond, should city:
   - Wait indefinitely?
   - Make best guess after N hours?
   - Skip task and move on?

2. **Context size** - How much context is too much?
   - Token limits on worker prompts
   - Diminishing returns on context volume

3. **Knowledge pruning** - When learnings conflict or become stale:
   - Manual curation?
   - Confidence decay over time?
   - Contradiction detection?

4. **Multi-mayor** - If multiple Claude Code sessions interact:
   - Merge contexts?
   - Conflict resolution?
   - Session isolation?

---

## Summary

The Mayor Model transforms Undercity from "a separate batch tool" into "Claude Code's autonomous arm." The mayor (Claude Code) sets direction and makes judgment calls; the city (Undercity) executes continuously and reports back.

**Key commands:**
- `undercity pulse` - Quick state check (anytime, one screen)
- `undercity brief` - Detailed morning report
- `undercity decide` - Handle escalated decisions
- `undercity add --context` - Delegate with context
- `undercity knowledge search` - Query what the city learned

**Core principle:** Maximize value per unit of mayor attention. The city should run autonomously 80%+ of the time, only surfacing what truly needs human/mayor judgment.
