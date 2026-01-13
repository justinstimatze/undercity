# Architecture Patterns

Patterns and conventions discovered from codebase analysis.

## Module Organization

### File Naming Conventions

| Pattern | Purpose | Examples |
|---------|---------|----------|
| `{feature}.ts` | Core module | `task.ts`, `git.ts`, `cache.ts` |
| `{feature}-{aspect}.ts` | Specialized variant | `task-analyzer.ts`, `task-scheduler.ts`, `dual-logger.ts` |
| `commands/{category}.ts` | CLI command groups | `commands/task.ts`, `commands/mixed.ts` |
| `commands/{category}-handlers.ts` | Handler extraction | `mixed-handlers.ts`, `task-handlers.ts` |

### Handler Extraction Pattern

Large command modules split into two files:
```
commands/mixed.ts          # Command definitions (thin)
commands/mixed-handlers.ts # Handler implementations (thick)
```

**Why**: Keeps command registration concise, handlers testable separately.

## Singleton Pattern

**Use singleton factories with reset functions:**

```typescript
// Singleton instance
let indexInstance: ASTIndexManager | null = null;

// Factory function
export function getASTIndex(repoRoot?: string): ASTIndexManager {
    if (!indexInstance) {
        indexInstance = new ASTIndexManager(repoRoot);
    }
    return indexInstance;
}

// Reset for testing
export function resetASTIndex(): void {
    indexInstance = null;
}
```

**Instances using this pattern:**
- `ast-index.ts` → `getASTIndex()`, `resetASTIndex()`
- `cache.ts` → `getCache()`
- `experiment.ts` → `getExperimentManager()`

## Atomic File Operations

**Always use temp file + rename for crash safety:**

```typescript
// GOOD: Atomic write
const tempPath = `${path}.tmp`;
writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
renameSync(tempPath, path);

// BAD: Direct write (can corrupt on crash)
writeFileSync(path, JSON.stringify(data, null, 2));
```

**Why**: `renameSync` is atomic on POSIX. If crash occurs during write, original file preserved.

## Class Design

### Manager Classes

Large stateful modules use class with clear structure:

```typescript
export class ASTIndexManager {
    private index: ASTIndex;
    private dirty = false;

    // ==========================================================================
    // Lifecycle
    // ==========================================================================
    async load(): Promise<void> { ... }
    async save(): Promise<void> { ... }

    // ==========================================================================
    // Querying
    // ==========================================================================
    findSymbolDefinition(name: string): string[] { ... }
    getFileInfo(path: string): FileASTInfo | null { ... }

    // ==========================================================================
    // Updating
    // ==========================================================================
    async indexFile(path: string): Promise<boolean> { ... }
    async rebuildFull(): Promise<void> { ... }

    // ==========================================================================
    // Private Helpers
    // ==========================================================================
    private computeFileHash(path: string): string { ... }
}
```

**Pattern elements:**
- Section comments for navigation
- Lifecycle methods first (load/save)
- Public query methods before mutation methods
- Private helpers at bottom

### Standalone Functions

Use for stateless operations or when state managed externally:

```typescript
// Stateless operation - standalone function
export function extractKeywords(objective: string): string[] { ... }

// State managed by persistence - standalone functions
export function loadLedger(stateDir?: string): CapabilityLedger { ... }
export function saveLedger(ledger: CapabilityLedger, stateDir?: string): void { ... }
```

## Error Handling

### Silent Failures for Optional Features

```typescript
// Optional feature - silent failure
try {
    execSync("ast-grep --version", { timeout: 1000 });
    // ast-grep available, use it
} catch {
    // Not installed, skip
    return [];
}
```

### Logged Failures for Important Features

```typescript
// Important feature - log and return default
try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content);
} catch (error) {
    logger.warn({ error: String(error) }, "Failed to load config");
    return defaultConfig;
}
```

## Output Modes

### Dual-Mode Output Pattern

```typescript
export function info(message: string, data?: Record<string, unknown>): void {
    if (globalConfig.mode === "agent") {
        // Machine-readable JSON
        console.log(JSON.stringify({ type: "info", message, data, timestamp: now() }));
    } else {
        // Human-readable
        console.log(`${chalk.dim("•")} ${message}`);
    }
}
```

**Convention**: All user-facing output goes through `output.ts` functions.

## Parallel Execution

### Promise.all for Independent Operations

```typescript
// Run independent checks in parallel
const [typecheckResult, lintResult, testsResult] = await Promise.all([
    runTypecheckTask(),
    runLintTask(),
    runTestsTask(),
]);

// Collect results in consistent order
issues.push(...typecheckResult.issues);
issues.push(...lintResult.issues);
issues.push(...testsResult.issues);
```

**Why**: Verification time reduced by ~3x running typecheck, lint, tests in parallel.

## Type Definitions

### Discriminated Unions for State

```typescript
// Status types use union literals
export type SessionStatus =
    | "planning"
    | "executing"
    | "complete"
    | "failed";

// Not boolean flags
// BAD: { isComplete: boolean; isFailed: boolean; }
```

### Interface Composition

```typescript
// Base interface
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

// Extended with context
export interface TaskUsage {
    taskId: string;
    model: ModelChoice;
    tokens: TokenUsage;  // Compose, don't flatten
    timestamp: Date;
}
```

## CLI Commands

### Command Module Pattern

```typescript
export interface CommandModule {
    register(program: Command): void;
}

export const mixedCommands: CommandModule = {
    register(program) {
        program
            .command("grind")
            .description("...")
            .option("-n, --count <n>", "...", "0")
            .action((options) => handleGrind(options));
    }
};
```

**Registration in cli.ts:**
```typescript
taskCommands.register(program);
mixedCommands.register(program);
analysisCommands.register(program);
```

## State Persistence

### JSON Files with Versioning

```typescript
export interface ASTIndex {
    version: string;           // For migrations
    files: Record<string, FileASTInfo>;
    lastUpdated: string;       // ISO timestamp
}

// On load, check version
if (data.version !== INDEX_VERSION) {
    logger.info("Index version mismatch, rebuilding");
    return createEmptyIndex();
}
```

### State File Locations

| File | Content | Tracked |
|------|---------|---------|
| `.undercity/tasks.json` | Task board | Yes |
| `.undercity/ast-index.json` | Symbol index | No |
| `.undercity/rate-limit-state.json` | Rate limits | No |
| `.undercity/parallel-recovery.json` | Crash recovery | No |

**Rule**: Only `tasks.json` is tracked in git. All other state is local.

## Logging Conventions

### Child Loggers

```typescript
// Create child logger for module
const logger = sessionLogger.child({ module: "verification" });

// Use structured data
logger.info({ taskId, duration }, "Task completed");

// NOT: logger.info(`Task ${taskId} completed in ${duration}ms`);
```

### Log Levels

| Level | Use |
|-------|-----|
| `debug` | Detailed flow (not normally visible) |
| `info` | Key events (task start/complete) |
| `warn` | Non-fatal issues (cache miss, retry) |
| `error` | Fatal issues requiring attention |

## Context Preparation Pattern

### Agent-Specific Context Limits

Different agents have different context budgets:

```typescript
const CONTEXT_LIMITS: Record<AgentType, number> = {
    scout: 4000,      // Minimal - just needs to explore
    planner: 8000,    // Moderate - needs to understand scope
    builder: 16000,   // Large - needs full implementation context
    reviewer: 12000,  // Medium - needs to see changes + relevant code
};
```

### Pre-Flight Context Gathering

Use free local tools before expensive AI calls:

```typescript
export async function prepareContext(objective: string): Promise<ContextBriefing> {
    // 1. AST index for symbols (free, local)
    const symbols = await getASTIndex().findRelevantSymbols(objective);

    // 2. Git grep for code search (free, local)
    const codeMatches = execSync(`git grep -n "${keyword}"`, { encoding: "utf-8" });

    // 3. File dependency graph (free, local)
    const deps = buildImportGraph(targetFiles);

    // Return structured context for agent consumption
    return { objective, targetFiles, typeDefinitions, codeContext, ... };
}
```

**Benefits:**
- Reduces token usage (free local analysis vs AI exploration)
- Provides structured context agents can consume efficiently
- Enables smart file targeting before agent starts

## Delegation Prompt Structure

### Seven-Section Format

Structure delegation prompts consistently:

```typescript
const delegationPrompt = `
## TASK
${objective}

## EXPECTED OUTCOME
${expectedOutcome}

## REQUIRED SKILLS
${skills.join(", ")}

## REQUIRED TOOLS
${tools.join(", ")}

## MUST DO
${mustDo.map(item => `- ${item}`).join("\n")}

## MUST NOT DO
${mustNotDo.map(item => `- ${item}`).join("\n")}

## CONTEXT
${contextBriefing}
`;
```

**Why structured format:**
- Clear expectations for agent
- Explicit constraints prevent scope creep
- Context at end (most likely to be truncated)

## Codebase Fingerprinting

### Git-Based Change Detection

Use git to detect what changed:

```typescript
export function getCodebaseFingerprint(): string {
    // Fast: just hash of HEAD commit
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
}

export function getChangedFiles(since: string): string[] {
    return execFileSync("git", ["diff", "--name-only", since], { encoding: "utf-8" })
        .split("\n")
        .filter(Boolean);
}
```

**Use cases:**
- Cache invalidation (rebuild AST index only if files changed)
- Incremental updates (only re-index modified files)
- Change detection for verification

## Prompt Caching (Blocked)

### Status: NOT IMPLEMENTED

Prompt caching via `cache_control` would provide **90% cost reduction** on cache hits, but is currently blocked.

### Why Blocked

| Auth Method | SDK | cache_control Support |
|-------------|-----|----------------------|
| Claude Max (OAuth) | Agent SDK | No |
| API Key | Raw SDK (`@anthropic-ai/sdk`) | Yes |

We use Claude Max OAuth login, which only works with the Agent SDK. The Agent SDK doesn't expose `cache_control`.

### When to Revisit

Monitor: https://github.com/anthropics/claude-agent-sdk-typescript/issues

When the Agent SDK adds `cache_control` support:
1. Add cache markers to system prompts in `complexity.ts`, `worker.ts`
2. Verify cache metrics in `.undercity/live-metrics.json`
3. Expected savings: ~90% on repeated system prompts
