# Undercity Architecture

## Command → Orchestrator → Infrastructure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLI COMMANDS                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   solo <goal>          grind [--parallel N]         plan/work/slingshot    │
│        │                        │                           │               │
│        ▼                        ▼                           ▼               │
│  ┌───────────┐          ┌──────────────┐            ┌──────────────┐       │
│  │   Solo    │          │ ParallelSolo │            │     Raid     │       │
│  │Orchestrator│          │ Orchestrator │            │ Orchestrator │       │
│  └─────┬─────┘          └──────┬───────┘            └──────┬───────┘       │
│        │                       │                           │               │
└────────┼───────────────────────┼───────────────────────────┼───────────────┘
         │                       │                           │
         ▼                       ▼                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         INFRASTRUCTURE LAYER                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │  Worktree   │  │  Elevator   │  │    Quest    │  │    Live     │        │
│  │  Manager    │  │ (merge queue)│  │    Board    │  │   Metrics   │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         │                │                │                │               │
│    Solo: ❌         Solo: ❌         Solo: ❌         Solo: ✅              │
│  PSolo: ✅        PSolo: ✅        PSolo: ✅ (new)   PSolo: ✅              │
│   Raid: ✅         Raid: ✅         Raid: ❌          Raid: ✅              │
│                                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ RateLimit   │  │    File     │  │  Recovery   │  │ Efficiency  │        │
│  │  Tracker    │  │   Tracker   │  │   System    │  │  Tracker    │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         │                │                │                │               │
│    Solo: ❌         Solo: ❌         Solo: ❌         Solo: ❌              │
│  PSolo: ✅        PSolo: ❌        PSolo: ❌        PSolo: ❌              │
│   Raid: ✅         Raid: ✅         Raid: ✅          Raid: ✅              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Current State Summary

| Component | Solo | ParallelSolo | Raid |
|-----------|------|--------------|------|
| **WorktreeManager** | ❌ | ✅ | ✅ |
| **Elevator (merge)** | ❌ | ✅ | ✅ |
| **Quest Board** | ❌ | ✅ | ❌ |
| **Live Metrics** | ✅ | ✅ (via Solo) | ✅ |
| **RateLimitTracker** | ❌ | ✅ | ✅ |
| **FileTracker** | ❌ | ❌ | ✅ |
| **Recovery** | ❌ | ❌ | ✅ |
| **EfficiencyTracker** | ❌ | ❌ | ✅ |

## The Problem

**grind** (ParallelSolo) is the main autonomous mode but has some remaining gaps:
- ~~No rate limit awareness → can crash on 429~~ ✅ DONE
- No file conflict detection → parallel tasks can fight
- No recovery → failures leave state inconsistent

**RaidOrchestrator** has all the infrastructure but requires human approval and is complex.

## Proposed Simplification

### Option A: Enhance ParallelSolo
Add the missing infrastructure to ParallelSolo:
1. Wire in RateLimitTracker
2. Wire in FileTracker for pre-execution conflict check
3. Add basic recovery (save state, resume on restart)

### Option B: Simplify Raid for Autonomous Use
Make RaidOrchestrator work without human approval:
1. Add auto-approve mode
2. Use existing infrastructure
3. Deprecate ParallelSolo

### Option C: Unified Orchestrator
Create one orchestrator that can run in different modes:
- `--interactive` (current Raid behavior)
- `--autonomous` (current grind behavior)
- `--solo` (single task, no worktree)

## Recommended Path: Option A

ParallelSolo is simpler and already works. Add the missing pieces:

```
ParallelSoloOrchestrator
├── WorktreeManager ✅
├── Elevator ✅
├── Quest Board ✅
├── Live Metrics ✅ (via Solo)
├── RateLimitTracker ✅ (just added)
├── FileTracker ← ADD THIS (optional, for parallel safety)
└── Basic Recovery ← ADD THIS (save/resume state)
```

**New CLI Commands:**
- `undercity limits` - Shows rate limit usage and quota status

## File Map

```
Entry Points:
  src/cli.ts → routes to command modules
  src/commands/mixed.ts → solo, grind, watch, dashboard
  src/commands/raid.ts → slingshot, approve, extract
  src/commands/quest.ts → quests, add, work

Orchestrators:
  src/solo.ts → SoloOrchestrator (lightweight)
  src/parallel-solo.ts → ParallelSoloOrchestrator (parallel grind)
  src/raid.ts → RaidOrchestrator (full-featured)

Infrastructure:
  src/worktree-manager.ts → git worktree isolation
  src/git.ts → Elevator, git operations
  src/quest.ts → quest board CRUD
  src/live-metrics.ts → SDK metrics aggregation
  src/dashboard.ts → TUI display
  src/rate-limit.ts → API rate limit tracking (now shared)
  src/persistence.ts → state persistence

Raid-Only (should be shared):
  src/file-tracker.ts → conflict detection
  src/efficiency-tracker.ts → performance metrics
  src/checkpoint-manager.ts → recovery checkpoints
  src/error-escalation.ts → pattern-based error handling
```
