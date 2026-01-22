# Codebase Map

## File → Purpose

| File | Purpose | Key Exports |
|------|---------|-------------|
| **cli.ts** | CLI entry, routes to command modules | - |
| **commands/task.ts** | Task board commands (tasks, add, work, plan, plans, import-plan, reconcile, triage, prune) | taskCommands |
| **commands/plan-handlers.ts** | Plan-task linkage command handlers | handlePlan (linkage) |
| **commands/mixed.ts** | Execution + learning commands (grind, pm, usage, knowledge, decide, tuning, watch) | mixedCommands |
| **commands/analysis.ts** | Metrics/analysis commands (patterns, decisions, ax, postmortem, effectiveness) | analysisCommands |
| **commands/analysis-handlers.ts** | Analysis command handlers (postmortem) | handlePostmortem |
| **commands/experiment.ts** | A/B testing CLI (create, activate, results, recommend) | experimentCommands |
| **commands/rag.ts** | RAG CLI (index, search, list, stats, remove) | ragCommands |
| **orchestrator.ts** | Main production orchestrator, parallel execution | Orchestrator |
| **worker.ts** | Single-task executor, runs in worktree | TaskWorker |
| **worker/index.ts** | Worker module barrel export | (re-exports all worker modules) |
| **worker/state.ts** | Worker state types and initialization | TaskIdentity, TaskExecutionState, createInitialState |
| **worker/agent-loop.ts** | Agent SDK query loop execution | runAgentLoop, buildStopHooks, AgentLoopConfig |
| **worker/verification-handler.ts** | Verification result handling | handleAlreadyComplete, recordVerificationFailure, buildEnhancedFeedback |
| **worker/meta-task-handler.ts** | Meta-task and research task handling | handleMetaTaskResult, handleResearchTaskResult |
| **worker/context-builder.ts** | Build context sections for agent prompts | buildContextSection |
| **worker/prompt-builder.ts** | Build agent prompts | buildPrompt |
| **worker/escalation-logic.ts** | Model escalation decisions | shouldEscalate, getNextModel |
| **worker/stop-hooks.ts** | Agent stop hook configuration | buildStopHooks |
| **worker/success-recording.ts** | Record successful task completion | recordSuccess |
| **worker/failure-recording.ts** | Record task failures | recordFailure |
| **worker/task-helpers.ts** | Task utility functions | isMetaTask, isResearchTask |
| **worker/task-results.ts** | Task result type construction | buildTaskResult |
| **worker/message-tracker.ts** | Track agent messages during execution | MessageTracker |
| **worker/agent-execution.ts** | Agent execution utilities | executeWithRetry |
| **orchestrator/index.ts** | Orchestrator module barrel export | (re-exports all orchestrator modules) |
| **orchestrator/health-monitoring.ts** | Worker health monitoring, stuck detection | startHealthMonitoring, checkWorkerHealth, handleStuckWorker |
| **orchestrator/budget-and-aggregation.ts** | Opus budget tracking, result aggregation | canUseOpusBudget, aggregateTaskResults, buildSummaryItems |
| **orchestrator/conflict-detection.ts** | File conflict detection for parallel tasks | detectConflicts |
| **orchestrator/git-utils.ts** | Git utilities for orchestrator | getMainBranch, getCurrentCommit |
| **orchestrator/merge-helpers.ts** | Merge queue helpers | processMerge, queueForMerge |
| **orchestrator/recommendation-handlers.ts** | Recommendation output handlers | handleRecommendations |
| **orchestrator/recovery-helpers.ts** | Crash recovery helpers | saveRecoveryState, loadRecoveryState |
| **orchestrator/result-handlers.ts** | Task result processing | handleTaskResult, recordTaskCompletion |
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
| **plan-link.ts** | Plan-task linkage (frontmatter metadata) | linkTasksToPlan, findLinkedPlans, getPlanStatus |
| **ticket-loader.ts** | Load rich tickets from YAML/JSON/MD files | loadTicketFromFile, isTicketFile, TicketFileSchema |
| **complexity.ts** | Assess task complexity | assessComplexityFast |
| **persistence.ts** | State management, file I/O for `.undercity/*` | Persistence |
| **dashboard.ts** | TUI (blessed-based) | launchDashboard |
| **server.ts** | HTTP daemon for external control | UndercityServer, queryDaemon |
| **config.ts** | Config loading (.undercityrc hierarchy) | loadConfig, mergeWithConfig |
| **types.ts** | Core type definitions | SessionStatus, AgentType, Task, TicketContent, MergeQueueItem |
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
| **task-planner.ts** | Pre-execution planning, tiered review, PM integration | planTaskWithReview, ExecutionPlan |
| **capability-ledger.ts** | Track model success by keyword patterns | updateLedger, getRecommendedModel, getLedgerStats |
| **experiment.ts** | A/B testing framework for grind | ExperimentManager, getExperimentManager |
| **effectiveness-analysis.ts** | Analyze learning systems effectiveness | analyzeEffectiveness, formatEffectivenessReport |
| **feedback-metrics.ts** | Historical metrics analysis, success rates | analyzeMetrics, suggestModelTier, analyzeTaskPatterns |
| **self-tuning.ts** | Learned routing profile from historical data | loadRoutingProfile, computeOptimalThresholds, maybeUpdateProfile |
| **knowledge.ts** | Knowledge compounding (learnings from tasks) | loadKnowledge, addLearning, findRelevantLearnings |
| **knowledge-extractor.ts** | Extract learnings from task completions | extractLearnings |
| **mcp-tools.ts** | MCP tool definitions for knowledge access | knowledgeTools, knowledgeSearchTool |
| **mcp-protocol.ts** | MCP JSON-RPC 2.0 handler | MCPProtocolHandler, handleMCPRequest |
| **decision-tracker.ts** | Capture/resolve agent decisions | captureDecision, resolveDecision, getPendingDecisions |
| **automated-pm.ts** | Automated PM: decision resolution, task generation, web research | pmDecide, quickDecision, pmResearch, pmPropose, pmIdeate |
| **task-file-patterns.ts** | Task→file correlations, co-modification | recordTaskFiles, findRelevantFiles, findCoModifiedFiles |
| **error-fix-patterns.ts** | Error→fix patterns for known issues | recordErrorFix, findMatchingFix, getErrorFixStats |
| **ax-programs.ts** | Ax/DSPy self-improving prompts | getAxProgramStats |
| **claude-usage.ts** | Fetch live Claude Max usage from claude.ai | fetchClaudeUsage, loginToClaude |
| **rag/index.ts** | RAG module barrel export | RAGEngine, HybridSearcher, etc. |
| **rag/types.ts** | RAG type definitions | Document, Chunk, SearchResult, SearchOptions |
| **rag/database.ts** | SQLite storage with sqlite-vec for vectors | getRAGDatabase, insertDocument, vectorSearch, ftsSearch |
| **rag/embedder.ts** | Local embeddings via all-MiniLM-L6-v2 | LocalEmbedder, getEmbedder |
| **rag/chunker.ts** | Paragraph-based chunking with overlap | ParagraphChunker, createChunker |
| **rag/hybrid-search.ts** | Combines vector + FTS5 via RRF | HybridSearcher |
| **rag/engine.ts** | Main RAG orchestrator | RAGEngine |
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
- Load rich tickets from files → `ticket-loader.ts` (YAML/JSON/MD with frontmatter)
- Link tasks to Claude Code plans → `plan-link.ts` (frontmatter metadata)
- Find plans for a task → `plan-link.ts` (findPlanForTask)
- Create pre-execution plans with review → `task-planner.ts` (planTaskWithReview)
- Check task complexity → `complexity.ts` or `task-decomposer.ts`
- Analyze historical metrics → `feedback-metrics.ts`
- Run post-mortem analysis → `commands/analysis-handlers.ts` (handlePostmortem)
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
- Query knowledge via MCP → `mcp-protocol.ts` (MCPProtocolHandler)
- Capture/resolve agent decisions → `decision-tracker.ts`
- Resolve decisions via PM → `automated-pm.ts` (quickDecision, pmDecide)
- Generate new tasks via PM → `automated-pm.ts` (pmPropose, pmIdeate)
- Research topics via PM → `automated-pm.ts` (pmResearch)
- Track task→file patterns → `task-file-patterns.ts`
- Track error→fix patterns → `error-fix-patterns.ts`
- Fetch Claude Max usage → `claude-usage.ts`
- View Ax/DSPy training stats → `ax-programs.ts`
- Manage A/B experiments → `commands/experiment.ts` (create, activate, results, recommend)
- Analyze learning effectiveness → `effectiveness-analysis.ts` (analyzeEffectiveness)
- Find relevant files via AST → `ast-index.ts` (findRelevantFiles)
- Understand worker state types → `worker/state.ts` (TaskIdentity, TaskExecutionState)
- Run agent execution loop → `worker/agent-loop.ts` (runAgentLoop)
- Handle verification results → `worker/verification-handler.ts`
- Handle meta/research tasks → `worker/meta-task-handler.ts`
- Monitor worker health → `orchestrator/health-monitoring.ts` (checkWorkerHealth, handleStuckWorker)
- Track opus budget → `orchestrator/budget-and-aggregation.ts` (canUseOpusBudget)
- Aggregate task results → `orchestrator/budget-and-aggregation.ts` (aggregateTaskResults)
- Index content for semantic search → `rag/engine.ts` (RAGEngine.indexContent, indexFile)
- Search indexed content → `rag/engine.ts` (RAGEngine.search)
- Hybrid vector + keyword search → `rag/hybrid-search.ts` (HybridSearcher)
- Chunk content for indexing → `rag/chunker.ts` (ParagraphChunker)
- Generate embeddings → `rag/embedder.ts` (LocalEmbedder)
- Store/query RAG database → `rag/database.ts` (vectorSearch, ftsSearch)

## Orchestrators

| Class | File | Use | Parallel | Infrastructure |
|-------|------|-----|----------|----------------|
| Orchestrator | orchestrator.ts | **Main production** (grind) | Yes (1-5) | Worktree, MergeQueue, RateLimit, FileTracker, Recovery |
| TaskWorker | worker.ts | Single task executor | No | Runs in worktree, delegates to worker/* modules |

**Decision:** Use Orchestrator for everything (even single tasks with maxConcurrent=1).

## Worker Module Architecture

TaskWorker delegates to focused modules in `worker/*` for maintainability:

```
TaskWorker (worker.ts)
├── state.ts              # TaskIdentity, TaskExecutionState types
├── agent-loop.ts         # SDK query loop (runAgentLoop, buildStopHooks)
├── verification-handler.ts # Handle verification results
├── meta-task-handler.ts  # Meta-task and research task handling
├── context-builder.ts    # Build context for agent prompts
├── prompt-builder.ts     # Build agent prompts
├── escalation-logic.ts   # Model escalation decisions
└── ...                   # Additional helpers
```

**Pattern:** Focused delegates with dependency injection. State passed by reference, dependencies injected as functions.

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

## Task Execution Lifecycle (Learning System Integration)

Shows which learning systems are invoked at each phase of task execution.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ PLANNING PHASE (worker.ts:runPlanningPhase)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  findRelevantLearnings()        ← knowledge.ts                              │
│  findRelevantFiles()            ← task-file-patterns.ts                     │
│  planTaskWithReview()           ← task-planner.ts                           │
│    └─ quickDecision()           ← automated-pm.ts (resolves open questions) │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ CONTEXT BUILDING (worker/context-builder.ts)                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  findRelevantLearnings()          ← knowledge.ts                            │
│  formatLearningsForPrompt()       ← knowledge.ts                            │
│  formatFileSuggestionsForPrompt() ← task-file-patterns.ts                   │
│  formatCoModificationHints()      ← task-file-patterns.ts                   │
│  getFailureWarningsForTask()      ← error-fix-patterns.ts                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION PHASE (worker/agent-loop.ts:runAgentLoop)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Agent executes with injected context                                       │
│  captureDecision()              ← decision-tracker.ts (if decisions made)   │
│  buildStopHooks()               ← worker/agent-loop.ts                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ VERIFICATION PHASE (worker/verification-handler.ts)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  runVerification()              ← verification.ts                           │
│    │                                                                        │
│    ├─ On FAILURE:                                                           │
│    │   recordVerificationFailure() ← worker/verification-handler.ts        │
│    │   recordPendingError()     ← error-fix-patterns.ts                     │
│    │   buildEnhancedFeedback()  ← worker/verification-handler.ts           │
│    │                                                                        │
│    └─ On SUCCESS:                                                           │
│        handleAlreadyComplete()  ← worker/verification-handler.ts           │
│        recordSuccessfulFix()    ← error-fix-patterns.ts                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ COMPLETION PHASE (worker.ts + orchestrator.ts)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  extractAndStoreLearnings()     ← knowledge-extractor.ts                    │
│  markLearningsUsed()            ← knowledge.ts                              │
│  recordTaskFiles()              ← task-file-patterns.ts                     │
│  updateLedger()                 ← capability-ledger.ts (orchestrator)       │
│                                                                             │
│  On FAILURE:                                                                │
│    recordPermanentFailure()     ← error-fix-patterns.ts                     │
│                                                                             │
│  Meta/Research tasks:                                                       │
│    handleMetaTaskResult()       ← worker/meta-task-handler.ts              │
│    handleResearchTaskResult()   ← worker/meta-task-handler.ts              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Learning System Call Sites

Quick reference for where each learning function is called:

| Function | File | Called From |
|----------|------|-------------|
| `findRelevantLearnings` | knowledge.ts | worker.ts, task-planner.ts, automated-pm.ts |
| `formatLearningsForPrompt` | knowledge.ts | worker.ts, task-planner.ts |
| `addLearning` | knowledge.ts | knowledge-extractor.ts |
| `markLearningsUsed` | knowledge.ts | worker.ts |
| `findRelevantFiles` | task-file-patterns.ts | worker.ts, task-planner.ts, orchestrator.ts, automated-pm.ts |
| `formatFileSuggestionsForPrompt` | task-file-patterns.ts | worker.ts |
| `formatCoModificationHints` | task-file-patterns.ts | worker.ts, worker/verification-handler.ts |
| `recordTaskFiles` | task-file-patterns.ts | worker.ts |
| `tryAutoRemediate` | error-fix-patterns.ts | worker.ts |
| `recordPendingError` | error-fix-patterns.ts | worker/verification-handler.ts |
| `recordSuccessfulFix` | error-fix-patterns.ts | worker.ts |
| `recordPermanentFailure` | error-fix-patterns.ts | worker.ts |
| `getFailureWarningsForTask` | error-fix-patterns.ts | worker.ts |
| `extractAndStoreLearnings` | knowledge-extractor.ts | worker.ts (auto-indexes to RAG) |
| `updateLedger` | capability-ledger.ts | orchestrator.ts |
| `captureDecision` | decision-tracker.ts | worker/agent-loop.ts |
| `resolveDecision` | decision-tracker.ts | automated-pm.ts, mixed-handlers.ts (auto-indexes to RAG) |
| `getRAGEngine` | rag/index.ts | knowledge-extractor.ts, decision-tracker.ts, automated-pm.ts |
| `ragEngine.search` | rag/engine.ts | automated-pm.ts (PM context gathering) |
| `ragEngine.indexContent` | rag/engine.ts | knowledge-extractor.ts, decision-tracker.ts |
| `quickDecision` | automated-pm.ts | task-planner.ts |
| `planTaskWithReview` | task-planner.ts | worker.ts |
| `runAgentLoop` | worker/agent-loop.ts | worker.ts |
| `buildStopHooks` | worker/agent-loop.ts | worker/agent-loop.ts (internal) |
| `handleAlreadyComplete` | worker/verification-handler.ts | worker.ts |
| `recordVerificationFailure` | worker/verification-handler.ts | worker.ts |
| `buildEnhancedFeedback` | worker/verification-handler.ts | worker.ts |
| `handleMetaTaskResult` | worker/meta-task-handler.ts | worker.ts |
| `handleResearchTaskResult` | worker/meta-task-handler.ts | worker.ts |

## State Files

| File | Purpose | Schema |
|------|---------|--------|
| `.undercity/undercity.db` | Task board (SQLite) | `tasks` table |
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
| `.undercity/rag.db` | RAG SQLite database (vectors + FTS5) | SQLite with sqlite-vec |

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

**Add task:** CLI → task.ts:addGoal() → `.undercity/undercity.db`

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
