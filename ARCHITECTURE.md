# Undercity Architecture

Agent-optimized reference for codebase navigation. Mappings over prose.

## Quick Lookup Tables

### File → Purpose → Key Functions

| File | Purpose | Key Exports |
|------|---------|-------------|
| `cli.ts` | CLI entry, command routing | `program` |
| `commands/task.ts` | Task board commands | `taskCommands.register()` |
| `commands/mixed.ts` | Grind/solo/daemon commands | `mixedCommands.register()` |
| `commands/analysis.ts` | Metrics/analysis commands | `analysisCommands.register()` |
| `parallel-solo.ts` | **Main orchestrator** (grind) | `ParallelSoloOrchestrator.runParallel()` |
| `solo.ts` | Single-task executor (deprecated) | `SoloOrchestrator.runTask()` |
| `task.ts` | Task board CRUD | `addGoal()`, `getAllItems()`, `markComplete()` |
| `worktree-manager.ts` | Git worktree isolation | `WorktreeManager.createWorktree()` |
| `git.ts` | Git ops, merge queue | `Elevator.queueMerge()`, `rebase()` |
| `rate-limit.ts` | 429 handling | `RateLimitTracker.isPaused()` |
| `file-tracker.ts` | Pre-merge conflict detection | `FileTracker.checkConflicts()` |
| `complexity.ts` | Task complexity assessment | `assessComplexityFast()`, `getTeamComposition()` |
| `context.ts` | Pre-flight context preparation | `prepareContext()`, `summarizeContextForAgent()` |
| `task-decomposer.ts` | Multi-step → atomic subtasks | `checkAndDecompose()` |
| `plan-parser.ts` | Markdown plan → tasks | `parsePlanFile()`, `planToTasks()` |
| `persistence.ts` | State file I/O | `Persistence.save()`, `.load()` |
| `live-metrics.ts` | Token/cost tracking | `saveLiveMetrics()`, `loadLiveMetrics()` |
| `grind-events.ts` | Event logging | `logTaskComplete()`, `logTaskFailed()` |
| `server.ts` | HTTP daemon | `UndercityServer.start()` |
| `dashboard.ts` | TUI (blessed) | `launchDashboard()` |
| `config.ts` | Config loading | `loadConfig()`, `mergeWithConfig()` |
| `output.ts` | Structured output | `info()`, `error()`, `summary()` |
| `semantic-analyzer/` | Semantic density analysis | `runSemanticCheck()`, `SemanticFixer` |
| `task-analyzer.ts` | Task risk/complexity | `TaskAnalyzer.analyzeTask()` |

### Intent → File

| I need to... | File(s) | Function(s) |
|-------------|---------|-------------|
| Add a task | `task.ts` | `addGoal(objective)` |
| Run tasks autonomously | `parallel-solo.ts` | `ParallelSoloOrchestrator.runParallel(tasks)` |
| Run single task (simple) | `solo.ts` | `SoloOrchestrator.runTask(goal)` |
| Isolate work in worktree | `worktree-manager.ts` | `WorktreeManager.createWorktree()` |
| Merge branches serially | `git.ts` | `Elevator.processMergeQueue()` |
| Check file conflicts | `file-tracker.ts` | `FileTracker.checkConflicts(files)` |
| Handle rate limits | `rate-limit.ts` | `RateLimitTracker.handleRateLimitError()` |
| Assess task complexity | `complexity.ts` | `assessComplexityFast(task)` |
| Get context for agent | `context.ts` | `prepareContext(task)` |
| Decompose complex task | `task-decomposer.ts` | `checkAndDecompose(objective)` |
| Parse plan file | `plan-parser.ts` | `parsePlanFile(content)` |
| Persist state | `persistence.ts` | `Persistence.saveState(key, data)` |
| Track token usage | `live-metrics.ts` | `saveLiveMetrics(metrics)` |
| Log events | `grind-events.ts` | `logTaskComplete()`, `logTaskFailed()` |
| Analyze semantic density | `semantic-analyzer/` | `runSemanticCheck({rootDir})` |

## Decision Trees

### Which Orchestrator?

```
Want to run tasks?
├── Multiple tasks / production → ParallelSoloOrchestrator
├── Single task, quick test → ParallelSoloOrchestrator (maxConcurrent=1)
└── DEPRECATED: SoloOrchestrator (use ParallelSoloOrchestrator)
```

### Which Model Tier?

```
assessComplexityFast(task) returns:
├── trivial (score ≤1) → haiku
│   └── Typos, comments, simple fixes
├── simple (score ≤3) → sonnet
│   └── Single function, add log, small change
├── standard (score ≤6) → sonnet + review
│   └── Feature, bug fix, add tests
├── complex (score ≤9) → opus
│   └── Refactor, multi-file, architecture
└── critical (score >9) → opus + full chain
    └── Security, auth, breaking changes
```

### Where Does State Live?

```
.undercity/
├── tasks.json              # Task board (tracked in git)
├── pocket.json             # Active session state
├── parallel-recovery.json  # Crash recovery state
├── rate-limit-state.json   # Token usage tracking
├── grind-events.jsonl      # Event log (append-only)
├── worktree-state.json     # Active worktrees
├── file-tracking.json      # Modified files per agent
└── live-metrics.json       # Cost/token aggregates
```

## Execution Flows

### grind Command Flow

```
undercity grind [goal]
    │
    ├── goal provided? → runParallel([goal])
    │
    └── no goal → fetch task.ts:getAllItems()
        │
        ├── hasActiveRecovery? → resumeRecovery()
        │
        ├── decompose? (default yes)
        │   └── checkAndDecompose() → subtasks + model tier
        │
        ├── group by model tier (haiku → sonnet → opus)
        │
        └── per task:
            ├── WorktreeManager.createWorktree()
            ├── SoloOrchestrator.runTask()
            ├── FileTracker.checkConflicts()
            ├── Elevator.queueMerge()
            └── processMergeQueue() → rebase → verify → merge
```

### Task Lifecycle

```
pending → in_progress → complete|failed
    │         │              │
    │         │              └── markTaskComplete() / markTaskFailed()
    │         └── markInProgress(id, sessionId)
    └── addGoal(objective)
```

### Merge Queue (Elevator)

```
task complete → Elevator.queueMerge(branch)
    │
    └── processMergeQueue() [SERIAL]
        ├── rebase onto main
        ├── run verification (typecheck, test, lint)
        ├── fast-forward merge
        └── retry on failure (3 attempts, strategies: default → theirs → ours)
```

## Type Hierarchies

### Core Types (types.ts)

| Type | Purpose | Values |
|------|---------|--------|
| `ComplexityLevel` | Task complexity | `trivial`, `simple`, `standard`, `complex`, `critical` |
| `ModelChoice` | AI model tier | `haiku`, `sonnet`, `opus` |
| `SessionStatus` | Session state | `planning`, `executing`, `complete`, `failed` |
| `MergeStatus` | Merge queue state | `pending`, `rebasing`, `testing`, `merging`, `complete`, `conflict` |
| `AgentType` | Agent roles | `scout`, `planner`, `builder`, `reviewer` |

### Task Type

```typescript
interface Task {
  id: string;
  objective: string;
  status: 'pending' | 'in_progress' | 'complete' | 'failed';
  priority?: number;
  parentId?: string;        // If subtask
  isDecomposed?: boolean;   // If parent (has subtasks)
  createdAt: Date;
  completedAt?: Date;
  error?: string;
}
```

### Complexity Assessment

```typescript
interface ComplexityAssessment {
  level: ComplexityLevel;
  confidence: number;        // 0-1
  model: ModelChoice;        // Recommended model
  estimatedScope: 'single-file' | 'few-files' | 'many-files' | 'cross-package';
  signals: string[];         // What influenced decision
  team: TeamComposition;     // Validators, planner needed?
}
```

## CLI Command Reference

| Command | Purpose | Key Options |
|---------|---------|-------------|
| `grind [goal]` | Run tasks | `-p, --parallel <n>`, `-n, --count <n>`, `--no-decompose` |
| `tasks` | Show task board | - |
| `add <goal>` | Add task | - |
| `import-plan <file>` | Parse plan → tasks | `--dry-run` |
| `limits` | Show usage snapshot | - |
| `watch` | Live TUI dashboard | - |
| `status` | Grind session status | `--events`, `--human` |
| `serve` | Start HTTP daemon | `-p, --port <n>` |
| `daemon [action]` | Control daemon | `status`, `stop`, `pause`, `resume` |
| `metrics` | Performance metrics | - |
| `semantic-check` | Analyze density | `--fix`, `--human` |

## Configuration

### Priority Order (highest → lowest)

1. CLI flags
2. `.undercityrc` (cwd)
3. `~/.undercityrc` (home)
4. Built-in defaults

### Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `ANTHROPIC_API_KEY` | API authentication | Yes |
| `LOG_LEVEL` | Logging verbosity | No (default: info) |

## Gotchas & Edge Cases

| Situation | Behavior | Solution |
|-----------|----------|----------|
| 429 rate limit | Pause + exponential backoff | Auto-resume, check with `limits` |
| File conflicts pre-merge | Task fails | Manual resolution required |
| Crash during batch | Recovery state saved | Auto-resume on next `grind` |
| Decomposed parent task | Skipped in grind | Subtasks run instead |
| Worktree leak | Manual cleanup needed | `git worktree list` + remove |
| Merge conflicts | 3 retries with strategy escalation | default → theirs → ours |

## Key Patterns

### Parallel Execution
- Tasks run in isolated git worktrees
- Branch from local main HEAD
- Merge serially via Elevator queue
- No parallel merges (prevents conflicts)

### Model Routing
- `task-decomposer.ts` assesses atomicity + complexity
- Routes: haiku (cheap) → sonnet (balanced) → opus (capable)
- Cheapest tier first within batch

### Verification Loop
Every task verifies before commit:
1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm lint`
4. `pnpm build`

Failures → retry or escalate model tier.

### Recovery
- `parallel-recovery.json` tracks batch state
- Interrupted tasks resume automatically
- `hasActiveRecovery()` → `resumeRecovery()`

## Module Dependencies

```
cli.ts
└── commands/*.ts
    ├── task.ts → task.ts, plan-parser.ts
    ├── mixed.ts → parallel-solo.ts, persistence.ts, rate-limit.ts
    └── analysis.ts → metrics-collector.ts, semantic-analyzer/

parallel-solo.ts
├── solo.ts (task execution)
├── worktree-manager.ts (isolation)
├── file-tracker.ts (conflict detection)
├── rate-limit.ts (429 handling)
└── persistence.ts (state)

solo.ts
├── complexity.ts (assessment)
├── context.ts (pre-flight)
└── live-metrics.ts (tracking)
```

## Testing

```bash
pnpm test              # Run all tests
pnpm test:coverage     # With coverage report
pnpm typecheck         # Type check only
```

Test files: `src/__tests__/*.test.ts`

## Adding New Features

### New Command
1. Add to appropriate `commands/*.ts`
2. Register in `register(program)` function
3. Use `output.*` for structured output

### New State File
1. Add type to `types.ts`
2. Add load/save to `persistence.ts`
3. Initialize in orchestrator constructor

### New Complexity Signal
1. Add to `COMPLEXITY_SIGNALS` in `complexity.ts`
2. Update `scoreFromMetrics()` if quantitative
