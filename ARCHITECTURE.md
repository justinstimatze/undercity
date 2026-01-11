# Undercity Architecture

## Command → Orchestrator → Infrastructure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLI COMMANDS                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   solo <goal>          grind [--parallel N]         (deprecated session)   │
│        │                        │                           │               │
│        ▼                        ▼                           ▼               │
│  ┌───────────┐          ┌──────────────┐            ┌──────────────┐       │
│  │   Solo    │          │ ParallelSolo │            │   Session    │       │
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
│  │  Worktree   │  │  Elevator   │  │    Task     │  │    Live     │        │
│  │  Manager    │  │ (merge queue)│  │    Board    │  │   Metrics   │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         │                │                │                │               │
│    Solo: ❌         Solo: ❌         Solo: ❌         Solo: ✅              │
│  PSolo: ✅        PSolo: ✅        PSolo: ✅        PSolo: ✅              │
│ Session: ✅      Session: ✅      Session: ❌       Session: ✅             │
│                                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ RateLimit   │  │    File     │  │  Recovery   │  │ Efficiency  │        │
│  │  Tracker    │  │   Tracker   │  │   System    │  │  Tracker    │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         │                │                │                │               │
│    Solo: ❌         Solo: ❌         Solo: ❌         Solo: ❌              │
│  PSolo: ✅        PSolo: ✅        PSolo: ✅        PSolo: ❌              │
│ Session: ✅      Session: ✅      Session: ✅       Session: ✅             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Current State Summary

| Component | Solo | ParallelSolo | Session |
|-----------|------|--------------|---------|
| **WorktreeManager** | ❌ | ✅ | ✅ |
| **Elevator (merge)** | ❌ | ✅ | ✅ |
| **Task Board** | ❌ | ✅ | ❌ |
| **Live Metrics** | ✅ | ✅ (via Solo) | ✅ |
| **RateLimitTracker** | ❌ | ✅ | ✅ |
| **FileTracker** | ❌ | ✅ | ✅ |
| **Recovery** | ❌ | ✅ | ✅ |
| **EfficiencyTracker** | ❌ | ❌ | ✅ |

## The Problem

**grind** (ParallelSolo) is the main autonomous mode but has some remaining gaps:
- ~~No rate limit awareness → can crash on 429~~ ✅ DONE
- ~~No file conflict detection → parallel tasks can fight~~ ✅ DONE
- ~~No recovery → failures leave state inconsistent~~ ✅ DONE

**SessionOrchestrator** has all the infrastructure but requires human approval and is complex.

## Proposed Simplification

### Option A: Enhance ParallelSolo
Add the missing infrastructure to ParallelSolo:
1. Wire in RateLimitTracker
2. Wire in FileTracker for pre-execution conflict check
3. Add basic recovery (save state, resume on restart)

### Option B: Simplify Session for Autonomous Use
Make SessionOrchestrator work without human approval:
1. Add auto-approve mode
2. Use existing infrastructure
3. Deprecate ParallelSolo

### Option C: Unified Orchestrator
Create one orchestrator that can run in different modes:
- `--interactive` (current Session behavior)
- `--autonomous` (current grind behavior)
- `--solo` (single task, no worktree)

## Recommended Path: Option A

ParallelSolo is simpler and already works. Add the missing pieces:

```
ParallelSoloOrchestrator
├── WorktreeManager ✅
├── Elevator ✅
├── Task Board ✅
├── Live Metrics ✅ (via Solo)
├── RateLimitTracker ✅
├── FileTracker ✅ (conflict detection before merge)
└── Basic Recovery ✅ (save/resume state)
```

**New CLI Commands:**
- `undercity limits` - Shows rate limit usage and quota status

## File Map

```
Entry Points:
  src/cli.ts → routes to command modules
  src/commands/mixed.ts → solo, grind, watch, dashboard
  src/commands/task.ts → tasks, add, work

Orchestrators:
  src/solo.ts → SoloOrchestrator (lightweight)
  src/parallel-solo.ts → ParallelSoloOrchestrator (parallel grind)

Infrastructure:
  src/worktree-manager.ts → git worktree isolation
  src/git.ts → Elevator, git operations
  src/task.ts → task board CRUD
  src/dashboard.ts → TUI display
  src/rate-limit.ts → API rate limit tracking
  src/persistence.ts → state persistence
  src/file-tracker.ts → conflict detection

Agent Types:
  scout → Fast reconnaissance (Haiku, read-only)
  planner → Specification writing (Opus)
  builder → Code implementation (Opus)
  reviewer → Quality assurance (Opus)
```
