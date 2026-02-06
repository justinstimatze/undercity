---
paths:
  - src/*.ts
  - src/worker/**
  - src/orchestrator/**
  - src/rag/**
---

# Architecture Patterns

Patterns and conventions discovered from codebase analysis.

## Module Organization

| Pattern | Purpose | Examples |
|---------|---------|----------|
| `{feature}.ts` | Core module | `task.ts`, `git.ts`, `knowledge.ts` |
| `{feature}-{aspect}.ts` | Specialized variant | `task-analyzer.ts`, `task-file-patterns.ts` |
| `commands/{category}.ts` | CLI command groups | `commands/task.ts`, `commands/mixed.ts` |
| `commands/{category}-handlers.ts` | Handler extraction | `mixed-handlers.ts`, `task-handlers.ts` |

Handler extraction: large command modules split into `{name}.ts` (thin definitions) + `{name}-handlers.ts` (thick implementation).

## Singleton Pattern

Use singleton factories with reset functions:

```typescript
let indexInstance: ASTIndexManager | null = null;

export function getASTIndex(repoRoot?: string): ASTIndexManager {
    if (!indexInstance) {
        indexInstance = new ASTIndexManager(repoRoot);
    }
    return indexInstance;
}

export function resetASTIndex(): void {
    indexInstance = null;
}
```

Instances: `ast-index.ts`, `cache.ts`, `experiment.ts`.

## Atomic File Operations

Always use temp file + rename for crash safety:

```typescript
const tempPath = `${path}.tmp`;
writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
renameSync(tempPath, path);
```

`renameSync` is atomic on POSIX. If crash occurs during write, original file preserved.

## Class Design

Manager classes: section comments for navigation, lifecycle first (load/save), public queries before mutations, private helpers at bottom.

Standalone functions: use for stateless operations or when state managed by persistence layer.

## Error Handling

- Optional features: silent failure (try/catch with empty catch)
- Important features: log warning and return default value

## Output Modes

All user-facing output goes through `output.ts` functions. Auto-detects TTY (human) vs pipe (agent JSON).

## Parallel Execution

Use `Promise.all` for independent operations (verification checks run in parallel for ~3x speedup). Use `Promise.allSettled` when partial failures are acceptable.

## State Persistence

JSON files with version field for migrations. Check version on load, rebuild if mismatched. All `.undercity/` state is local and gitignored.

## Logging Conventions

Use child loggers per module: `sessionLogger.child({ module: "verification" })`. Always structured data over template literals. Levels: debug (flow), info (events), warn (non-fatal), error (fatal).

## Context Preparation

Use free local tools before expensive AI calls: AST index for symbols, git grep for code search, import graph for dependencies. Reduces token usage.

## Codebase Fingerprinting

Use `git rev-parse HEAD` for cache invalidation, `git diff --name-only` for incremental updates and change detection.

## Token Efficiency

**Escalation tuning:** maxAttempts=7, maxRetriesPerTier=3. Prevents premature escalation.

**Verification cost:** Agent prompt does NOT tell agent to run typecheck (external verification). Standard task: 1 verification call. With reviews: 1-3 calls.

**Review efficiency:** Review tier capped by complexity (see ADR-0006). Turn counts: 5-10 good, >15 concerning, >25 bad.
