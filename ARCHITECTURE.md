# Undercity Architecture

Agent-optimized reference. Mappings over prose. Includes learning systems.

## File → Function → Behavior

| File | Key Exports | What It Does |
|------|-------------|--------------|
| `cli.ts` | `program` | CLI entry, routes to command modules |
| `commands/task.ts` | `taskCommands.register()` | Task board: `tasks`, `add`, `load`, `import-plan`, `plan`, `work`, `task-analyze`, `reconcile`, `triage`, `prune` |
| `commands/mixed.ts` | `mixedCommands.register()` | Execution + learning: `grind`, `pulse`, `brief`, `decide`, `knowledge`, `usage`, `tuning`, `introspect`, `watch` |
| `commands/analysis.ts` | `analysisCommands.register()` | Metrics: `metrics`, `patterns`, `decisions`, `ax`, `semantic-check`, `insights` |
| `orchestrator.ts` | `Orchestrator.run()` | **Main orchestrator**: parallel execution, worktrees, recovery, merge queue |
| `worker.ts` | `TaskWorker.run()` | Single-task executor, runs in worktree |
| `supervised.ts` | `SupervisedOrchestrator` | Opus orchestrates workers |
| `task.ts` | `addGoal()`, `getAllItems()`, `markComplete()`, `markFailed()`, `markInProgress()` | Task board CRUD |
| `worktree-manager.ts` | `WorktreeManager.createWorktree()`, `.cleanup()` | Git worktree isolation per task |
| `merge-queue.ts` | `MergeQueue.add()`, `MergeQueue.processAll()` | Merge queue: serial rebase→test→merge |
| `git.ts` | `rebase()`, `merge()`, `getCurrentBranch()`, `execGit()` | Core git operations |
| `rate-limit.ts` | `RateLimitTracker.isPaused()`, `.handleRateLimitError()` | 429 handling, exponential backoff |
| `file-tracker.ts` | `FileTracker.checkConflicts()` | Pre-merge conflict detection |
| `complexity.ts` | `assessComplexityFast()`, `assessComplexityQuantitative()`, `getTeamComposition()` | Task complexity → model routing |
| `context.ts` | `prepareContext()`, `summarizeContextForAgent()` | Pre-flight context extraction (FREE, no LLM) |
| `ts-analysis.ts` | `extractFunctionSignaturesWithTypes()`, `extractTypeDefinitionsFromFile()` | Deep TypeScript AST analysis (ts-morph) |
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
| `knowledge.ts` | `loadKnowledge()`, `addLearning()`, `findRelevantLearnings()` | Knowledge compounding |
| `knowledge-extractor.ts` | `extractLearnings()` | Extract learnings from task completions |
| `decision-tracker.ts` | `captureDecision()`, `resolveDecision()`, `getPendingDecisions()` | Decision capture/resolution |
| `automated-pm.ts` | `processPendingDecisions()` | Automated PM for pm_decidable |
| `task-file-patterns.ts` | `recordTaskFiles()`, `findRelevantFiles()`, `findCoModifiedFiles()` | Task→file correlations |
| `error-fix-patterns.ts` | `recordErrorFix()`, `findMatchingFix()` | Error→fix patterns |
| `ax-programs.ts` | `getAxProgramStats()` | Ax/DSPy self-improving prompts |
| `claude-usage.ts` | `fetchClaudeMaxUsage()` | Live Claude Max usage from claude.ai |

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
| Queue merge | `merge-queue.ts` | `MergeQueue.add(branch)` | Serial processing |
| Check conflicts | `file-tracker.ts` | `FileTracker.checkConflicts(files)` | Pre-merge detection |
| Handle rate limit | `rate-limit.ts` | `RateLimitTracker.handleRateLimitError(error)` | Auto-pause + backoff |
| Persist state | `persistence.ts` | `Persistence.saveState(key, data)` | JSON file I/O |
| Track tokens | `live-metrics.ts` | `saveLiveMetrics(metrics)` | Model breakdown |
| Log grind event | `grind-events.ts` | `logTaskComplete()`, `logTaskFailed()` | Append-only JSONL |
| Analyze semantic density | `semantic-analyzer/` | `runSemanticCheck({rootDir})` | Returns `SemanticReport` |
| Store learning | `knowledge.ts` | `addLearning(learning)` | Returns `Learning` |
| Find relevant learnings | `knowledge.ts` | `findRelevantLearnings(objective)` | Keyword + confidence scoring |
| Capture agent decision | `decision-tracker.ts` | `captureDecision(taskId, question, context)` | Returns `DecisionPoint` |
| Resolve decision | `decision-tracker.ts` | `resolveDecision(id, resolution)` | - |
| Process PM decisions | `automated-pm.ts` | `processPendingDecisions()` | Auto-handles pm_decidable |
| Record task→file pattern | `task-file-patterns.ts` | `recordTaskFiles(taskId, desc, files)` | Updates correlations |
| Find relevant files | `task-file-patterns.ts` | `findRelevantFiles(taskDesc)` | Returns scored file list |
| Fetch Claude Max usage | `claude-usage.ts` | `fetchClaudeMaxUsage()` | Live from claude.ai |

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
| `.undercity/worktree-state.json` | Active worktrees | `WorktreeState` |
| `.undercity/rate-limit-state.json` | Rate limit state | `RateLimitState` |
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

## Configuration & Data Structures

### knowledge.json

**Location**: `.undercity/knowledge.json`

**Purpose**: Persistent knowledge base of learnings extracted from completed tasks. Each task completion deposits knowledge that improves future task execution through relevant context injection.

**Root Structure (KnowledgeBase)**:

```typescript
interface KnowledgeBase {
  learnings: Learning[];      // Array of extracted learnings
  version: string;            // Format version (currently "1.0")
  lastUpdated: string;        // ISO timestamp of last modification
}
```

**Learning Structure**:

```typescript
interface Learning {
  id: string;                 // Unique identifier (learn-{timestamp}-{random})
  taskId: string;             // Task that produced this learning
  category: LearningCategory; // "pattern" | "gotcha" | "preference" | "fact"
  content: string;            // Natural language description of learning
  keywords: string[];         // Keywords extracted for retrieval (max 20)
  structured?: {              // Optional structured data
    file?: string;            // Associated file path
    pattern?: string;         // Code pattern or template
    approach?: string;        // Recommended approach
  };
  confidence: number;         // Score 0-1, starts at 0.5, increases with reuse
  usedCount: number;          // Times injected into task context
  successCount: number;       // Times use led to task success
  createdAt: string;          // ISO timestamp
  lastUsedAt?: string;        // ISO timestamp of last injection
}
```

**Learning Categories**:

| Category | Use | Example |
|----------|-----|---------|
| `pattern` | Recurring code patterns or solutions | "Use discriminated unions for error handling" |
| `gotcha` | Pitfalls and edge cases | "Forget to await in try/catch blocks" |
| `preference` | Team preferences and conventions | "Always use execFileSync over execSync" |
| `fact` | Facts about codebase structure | "TypeScript strict mode enforced in tsconfig.json" |

**Example knowledge.json**:

```json
{
  "version": "1.0",
  "lastUpdated": "2026-01-20T15:30:45.123Z",
  "learnings": [
    {
      "id": "learn-1a2b3c-xyz789",
      "taskId": "task-fix-validation",
      "category": "pattern",
      "content": "Use discriminated unions with z.discriminatedUnion() for Zod validation to ensure type safety",
      "keywords": ["zod", "discriminated", "union", "validation", "typescript"],
      "structured": {
        "file": "src/types.ts",
        "pattern": "z.discriminatedUnion('success', [...])",
        "approach": "Define success/error variants explicitly"
      },
      "confidence": 0.85,
      "usedCount": 3,
      "successCount": 3,
      "createdAt": "2026-01-15T10:20:00.000Z",
      "lastUsedAt": "2026-01-20T15:00:00.000Z"
    },
    {
      "id": "learn-2d4e5f-abc123",
      "taskId": "task-git-safety",
      "category": "gotcha",
      "content": "Never use git add -A or git add . in automation. Always stage specific files to avoid committing untracked experiments.",
      "keywords": ["git", "staging", "bulk", "safety", "commit"],
      "confidence": 0.92,
      "usedCount": 2,
      "successCount": 2,
      "createdAt": "2026-01-12T08:15:00.000Z",
      "lastUsedAt": "2026-01-18T14:30:00.000Z"
    }
  ]
}
```

### Knowledge Lifecycle

**Extraction** (task completion):
1. `knowledge-extractor.ts` analyzes completed task
2. Identifies learnings from changes made, patterns used, gotchas encountered
3. Extracts keywords via `extractKeywords()` (filters stop words, max 20 per learning)
4. Creates Learning object with confidence: 0.5 (50% baseline)
5. Deduplicates against existing learnings (80% similarity threshold)
6. Persists to `.undercity/knowledge.json` via `saveKnowledge()`

**Injection** (before execution):
1. Worker calls `findRelevantLearnings(objective)` before agent execution
2. Scores learnings: `(70% keyword match) + (30% confidence)`
3. Returns top 5 learnings with score > 0.1
4. Context builder formats learnings into prompt via `formatLearningsForPrompt()`
5. Injected knowledge helps agent make better decisions

**Scoring**:
- Keyword overlap: How many task keywords match learning keywords
- Confidence: Increases with successful reuse (`confidence += 0.1 * (successCount / usedCount)`)
- Time-based decay: Older unused learnings have lower priority (via lastUsedAt)

**Pruning**:
- Learnings with confidence < 0.3 and no uses in 30 days are candidates for removal
- Manual cleanup via `knowledge prune` command
- Rebuilding: `knowledge rebuild` recreates from task history

### Knowledge Integration Points

| Component | Location | Function | When Called |
|-----------|----------|----------|-------------|
| **Planning** | `task-planner.ts:373` | `findRelevantLearnings()` | During pre-execution plan creation |
| **Context Building** | `worker.ts:2525` | `findRelevantLearnings()` | Before agent execution begins |
| **PM Decisions** | `automated-pm.ts:92` | `findRelevantLearnings()` | When resolving pending decisions |
| **Usage Tracking** | `worker.ts:1720` | `markLearningsUsed()` | After task completion (updates confidence) |
| **Extraction** | `knowledge-extractor.ts` | `addLearning()` | Task completion (stores new learnings) |
| **Validation** | `knowledge-validator.ts` | `validateKnowledgeBase()` | Load/save time, pre-commit hook, CI/CD |
| **CLI Access** | `commands/mixed-handlers.ts` | Knowledge command | User queries knowledge via `knowledge <query>` |
| **Verification** | `verification.ts` | Validation checks | Pre-commit hook runs knowledge validation |

### Knowledge Retrieval Scoring

**Formula**: `score = (keywordMatch * 0.7) + (confidence * 0.3)`

**Example**:
```
Task: "Add error handling with discriminated unions"
Keywords: ["error", "handling", "discriminated", "unions"]

Learning: "Use discriminated unions for error handling"
Learning keywords: ["zod", "discriminated", "union", "validation"]
Keyword match: 2/4 = 0.5
Confidence: 0.85
Score: (0.5 * 0.7) + (0.85 * 0.3) = 0.35 + 0.255 = 0.605 ✓ (above 0.1 threshold)
```

### Validation Rules

**Structure**:
- `learnings` must be array of Learning objects
- `version` must be string (currently "1.0")
- `lastUpdated` must be valid ISO date

**Learning Fields**:
- `id`: Non-empty string (format: `learn-{base36}-{random}`)
- `taskId`: Non-empty string
- `category`: One of: `pattern`, `gotcha`, `preference`, `fact`
- `content`: Non-empty string
- `keywords`: Array of strings (filtered duplicates)
- `confidence`: Number between 0.0 and 1.0
- `usedCount`, `successCount`: Non-negative integers
- `createdAt`: Valid ISO date string
- `lastUsedAt`: Optional, valid ISO date if present
- `structured`: Optional object with optional `file`, `pattern`, `approach` string fields

**Validation occurs**:
- On `loadKnowledge()` (returns default KB on validation failure)
- On `saveKnowledge()` (throws error if invalid)
- Pre-commit hook via `verifyWork()`
- CI/CD pipeline via GitHub Actions

### Common Issues & Troubleshooting

| Issue | Cause | Resolution |
|-------|-------|-----------|
| **Knowledge base not loaded** | Invalid knowledge.json | Run `knowledge rebuild` or delete `.undercity/knowledge.json` and restart |
| **Validation failure during save** | Added malformed learning | Check logs for specific field error (path shown in error message) |
| **Learnings not being injected** | Confidence too low or no keyword match | Review learning keywords via `knowledge search <term>` |
| **Duplicate learnings** | Same content added twice | Duplicates filtered at 80% similarity; manual cleanup may be needed |
| **No relevant learnings found** | Empty knowledge base or poor keyword extraction | Start with a few completed tasks to build knowledge base |

### Size Estimates

| Metric | Value | Notes |
|--------|-------|-------|
| Per learning | ~200-400 bytes | Depends on content/keywords length |
| Typical KB | ~100 learnings | ~20-40 KB JSON file |
| Max recommended | 1000 learnings | ~200-400 KB, still performant |
| Retrieval cost | ~50ms | Scoring all learnings for one query |

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
| `tasks` | Show board | `--status`, `--all` |
| `add <goal>` | Add task | `--context <file>`, `--priority` |
| `import-plan <file>` | Plan → tasks | `--dry-run` |
| `pulse` | Quick state check | JSON: workers, queue, health |
| `brief` | Narrative summary | `--hours <n>` |
| `decide` | View/resolve decisions | `--resolve <id>`, `--decision` |
| `knowledge <query>` | Search learnings | `--stats`, `--all` |
| `usage` | Live Claude Max usage | `--login` |
| `patterns` | Task→file patterns | - |
| `tuning` | Learned routing | `--rebuild`, `--clear` |
| `introspect` | Self-analysis | `--json`, `--patterns` |
| `watch` | TUI dashboard | - |
| `status` | Grind status | `--events`, `--human` |
| `metrics` | Performance | - |
| `semantic-check` | Density analysis | `--fix`, `--human` |

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
| `LOG_LEVEL` | Logging | No (default: info) |

**Auth**: Claude Max OAuth via Agent SDK (no API key needed). Run `undercity setup` to verify.

## Module Dependencies

```
cli.ts
└── commands/*.ts
    ├── task.ts → task.ts, plan-parser.ts
    ├── mixed.ts → orchestrator.ts, persistence.ts, rate-limit.ts
    └── analysis.ts → live-metrics.ts, semantic-analyzer/

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
