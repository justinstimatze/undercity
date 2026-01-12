# Undercity Architecture

Agent-optimized reference. Mappings over prose.

## File → Function → Behavior

| File | Key Exports | What It Does |
|------|-------------|--------------|
| `cli.ts` | `program` | CLI entry, routes to command modules |
| `commands/task.ts` | `taskCommands.register()` | Task board: `tasks`, `add`, `load`, `import-plan`, `plan`, `work`, `task-analyze`, `task-status` |
| `commands/mixed.ts` | `mixedCommands.register()` | Execution: `solo`, `grind`, `limits`, `init`, `setup`, `oracle`, `config`, `watch`, `serve`, `daemon`, `status` |
| `commands/analysis.ts` | `analysisCommands.register()` | Metrics: `metrics`, `complexity-metrics`, `enhanced-metrics`, `escalation-patterns`, `benchmark`, `semantic-check` |
| `orchestrator.ts` | `Orchestrator.run()` | **Main orchestrator**: parallel execution, worktrees, recovery, merge queue |
| `worker.ts` | `TaskWorker.run()` | Single-task executor, runs in worktree |
| `supervised.ts` | `SupervisedOrchestrator` | Opus orchestrates workers |
| `task.ts` | `addGoal()`, `getAllItems()`, `markComplete()`, `markFailed()`, `markInProgress()` | Task board CRUD |
| `worktree-manager.ts` | `WorktreeManager.createWorktree()`, `.cleanup()` | Git worktree isolation per task |
| `git.ts` | `MergeQueue.add()`, `MergeQueue.processAll()`, `rebase()` | Merge queue: serial rebase→test→merge |
| `rate-limit.ts` | `RateLimitTracker.isPaused()`, `.handleRateLimitError()` | 429 handling, exponential backoff |
| `file-tracker.ts` | `FileTracker.checkConflicts()` | Pre-merge conflict detection |
| `complexity.ts` | `assessComplexityFast()`, `assessComplexityQuantitative()`, `getTeamComposition()` | Task complexity → model routing |
| `context.ts` | `prepareContext()`, `summarizeContextForAgent()` | Pre-flight context extraction (FREE, no LLM) |
| `task-decomposer.ts` | `checkAndDecompose()` | Multi-step → atomic subtasks + model recommendation |
| `task-analyzer.ts` | `TaskAnalyzer.analyzeTask()` | Package detection, file estimation, risk scoring |
| `plan-parser.ts` | `parsePlanFile()`, `planToTasks()` | Markdown plan → discrete tasks |
| `persistence.ts` | `Persistence.save()`, `.load()` | State file I/O |
| `live-metrics.ts` | `saveLiveMetrics()`, `loadLiveMetrics()` | Token/cost tracking |
| `grind-events.ts` | `startGrindSession()`, `logTaskComplete()`, `logTaskFailed()` | Event logging |
| `server.ts` | `UndercityServer.start()`, `queryDaemon()` | HTTP daemon |
| `dashboard.ts` | `launchDashboard()` | TUI (blessed) |
| `config.ts` | `loadConfig()`, `mergeWithConfig()` | Config loading |
| `output.ts` | `info()`, `error()`, `summary()`, `metrics()` | Structured output |
| `semantic-analyzer/analyzer.ts` | `SemanticAnalyzer.analyze()` | Semantic density analysis |
| `semantic-analyzer/types.ts` | `SemanticReport`, `FileAnalysis`, `Issue`, `Action` | Analyzer types |

## Intent → Code Path

| I need to... | File | Function | Notes |
|--------------|------|----------|-------|
| Add a task | `task.ts` | `addGoal(objective)` | Returns `Task` |
| Run tasks autonomously | `orchestrator.ts` | `Orchestrator.run(tasks)` | Main entry point |
| Run single task | `orchestrator.ts` | `run([goal])` with `maxConcurrent=1` | Same orchestrator, single task |
| Assess task complexity | `complexity.ts` | `assessComplexityFast(task)` | Fast, no API. Returns `ComplexityAssessment` |
| Get quantitative metrics | `complexity.ts` | `assessComplexityQuantitative(task, files)` | Uses file metrics |
| Get context for agent | `context.ts` | `prepareContext(task)` | FREE, no LLM tokens |
| Decompose complex task | `task-decomposer.ts` | `checkAndDecompose(objective)` | Returns subtasks + model tier |
| Analyze task risk | `task-analyzer.ts` | `TaskAnalyzer.analyzeTask(task)` | Package boundaries, risk score |
| Parse plan file | `plan-parser.ts` | `parsePlanFile(content)` | Returns `ParsedPlan` |
| Create worktree | `worktree-manager.ts` | `WorktreeManager.createWorktree()` | Returns path |
| Queue merge | `git.ts` | `MergeQueue.add(branch)` | Serial processing |
| Check conflicts | `file-tracker.ts` | `FileTracker.checkConflicts(files)` | Pre-merge detection |
| Handle rate limit | `rate-limit.ts` | `RateLimitTracker.handleRateLimitError(error)` | Auto-pause + backoff |
| Persist state | `persistence.ts` | `Persistence.saveState(key, data)` | JSON file I/O |
| Track tokens | `live-metrics.ts` | `saveLiveMetrics(metrics)` | Model breakdown |
| Log grind event | `grind-events.ts` | `logTaskComplete()`, `logTaskFailed()` | Append-only JSONL |
| Analyze semantic density | `semantic-analyzer/` | `runSemanticCheck({rootDir})` | Returns `SemanticReport` |

## Decision Trees

### Which Orchestrator?

```
Always use Orchestrator
├── Multiple tasks → run(tasks)
├── Single task → run([goal]) with maxConcurrent=1
└── TaskWorker is spawned per-task by Orchestrator
```

### Which Model Tier?

```
assessComplexityFast(task) returns level:
├── trivial (score ≤1) → haiku
│   └── Typos, comments, local-tool tasks (format, lint, test)
├── simple (score ≤3) → sonnet
│   └── Single function, add log, small change
├── standard (score ≤6) → sonnet + review
│   └── Feature, bug fix, add tests
├── complex (score ≤9) → opus
│   └── Refactor, multi-file, architecture
└── critical (score >9) → opus + full chain
    └── Security, auth, breaking changes
```

### Local Tool Detection (FREE)

```
canHandleWithLocalTools(task) → LocalToolResult | null
├── format/prettier → pnpm format
├── lint → pnpm lint:fix
├── typecheck → pnpm typecheck
├── test → pnpm test
├── build → pnpm build
├── organize/sort imports → pnpm check:fix
└── spellcheck → pnpm spell
```

### Team Composition (getTeamComposition)

```
level → { workerModel, validatorCount, needsPlanning }
├── trivial → haiku worker, 0 validators, no planning
├── simple → sonnet worker, 1 haiku validator
├── standard → sonnet worker, 2 sonnet validators, sonnet planner
├── complex → sonnet worker, 3 sonnet validators, opus planner
└── critical → sonnet worker, 5 sonnet validators, opus planner
```

## State Files

| File | Purpose | Format |
|------|---------|--------|
| `.undercity/tasks.json` | Task board | `Task[]` |
| `.undercity/worktrees.json` | Active worktrees | `{taskId: {path, branch}}` |
| `.undercity/merge-queue.json` | Merge queue | `MergeQueueItem[]` |
| `.undercity/rate-limit.json` | Rate limit state | `{pause, tasks[]}` |
| `.undercity/parallel-recovery.json` | Crash recovery | `ParallelRecoveryState` |
| `.undercity/live-metrics.json` | Token/cost | `{byModel, cost, queries}` |
| `.undercity/grind-events.jsonl` | Event log | JSONL, append-only |

## Core Types (types.ts)

| Type | Values | Used For |
|------|--------|----------|
| `ComplexityLevel` | `trivial`, `simple`, `standard`, `complex`, `critical` | Model routing |
| `ModelChoice` | `haiku`, `sonnet`, `opus` | API calls |
| `SessionStatus` | `planning`, `executing`, `merging`, `complete`, `failed` | Session state |
| `MergeStatus` | `pending`, `rebasing`, `testing`, `merging`, `complete`, `conflict` | MergeQueue |
| `AgentType` | `scout`, `planner`, `builder`, `reviewer` | Agent roles |

### Task Interface

```typescript
interface Task {
  id: string;
  objective: string;
  status: 'pending' | 'in_progress' | 'complete' | 'failed';
  priority?: number;
  parentId?: string;        // If subtask
  isDecomposed?: boolean;   // If parent (has subtasks)
  dependsOn?: string[];     // Task dependencies
  conflicts?: string[];     // Package conflicts
}
```

### ComplexityAssessment Interface

```typescript
interface ComplexityAssessment {
  level: ComplexityLevel;
  confidence: number;          // 0-1
  model: ModelChoice;          // Recommended model
  estimatedScope: 'single-file' | 'few-files' | 'many-files' | 'cross-package';
  signals: string[];           // What influenced decision
  score: number;               // Raw complexity score
  team: TeamComposition;       // Worker + validator config
  localTool?: LocalToolResult; // If FREE local execution possible
  metrics?: QuantitativeMetrics; // File-based metrics if available
}
```

## Execution Flow

### grind Command

```
undercity grind [goal]
├── goal provided? → runParallel([goal])
└── no goal → fetch getAllItems()
    ├── hasActiveRecovery? → resumeRecovery()
    ├── decompose tasks → checkAndDecompose()
    │   └── Creates subtasks + assigns model tier
    ├── group by model tier (haiku → sonnet → opus)
    └── per task:
        ├── createWorktree()
        ├── runTask() with assigned model
        ├── checkConflicts()
        ├── queueMerge()
        └── processMergeQueue()
```

### Task Lifecycle

```
pending → in_progress → complete|failed
├── addGoal() → pending
├── markInProgress(id, sessionId)
└── markComplete(id) | markFailed(id, error)
```

### MergeQueue

```
task complete → MergeQueue.add(branch)
└── MergeQueue.processAll() [SERIAL]
    ├── rebase onto main
    ├── run verification
    ├── fast-forward merge
    └── retry on failure (3x: default → theirs → ours)
```

## CLI Commands

| Command | Purpose | Key Options |
|---------|---------|-------------|
| `grind [goal]` | Run tasks | `-p <n>` parallel, `-n <n>` count, `--no-decompose` |
| `tasks` | Show board | - |
| `add <goal>` | Add task | - |
| `import-plan <file>` | Plan → tasks | `--dry-run` |
| `limits` | Usage snapshot | - |
| `watch` | TUI dashboard | - |
| `status` | Grind status | `--events`, `--human` |
| `semantic-check` | Density analysis | `--fix`, `--human` |
| `metrics` | Performance | - |
| `complexity-metrics` | By complexity | `--json` |

## Complexity Signals

### Keywords (assessComplexityFast)

| Level | Keywords |
|-------|----------|
| trivial | typo, comment, rename, version bump |
| simple | add log, simple fix, minor, tweak |
| standard | add feature, implement, create, fix bug |
| complex | refactor, migrate, redesign, cross-package |
| critical | security, authentication, payment, production |

### Quantitative Metrics (assessComplexityQuantitative)

| Factor | Score Impact |
|--------|--------------|
| 1 file | +0 |
| 2-3 files | +1 |
| 4-7 files | +2 |
| 8+ files | +3 |
| Cross-package | +3 |
| Code health <5 | +3 |
| Git hotspots | +count |
| Bug-prone files | +count×2 |

## Context Limits (context.ts)

| Agent Type | Limit | Use Case |
|------------|-------|----------|
| scout | 1000 chars | Just the goal |
| builder | 5000 chars | Implementation details |
| reviewer | 3000 chars | Review requirements |
| planner | 10000 chars | Full scout report |

## Semantic Analyzer

### File Types

| Pattern | Type | Fact Extraction |
|---------|------|-----------------|
| `.claude/rules/**/*.md` | claude_rules | Mappings, constraints, commands |
| `*.md` | docs | Commands, tables, decision branches |
| `*.ts` | code | Types, functions, constants |
| `__tests__/**` | test | Function signatures |
| `*.json` | config | Key-value pairs |

### Issue Types

| Type | Severity | Auto-fixable |
|------|----------|--------------|
| `redundant_comment` | medium | Yes |
| `unclear_naming` | low | Partial |
| `low_density` | medium | No |
| `duplicate_definition` | high | No |

## Environment

| Variable | Purpose | Required |
|----------|---------|----------|
| `ANTHROPIC_API_KEY` | API auth | Yes |
| `LOG_LEVEL` | Logging | No (default: info) |

## Module Dependencies

```
cli.ts
└── commands/*.ts
    ├── task.ts → task.ts, plan-parser.ts
    ├── mixed.ts → orchestrator.ts, persistence.ts, rate-limit.ts
    └── analysis.ts → metrics-collector.ts, semantic-analyzer/

orchestrator.ts
├── worker.ts (task execution)
├── worktree-manager.ts (isolation)
├── file-tracker.ts (conflicts)
├── rate-limit.ts (429 handling)
└── persistence.ts (state)

complexity.ts
├── context.ts (prepareContext for full assessment)
└── logger.ts

context.ts
├── ts-morph (type extraction)
└── exec (git grep, ast-grep)
```

## Gotchas

| Situation | Behavior | Solution |
|-----------|----------|----------|
| 429 rate limit | Auto-pause + backoff | Check `undercity limits` |
| File conflicts | Task fails pre-merge | Manual resolution |
| Crash during batch | Recovery state saved | Auto-resumes on `grind` |
| Decomposed parent | Skipped in grind | Subtasks run instead |
| Worktree leak | Manual cleanup | `git worktree list` + remove |
| Stale in_progress | Picked up on grind | Reset or complete |
