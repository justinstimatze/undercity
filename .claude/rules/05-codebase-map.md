# Codebase Map

## File → Purpose

| File | Purpose | Key Exports |
|------|---------|-------------|
| **cli.ts** | CLI entry, routes to command modules | - |
| **commands/task.ts** | Task board commands (tasks, add, work, plan, import-plan, reconcile, triage, prune) | taskCommands |
| **commands/mixed.ts** | Execution + learning commands (grind, pulse, brief, decide, knowledge, usage, tuning) | mixedCommands |
| **commands/analysis.ts** | Metrics/analysis commands (patterns, decisions, ax) | analysisCommands |
| **orchestrator.ts** | Main production orchestrator, parallel execution | Orchestrator |
| **worker.ts** | Single-task executor, runs in worktree | TaskWorker |
| **supervised.ts** | Opus orchestrates workers | SupervisedOrchestrator |
| **task.ts** | Task board CRUD (add, get, mark status) | addGoal, getAllItems, markComplete, etc. |
| **worktree-manager.ts** | Git worktree isolation per task | WorktreeManager |
| **git.ts** | Git operations, branch management, fingerprinting | getCurrentBranch, rebase, merge, execGit |
| **merge-queue.ts** | Serial merge pipeline (extracted from git.ts) | MergeQueue |
| **rate-limit.ts** | 429 handling, exponential backoff | RateLimitTracker |
| **file-tracker.ts** | Pre-merge file conflict detection | FileTracker |
| **metrics.ts** | Task metrics tracking, JSONL storage | MetricsTracker, getMetricsSummary |
| **live-metrics.ts** | Running totals for dashboard display | saveLiveMetrics, loadLiveMetrics |
| **grind-events.ts** | Structured event logging (not metrics) | startGrindSession, logTaskComplete, etc. |
| **task-decomposer.ts** | Break multi-step tasks into atomic subtasks | checkAndDecompose |
| **plan-parser.ts** | Parse markdown plans into tasks | parsePlanFile, planToTasks |
| **complexity.ts** | Assess task complexity | assessComplexityFast |
| **persistence.ts** | State management, file I/O for `.undercity/*` | Persistence |
| **dashboard.ts** | TUI (blessed-based) | launchDashboard |
| **server.ts** | HTTP daemon for external control | UndercityServer, queryDaemon |
| **config.ts** | Config loading (.undercityrc hierarchy) | loadConfig, mergeWithConfig |
| **types.ts** | Core type definitions | SessionStatus, AgentType, Task, MergeQueueItem |
| **output.ts** | Structured output (human/agent modes) | info, success, error, header, metrics |
| **oracle.ts** | Oblique strategy cards | UndercityOracle |
| **context.ts** | Codebase context extraction (git grep, briefing, AST index) | prepareContext, summarizeContextForAgent |
| **ast-index.ts** | Persistent AST index for symbol/dependency lookup | ASTIndexManager, getASTIndex |
| **ts-analysis.ts** | Deep TypeScript AST analysis (ts-morph) | extractFunctionSignaturesWithTypes, getTypeDefinition |
| **verification.ts** | Build/test/lint verification loop | runVerification |
| **review.ts** | Escalating review with annealing | ReviewManager |
| **annealing-review.ts** | Simulated annealing for review temp | AnnealingReviewSchedule |
| **cache.ts** | Context caching for repeated queries | ContextCache |
| **logger.ts** | Pino-based structured logging | sessionLogger, agentLogger, gitLogger |
| **dual-logger.ts** | File + console logging for workers | DualLogger |
| **meta-tasks.ts** | Meta-task handling ([triage], [plan], etc.) | handleMetaTask |
| **task-schema.ts** | Task prefix conventions and parsing | parseTaskPrefix, TaskPrefix |
| **task-analyzer.ts** | Task → packages, files, risk scoring | TaskAnalyzer |
| **task-board-analyzer.ts** | Board-level insights, parallelization | TaskBoardAnalyzer |
| **task-scheduler.ts** | Matchmaking for compatible task sets | TaskScheduler |
| **task-planner.ts** | [plan] prefix → subtask expansion | TaskPlanner |
| **capability-ledger.ts** | Track model success by keyword patterns | updateLedger, getRecommendedModel, getLedgerStats |
| **experiment.ts** | A/B testing framework for grind | ExperimentManager, getExperimentManager |
| **feedback-metrics.ts** | Historical metrics analysis, success rates | analyzeMetrics, suggestModelTier, analyzeTaskPatterns |
| **self-tuning.ts** | Learned routing profile from historical data | loadRoutingProfile, computeOptimalThresholds, maybeUpdateProfile |
| **knowledge.ts** | Knowledge compounding (learnings from tasks) | loadKnowledge, addLearning, findRelevantLearnings |
| **knowledge-extractor.ts** | Extract learnings from task completions | extractLearnings |
| **decision-tracker.ts** | Capture/resolve agent decisions | captureDecision, resolveDecision, getPendingDecisions |
| **automated-pm.ts** | Automated PM for pm_decidable decisions | processPendingDecisions |
| **task-file-patterns.ts** | Task→file correlations, co-modification | recordTaskFiles, findRelevantFiles, findCoModifiedFiles |
| **error-fix-patterns.ts** | Error→fix patterns for known issues | recordErrorFix, findMatchingFix, getErrorFixStats |
| **ax-programs.ts** | Ax/DSPy self-improving prompts | getAxProgramStats |
| **claude-usage.ts** | Fetch live Claude Max usage from claude.ai | fetchClaudeMaxUsage |
| **index.ts** | Public API exports | - |

## Task → File Mapping

**I need to:**
- Add/query/update tasks → `task.ts`
- Run a single task → `worker.ts` (TaskWorker, runs in worktree)
- Run tasks in parallel → `orchestrator.ts` (Orchestrator)
- Isolate tasks in git worktrees → `worktree-manager.ts`
- Merge branches serially → `merge-queue.ts` (MergeQueue class)
- Handle rate limits → `rate-limit.ts`
- Check file conflicts → `file-tracker.ts`
- Track task metrics → `metrics.ts` (MetricsTracker)
- Track live token usage → `live-metrics.ts`
- Parse markdown plans → `plan-parser.ts`
- Check task complexity → `complexity.ts` or `task-decomposer.ts`
- Analyze historical metrics → `feedback-metrics.ts`
- View/tune model routing → `self-tuning.ts` (or `undercity tuning`)
- Analyze task board → `task-board-analyzer.ts`
- Schedule compatible tasks → `task-scheduler.ts`
- Generate codebase context → `context.ts`
- Query symbol definitions → `ast-index.ts` (ASTIndexManager)
- Find file dependencies → `ast-index.ts` (findImports, findImporters)
- Run verification (build/test/lint) → `verification.ts`
- Handle meta-tasks ([triage], [plan]) → `meta-tasks.ts`
- Persist state → `persistence.ts`
- Build TUI → `dashboard.ts`
- Expose HTTP API → `server.ts`
- Output to user → `output.ts`
- Log structured events → `logger.ts` or `dual-logger.ts` (workers)
- Store/retrieve learnings → `knowledge.ts`
- Extract learnings from completed tasks → `knowledge-extractor.ts`
- Capture/resolve agent decisions → `decision-tracker.ts`
- Process PM-decidable decisions → `automated-pm.ts`
- Track task→file patterns → `task-file-patterns.ts`
- Track error→fix patterns → `error-fix-patterns.ts`
- Fetch Claude Max usage → `claude-usage.ts`
- View Ax/DSPy training stats → `ax-programs.ts`

## Orchestrators

| Class | File | Use | Parallel | Infrastructure |
|-------|------|-----|----------|----------------|
| Orchestrator | orchestrator.ts | **Main production** (grind) | Yes (1-5) | Worktree, MergeQueue, RateLimit, FileTracker, Recovery |
| TaskWorker | worker.ts | Single task executor | No | Runs in worktree |
| SupervisedOrchestrator | supervised.ts | Opus orchestrates workers | No | LiveMetrics only |

**Decision:** Use Orchestrator for everything (even single tasks with maxConcurrent=1).

## grind Flow

```
Orchestrator.run():
1. Check recovery (hasActiveRecovery) → resume if needed
2. Fetch tasks (task.ts:getAllItems) → filter: pending|in_progress, !isDecomposed
3. Decompose (task-decomposer:checkAndDecompose) → atomic subtasks + model tier
4. Group by model → execute haiku → sonnet → opus (cheapest first)
5. Per task:
   - Spawn worktree (WorktreeManager.createWorktree)
   - Run TaskWorker (AI does work)
   - Check conflicts (FileTracker.checkConflicts)
   - Queue merge (MergeQueue.add)
   - Process MergeQueue (serial rebase → test → merge → push)
6. Update status (task.ts:markTaskComplete|markTaskFailed)
7. Auto-complete parent if all subtasks done
```

## State Files

| File | Purpose | Schema |
|------|---------|--------|
| `.undercity/tasks.json` | Task board | `Task[]` |
| `.undercity/knowledge.json` | Accumulated learnings | `KnowledgeBase` |
| `.undercity/decisions.json` | Decision history | `DecisionStore` |
| `.undercity/task-file-patterns.json` | Task→file correlations | `TaskFileStore` |
| `.undercity/error-fix-patterns.json` | Error→fix patterns | `ErrorFixStore` |
| `.undercity/routing-profile.json` | Learned model routing | `RoutingProfile` |
| `.undercity/worktree-state.json` | Active worktrees | `WorktreeState` |
| `.undercity/file-tracking.json` | Modified files per branch | `FileTrackingState` |
| `.undercity/rate-limit-state.json` | Rate limit state | `RateLimitState` |
| `.undercity/parallel-recovery.json` | Interrupted batch state | `ParallelRecoveryState` |
| `.undercity/live-metrics.json` | Running totals for dashboard | `LiveMetrics` |
| `.undercity/grind-events.jsonl` | Event log (append-only) | `{type, timestamp, data}` per line |
| `.undercity/ast-index.json` | Persistent AST index | `ASTIndex` |
| `.undercity/experiments.json` | A/B test state | `ExperimentStorage` |
| `.undercity/ax-training.json` | Ax/DSPy examples | `AxTrainingData` |
| `.undercity/usage-cache.json` | Claude Max usage cache | `{usage, fetchedAt}` |
| `.undercity/daemon.json` | Daemon PID and port | `{pid, port}` |

## Gotchas

**Rate limiting:**
- Dynamic pacing based on live Claude Max usage
- Fetches real limits from claude.ai (`undercity usage`)
- First-time setup: `undercity usage --login`
- Usage cached 5 minutes

**File conflicts:**
- Detected **before** merge (FileTracker), not after
- Conflicts → task fails, manual resolution needed

**Recovery:**
- Orchestrator has crash recovery
- Auto-resumes on next `undercity grind`
- State: `.undercity/parallel-recovery.json`

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

**MergeQueue:**
- SERIAL (no parallel merges)
- Retry: 3 attempts, exponential backoff
- Strategies: default → theirs → ours
- In-memory only (no persistence)

**Commands:**
- `grind` without args → process task board
- `grind "goal"` → run single task directly

## Critical Paths

**Add task:** CLI → task.ts:addGoal() → `.undercity/tasks.json`

**Run task:**
- `grind "goal"` → Orchestrator.run(["goal"])
- `grind` → task.ts:getAllItems() → Orchestrator.run()

**Merge:**
- TaskWorker success → MergeQueue.add()
- MergeQueue.processAll() → rebase → test → merge → push
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
- `LOG_LEVEL` - debug|info|warn|error (optional)

**Auth:** Claude Max OAuth via Agent SDK (no API key needed)

## Output Modes

**output.ts:** Auto-detects TTY (human) vs pipe (agent JSON)

**Force:** `--human` or `--agent` flag

**Usage:** Import from output.ts, call functions like `info()`, `error()`, `header()`, `metrics()`
