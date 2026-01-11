# Codebase Map

## File → Purpose

| File | Purpose | Key Exports |
|------|---------|-------------|
| **cli.ts** | CLI entry, routes to command modules | - |
| **commands/task.ts** | Task board commands (tasks, add, work, plan, import-plan) | taskCommands |
| **commands/mixed.ts** | Main commands (solo, grind, limits, watch, serve, daemon) | mixedCommands |
| **commands/analysis.ts** | Metrics/analysis commands | analysisCommands |
| **solo.ts** | Single-task orchestrator, adaptive escalation | SoloOrchestrator, SupervisedOrchestrator |
| **parallel-solo.ts** | Main production orchestrator, parallel execution | ParallelSoloOrchestrator |
| **task.ts** | Task board CRUD (add, get, mark status) | addGoal, getAllItems, markComplete, etc. |
| **worktree-manager.ts** | Git worktree isolation per task | WorktreeManager |
| **git.ts** | Git operations, MergeQueue (serial merge pipeline) | Elevator, getCurrentBranch, rebase, merge |
| **rate-limit.ts** | 429 handling, exponential backoff | RateLimitTracker |
| **file-tracker.ts** | Pre-merge file conflict detection | FileTracker |
| **live-metrics.ts** | Token usage, cost tracking | saveLiveMetrics, loadLiveMetrics |
| **grind-events.ts** | Structured event logging (not metrics) | startGrindSession, logTaskComplete, etc. |
| **task-decomposer.ts** | Break multi-step tasks into atomic subtasks | checkAndDecompose |
| **plan-parser.ts** | Parse markdown plans into tasks | parsePlanFile, planToTasks |
| **complexity.ts** | Assess task complexity | assessComplexityFast |
| **persistence.ts** | State management, file I/O for `.undercity/*` | Persistence |
| **dashboard.ts** | TUI (blessed-based) | launchDashboard |
| **server.ts** | HTTP daemon for external control | UndercityServer, queryDaemon |
| **config.ts** | Config loading (.undercityrc hierarchy) | loadConfig, mergeWithConfig |
| **types.ts** | Core type definitions | SessionStatus, AgentType, Task, ElevatorItem |
| **output.ts** | Structured output (human/agent modes) | info, success, error, header, metrics |
| **oracle.ts** | Oblique strategy cards | UndercityOracle |

## Task → File Mapping

**I need to:**
- Add/query/update tasks → `task.ts`
- Run a single task → `solo.ts` (deprecated) or `parallel-solo.ts` (preferred)
- Run tasks in parallel → `parallel-solo.ts`
- Isolate tasks in git worktrees → `worktree-manager.ts`
- Merge branches serially → `git.ts` (Elevator/MergeQueue class)
- Handle rate limits → `rate-limit.ts`
- Check file conflicts → `file-tracker.ts`
- Track token usage → `live-metrics.ts`
- Parse markdown plans → `plan-parser.ts`
- Check task complexity → `complexity.ts` or `task-decomposer.ts`
- Persist state → `persistence.ts`
- Build TUI → `dashboard.ts`
- Expose HTTP API → `server.ts`
- Output to user → `output.ts`

## Orchestrators

| Class | File | Use | Parallel | Infrastructure |
|-------|------|-----|----------|----------------|
| ParallelSoloOrchestrator | parallel-solo.ts | **Main production** (grind) | Yes (1-5) | Worktree, Elevator, RateLimit, FileTracker, Recovery |
| SoloOrchestrator | solo.ts | Single task, deprecated | No | LiveMetrics only |
| SupervisedOrchestrator | solo.ts | Opus orchestrates workers | No | LiveMetrics only |

**Decision:** Use ParallelSoloOrchestrator for everything (even single tasks with maxConcurrent=1).

## grind Flow

```
ParallelSoloOrchestrator.runParallel():
1. Check recovery (hasActiveRecovery) → resume if needed
2. Fetch tasks (task.ts:getAllItems) → filter: pending|in_progress, !isDecomposed
3. Decompose (task-decomposer:checkAndDecompose) → atomic subtasks + model tier
4. Group by model → execute haiku → sonnet → opus (cheapest first)
5. Per task:
   - Spawn worktree (WorktreeManager.createWorktree)
   - Run SoloOrchestrator (AI does work)
   - Check conflicts (FileTracker.checkConflicts)
   - Queue merge (Elevator.queueMerge)
   - Process Elevator (serial rebase → test → merge → push)
6. Update status (task.ts:markTaskComplete|markTaskFailed)
7. Auto-complete parent if all subtasks done
```

## State Files

| File | Purpose | Schema |
|------|---------|--------|
| `.undercity/tasks.json` | Task board | `Task[]` |
| `.undercity/worktrees.json` | Active worktrees | `{taskId: {path, branch}}` |
| `.undercity/elevator.json` | Merge queue state | `ElevatorItem[]` |
| `.undercity/rate-limit.json` | Rate limit state | `{pausedUntil?, history[]}` |
| `.undercity/recovery.json` | Interrupted batch state | `{batchId, tasks[], checkpoint}` |
| `.undercity/metrics.json` | Token usage, cost | `{tokens, cost, byModel}` |
| `.undercity/grind-events.jsonl` | Event log (append-only) | `{type, timestamp, data}` per line |

## Gotchas

**Rate limiting:**
- 429 → pause + exponential backoff (rate-limit.ts:handleRateLimitError)
- State persists across restarts
- Check with: `undercity limits`

**File conflicts:**
- Detected **before** merge (FileTracker), not after
- Conflicts → task fails, manual resolution needed

**Recovery:**
- Only ParallelSoloOrchestrator has recovery
- Auto-resumes on next `undercity grind`
- State: `.undercity/recovery.json`

**Task decomposition:**
- Enabled by default, disable with `--no-decompose`
- Creates subtasks with `parentId`
- Parent auto-completes when all subtasks done
- Decomposed tasks skipped (`isDecomposed=true`)

**Model tier routing:**
- Assessed by task-decomposer.ts
- haiku: single-file, simple
- sonnet: multi-file, standard
- opus: architectural, deep reasoning

**Worktrees:**
- Location: `<repo>-worktrees/task-<id>`
- Cleanup: automatic on success (WorktreeManager.cleanup)
- Leaks: check `git worktree list`, remove manually

**Elevator (merge queue):**
- SERIAL (no parallel merges)
- Retry: 3 attempts, exponential backoff
- Strategies: default → theirs → ours
- State persists: `.undercity/elevator.json`

**Commands:**
- `solo` is deprecated, use `grind` instead
- `grind` without args → process task board
- `grind "goal"` → run single task directly

## Critical Paths

**Add task:** CLI → task.ts:addGoal() → `.undercity/tasks.json`

**Run task:**
- `grind "goal"` → ParallelSoloOrchestrator.runParallel(["goal"])
- `grind` → task.ts:getAllItems() → ParallelSoloOrchestrator.runParallel()

**Merge:**
- SoloOrchestrator success → Elevator.queueMerge()
- Elevator.processMergeQueue() → rebase → test → merge → push
- Serial execution (one at a time)

**Monitor:**
- Snapshot: `undercity limits` → live-metrics.ts
- Live: `undercity watch` → dashboard.ts (TUI)
- Status: `undercity status` → grind-events.ts

## Config

**Hierarchy (highest → lowest priority):**
1. CLI flags
2. `.undercityrc` (cwd)
3. `~/.undercityrc` (home)
4. Built-in defaults

**Load:** config.ts:loadConfig(), mergeWithConfig()

**Env vars:**
- `ANTHROPIC_API_KEY` - Required
- `LOG_LEVEL` - debug|info|warn|error

## Output Modes

**output.ts:** Auto-detects TTY (human) vs pipe (agent JSON)

**Force:** `--human` or `--agent` flag

**Usage:** Import from output.ts, call functions like `info()`, `error()`, `header()`, `metrics()`
