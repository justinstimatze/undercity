# Codebase Map

## Module Inventory

| Module | Key Files | Purpose |
|--------|-----------|---------|
| **CLI** | `cli.ts`, `commands/{task,mixed,analysis,experiment,rag}.ts` | Command routing, handlers |
| **Execution** | `orchestrator.ts`, `worker.ts`, `worker/*.ts` | Parallel task execution in worktrees |
| **Git** | `git.ts`, `merge-queue.ts`, `worktree-manager.ts` | Worktree isolation, serial merge queue |
| **Planning** | `task-planner.ts`, `task-decomposer.ts`, `complexity.ts` | Pre-execution planning, decomposition |
| **Learning** | `knowledge.ts`, `task-file-patterns.ts`, `error-fix-patterns.ts`, `capability-ledger.ts`, `decision-tracker.ts` | Knowledge compounding, patterns |
| **PM** | `automated-pm.ts`, `task-classifier.ts` | Decision resolution, task generation |
| **RAG** | `rag/{engine,database,hybrid-search,embedder,chunker}.ts` | Vector + FTS5 semantic search |
| **Infrastructure** | `storage.ts`, `task.ts`, `persistence.ts`, `verification.ts`, `review.ts`, `config.ts`, `constants.ts`, `types.ts`, `output.ts`, `logger.ts`, `context-builder.ts` | Storage, verification, config, constants, types |
| **Analysis** | `metrics.ts`, `feedback-metrics.ts`, `self-tuning.ts`, `effectiveness-analysis.ts`, `experiment.ts` | Metrics, routing, A/B testing |

## Task -> File Mapping

**I need to:**
- Add/query/update tasks -> `task.ts`
- Run a single task -> `worker.ts` (TaskWorker, runs in worktree)
- Run tasks in parallel -> `orchestrator.ts` (Orchestrator)
- Isolate tasks in git worktrees -> `worktree-manager.ts`
- Merge branches serially -> `merge-queue.ts` (MergeQueue class)
- Lock JSON state files -> `file-lock.ts` (withFileLock, withFileLockAsync)
- Create pre-execution plans with review -> `task-planner.ts` (planTaskWithReview)
- Check task complexity -> `complexity.ts` or `task-decomposer.ts`
- Run verification (build/test/lint) -> `verification.ts`
- Generate codebase context -> `context.ts` (summarization) + `context-builder.ts` (pre-flight preparation)
- Query symbol definitions -> `ast-index.ts` (ASTIndexManager)
- Persist state -> `persistence.ts`
- Store/retrieve learnings -> `knowledge.ts`
- Resolve decisions via PM -> `automated-pm.ts` (quickDecision, pmDecide)
- Generate new tasks via PM -> `automated-pm.ts` (pmPropose, pmIdeate)
- Track task-file patterns -> `task-file-patterns.ts`
- Track error-fix patterns -> `error-fix-patterns.ts`
- Index content for semantic search -> `rag/engine.ts` (RAGEngine)
- Output to user -> `output.ts`
- Log structured events -> `logger.ts` or `dual-logger.ts` (workers)

## grind Flow

```
Orchestrator.run():
1. Check recovery (hasActiveRecovery) -> resume if needed
2. Fetch tasks (task.ts:getAllItems) -> filter: pending|in_progress, !isDecomposed
3. Decompose (task-decomposer:checkAndDecompose) -> atomic subtasks + model tier
4. Group by model -> execute sonnet -> opus (cheapest first)
5. Per task:
   - Spawn worktree (WorktreeManager.createWorktree)
   - Run TaskWorker (AI does work)
   - Check conflicts (FileTracker.checkConflicts)
   - Queue merge (MergeQueue.add)
   - Process MergeQueue (serial rebase -> test -> merge)
6. Update status (task.ts:markTaskComplete|markTaskFailed)
7. Auto-complete parent if all subtasks done
```

## Task Execution Lifecycle

```
PLANNING -> CONTEXT -> EXECUTION -> VERIFICATION -> REVIEW -> COMPLETION
                          ^              |              |
                          |    failure   |    failure   |
                          +--- RETRY <---+--------------+

Planning: findRelevantLearnings + findRelevantFiles + planTaskWithReview
Context:  inject knowledge, file suggestions, co-modification hints, error warnings
Execution: runAgentLoop (SDK query with injected context)
Verification: verifyWork() runs typecheck+lint+tests in parallel (external, not agent)
Review: runEscalatingReview() sonnet->sonnet->opus (capped by complexity)
Completion: extract learnings, record patterns, commit, queue merge
```

## State Files

| File | Purpose | Backend |
|------|---------|---------|
| `.undercity/undercity.db` | Task board | SQLite (WAL) |
| `.undercity/knowledge.json` | Accumulated learnings | JSON + file-lock |
| `.undercity/routing-profile.json` | Learned model routing | JSON + file-lock |
| `.undercity/rag.db` | RAG index (vectors + FTS5) | SQLite (WAL) |
| `.undercity/parallel-recovery.json` | Crash recovery | JSON |
| `.undercity/grind-events.jsonl` | Event log (append-only) | JSONL |
| `.undercity/live-metrics.json` | Running totals for dashboard | JSON |
| `.undercity/ast-index.json` | Persistent AST index | JSON |

Note: task-file-patterns, error-fix-patterns, and decision-tracker are SQLite-backed via `storage.ts`.

## Gotchas

**Rate limiting:** Dynamic pacing from claude.ai. First-time: `undercity usage --login`. Cached 5 min.

**File conflicts:** Detected before merge (FileTracker), not after. Conflicts -> task fails.

**Recovery:** Auto-resumes on next `undercity grind` from `parallel-recovery.json`.

**Task decomposition:** Enabled by default (`--no-decompose` to skip). Creates subtasks with `parentId`. Parent auto-completes when all subtasks done.

**Worktrees:** Location `<repo>-worktrees/task-<id>`. Auto-cleanup on success. Leaks: `git worktree list`.

**MergeQueue:** Serial only. Retry up to MAX_MERGE_RETRIES (3) times per branch. Tasks that fail all retries remain pending for manual intervention.

**Commands:** `grind` = process board. `grind "goal"` = run single task.

## Critical Paths

**Add task:** CLI -> task.ts:addGoal() -> `.undercity/undercity.db`

**Run task:** `grind "goal"` -> Orchestrator.run(["goal"]) OR `grind` -> task.ts:getAllItems() -> Orchestrator.run()

**Merge:** TaskWorker success -> MergeQueue.add() -> processAll() -> rebase -> test -> merge (serial)

## Config

Hierarchy: CLI flags > `.undercityrc` (cwd) > `~/.undercityrc` (home) > defaults.
Auth: Claude Max OAuth via Agent SDK (no API key).
Output: Auto-detects TTY (human) vs pipe (agent JSON). Force with `--human` or `--agent`.
