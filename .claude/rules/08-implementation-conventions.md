# Implementation Conventions

Additional patterns and conventions discovered from codebase analysis.

## Import Conventions

### ESM Import Style

Always use explicit `.js` extensions for local imports:

```typescript
// GOOD: ESM-compliant imports
import { sessionLogger } from "./logger.js";
import type { ModelChoice } from "./types.js";

// BAD: Missing extension (breaks ESM)
import { sessionLogger } from "./logger";
```

### Import Organization

Group imports in this order:
1. Node.js built-ins (`node:*`)
2. Third-party packages
3. Local modules

```typescript
// Node.js built-ins
import { execSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Third-party
import chalk from "chalk";
import pino from "pino";
import { Command } from "commander";

// Local modules
import { sessionLogger } from "./logger.js";
import type { Task } from "./types.js";
```

### Type-Only Imports

Use `import type` for type-only imports:

```typescript
// GOOD: Explicit type import
import type { ModelChoice, TokenUsage } from "./types.js";

// BAD: Runtime import for types only
import { ModelChoice, TokenUsage } from "./types.js";
```

## Function Overloads for API Flexibility

Support both positional arguments and options object:

```typescript
// Define overloads
export function markTaskComplete(params: MarkTaskCompleteParams): void;
export function markTaskComplete(id: string, path?: string): void;
export function markTaskComplete(paramsOrId: MarkTaskCompleteParams | string, path?: string): void {
    let id: string;
    let actualPath: string;

    if (typeof paramsOrId === "object") {
        ({ id, path: actualPath = DEFAULT_PATH } = paramsOrId);
    } else {
        id = paramsOrId;
        actualPath = path ?? DEFAULT_PATH;
    }

    // Implementation
}
```

**Benefits:**
- Backwards compatibility
- Named parameters for clarity
- Destructuring support

## File Locking for Concurrent Access

Use file locks for multi-process safety:

```typescript
const LOCK_TIMEOUT_MS = 30000;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_MAX_RETRIES = 100;

interface LockInfo {
    pid: number;
    timestamp: number;
}

function acquireLock(lockPath: string): boolean {
    const lockInfo: LockInfo = {
        pid: process.pid,
        timestamp: Date.now(),
    };

    for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
        try {
            const fd = openSync(lockPath, "wx");  // Exclusive create
            writeFileSync(fd, JSON.stringify(lockInfo));
            closeSync(fd);
            return true;
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === "EEXIST") {
                if (isLockStale(lockPath)) {
                    unlinkSync(lockPath);
                    continue;
                }
                // Exponential backoff
                const delay = Math.min(LOCK_RETRY_DELAY_MS * 1.5 ** attempt, 500);
                busyWait(delay);
            } else {
                throw err;
            }
        }
    }
    return false;
}
```

**When to use:**
- Task board operations (`task.ts`)
- Any shared JSON state file
- Multi-worker scenarios

## Constants and Configuration

### Model Names

```typescript
const MODEL_NAMES: Record<ModelTier, string> = {
    haiku: "claude-3-5-haiku-20241022",
    sonnet: "claude-sonnet-4-20250514",
    opus: "claude-opus-4-5-20251101",
};
```

### Default Values

```typescript
const DEFAULT_STATE_DIR = ".undercity";
const DEFAULT_TASK_BOARD_PATH = ".undercity/tasks.json";
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_RETRIES_PER_TIER = 3;
const DEFAULT_MAX_OPUS_RETRIES = 7;  // More attempts at final tier
```

## Worker Checkpoint Pattern

Save checkpoints during long-running operations for crash recovery:

```typescript
interface TaskCheckpoint {
    phase: "starting" | "context" | "executing" | "verifying" | "reviewing" | "committing";
    model: ModelTier;
    attempts: number;
    savedAt: Date;
    lastVerification?: { passed: boolean; errors?: string[] };
}

private saveCheckpoint(
    phase: TaskCheckpoint["phase"],
    lastVerification?: { passed: boolean; errors?: string[] }
): void {
    try {
        const checkpoint: TaskCheckpoint = {
            phase,
            model: this.currentModel,
            attempts: this.attempts,
            savedAt: new Date(),
            lastVerification,
        };
        updateTaskCheckpoint(this.workingDirectory, checkpoint);
    } catch {
        // Silent failure - checkpoints are optional
    }
}
```

**Phases:**
| Phase | Description |
|-------|-------------|
| `starting` | Task initialization |
| `context` | Context gathering |
| `executing` | Agent running |
| `verifying` | Running build/test/lint |
| `reviewing` | Review passes |
| `committing` | Creating commit |

## SDK Query Pattern

Using the Claude Agent SDK:

```typescript
for await (const message of query({
    prompt,
    options: {
        model: MODEL_NAMES[this.currentModel],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["project"],
        cwd: this.workingDirectory,  // CRITICAL for worktree mode
    },
})) {
    // Handle messages
    if (message.type === "result" && message.subtype === "success") {
        result = message.result;
    }
}
```

**Important options:**
- `cwd`: Working directory (critical for worktrees)
- `settingSources`: Load disallowedTools from project settings
- `permissionMode`: Bypass for autonomous execution

## Task Status Flow

```
pending ──┬── in_progress ──┬── complete
          │                 ├── failed
          │                 └── escalated (retry with better model)
          │
          ├── blocked (waiting on dependency)
          │
          ├── duplicate (already done)
          ├── canceled (user decision)
          └── obsolete (no longer needed)
```

## Legacy Alias Pattern

Maintain backwards compatibility during migrations:

```typescript
// New names
export const getAllTasks = (): Task[] => { ... };
export const addTask = (objective: string): Task => { ... };

// Legacy aliases for backwards compatibility
export const getAllItems = getAllTasks;
export const addGoal = addTask;
export const loadBacklog = loadTaskBoard;
```

## Keyword Extraction Pattern

Extract action keywords for classification:

```typescript
const ACTION_PATTERNS = [
    "add", "fix", "refactor", "update", "remove", "delete",
    "create", "implement", "modify", "change", "migrate",
    "upgrade", "optimize", "improve", "simplify", "extract",
    "rename", "move", "test", "document", "configure"
];

function extractKeywords(objective: string): string[] {
    const words = objective.toLowerCase().split(/\s+/);
    const keywords: string[] = [];

    for (const word of words) {
        const cleaned = word.replace(/[^a-z]/g, "");
        if (cleaned && ACTION_PATTERNS.includes(cleaned)) {
            keywords.push(cleaned);
        }
    }

    return [...new Set(keywords)];  // Deduplicate
}
```

## Task Prefix Conventions

| Prefix | Purpose | Skips Verification |
|--------|---------|-------------------|
| `[meta:triage]` | Board analysis | Yes |
| `[meta:prune]` | Board cleanup | Yes |
| `[plan]` | Subtask planning | Yes |
| `[research]` | Information gathering | Partial (writes .md) |
| (none) | Implementation | No |

## Complexity-Based Model Selection

```typescript
private determineStartingModel(assessment: ComplexityAssessment): ModelTier {
    switch (assessment.level) {
        case "trivial":
        case "simple":
            return "haiku";      // Fast, cheap
        case "standard":
            return "sonnet";     // Balanced
        case "complex":
            return "sonnet";     // Start low, escalate if needed
        case "critical":
            return "opus";       // Skip to best model
        default:
            return "sonnet";
    }
}
```

## Review Level Determination

Cap review escalation by complexity to save tokens:

```typescript
private determineReviewLevel(assessment: ComplexityAssessment): {
    review: boolean;
    annealing: boolean;
    maxReviewTier: ModelTier;
} {
    switch (assessment.level) {
        case "trivial":
        case "simple":
        case "standard":
            // Simple tasks: cap at sonnet (no opus review)
            return { review: true, annealing: false, maxReviewTier: "sonnet" };
        case "complex":
        case "critical":
            // Complex tasks: full escalation + annealing
            return { review: true, annealing: true, maxReviewTier: "opus" };
        default:
            return { review: true, annealing: false, maxReviewTier: "sonnet" };
    }
}
```

## Git Operations Safety

Use `execFileSync` over `execSync` when possible:

```typescript
// GOOD: execFileSync (safer, no shell injection)
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf-8",
    cwd: this.workingDirectory,
}).trim();

// OK: execSync for complex commands (with caution)
execSync("git checkout -- . 2>/dev/null || true", {
    encoding: "utf-8",
    cwd: this.workingDirectory,
});
```

**Safety rules:**
- Always specify `cwd` (critical for worktrees)
- Use `execFileSync` for simple git commands
- Use `|| true` for commands that might fail gracefully

## Verification Configuration

### Profile-Based Commands

Verification commands loaded from project profile:

```typescript
interface VerificationProfile {
    typecheck: { command: string; enabled: boolean };
    lint: { command: string; enabled: boolean };
    test: { command: string; enabled: boolean };
    spellCheck: { command: string; enabled: boolean };
}

// Default profile
const DEFAULT_PROFILE: VerificationProfile = {
    typecheck: { command: "pnpm typecheck", enabled: true },
    lint: { command: "pnpm lint", enabled: true },
    test: { command: "pnpm test", enabled: true },
    spellCheck: { command: "pnpm spellcheck", enabled: false },
};
```

**Benefits:**
- Project-specific commands (npm vs pnpm vs yarn)
- Disable checks that don't apply
- Override in `.undercity/profile.json`

## Token Usage Tracking

### Structured Token Accounting

Track tokens at multiple granularities:

```typescript
interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

interface TaskTokenUsage extends TokenUsage {
    taskId: string;
    model: ModelTier;
    phase: "context" | "execution" | "verification" | "review";
}

// Aggregate by session
interface SessionTokenUsage {
    sessionId: string;
    tasks: TaskTokenUsage[];
    totalTokens: number;
    modelBreakdown: Record<ModelTier, number>;
}
```

**Why granular tracking:**
- Identify expensive phases (execution vs review)
- Model tier optimization (too much opus usage?)
- Budget forecasting for overnight runs

## Error Classification

### TypeScript Error Parsing

Parse verification errors into structured format:

```typescript
interface StructuredError {
    file: string;
    line: number;
    column: number;
    code: string;      // TS2345, ESLint rule, etc.
    message: string;
    suggestion?: string;
}

function parseTypeScriptError(line: string): StructuredError | null {
    // Format: src/file.ts(10,5): error TS2345: Argument...
    const match = line.match(/^(.+)\((\d+),(\d+)\): error (TS\d+): (.+)$/);
    if (!match) return null;

    return {
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        code: match[4],
        message: match[5],
    };
}
```

**Benefits:**
- Targeted fixes (agent knows exact location)
- Error deduplication (same error from multiple sources)
- Learning cache (remember how to fix TS2345)

## Cache Patterns

### Error Fix Learning

Cache successful error fixes for reuse:

```typescript
interface ErrorFixCache {
    errorCode: string;           // e.g., "TS2345"
    errorPattern: string;        // Normalized error message
    fix: {
        before: string;          // Code before fix
        after: string;           // Code after fix
        confidence: number;      // Success rate
    };
    occurrences: number;
}

// On successful fix
function recordFix(error: StructuredError, before: string, after: string): void {
    const pattern = normalizeErrorMessage(error.message);
    const existing = cache.get(error.code, pattern);

    if (existing && existing.fix.after === after) {
        existing.occurrences++;
        existing.fix.confidence = calculateConfidence(existing);
    } else {
        cache.set(error.code, pattern, { before, after, confidence: 0.5 });
    }
}
```

## Model Escalation Strategy

### Adaptive Retry Logic

Escalate models based on failure patterns:

```typescript
const ESCALATION_PATH: ModelTier[] = ["haiku", "sonnet", "opus"];
const MAX_RETRIES_PER_TIER = 3;
const MAX_OPUS_RETRIES = 7;  // More attempts at final tier

function shouldEscalate(
    currentTier: ModelTier,
    attempts: number,
    errorType: "verification" | "review" | "execution"
): { escalate: boolean; nextTier: ModelTier } {
    const maxAttempts = currentTier === "opus"
        ? MAX_OPUS_RETRIES
        : MAX_RETRIES_PER_TIER;

    if (attempts >= maxAttempts) {
        const currentIndex = ESCALATION_PATH.indexOf(currentTier);
        if (currentIndex < ESCALATION_PATH.length - 1) {
            return { escalate: true, nextTier: ESCALATION_PATH[currentIndex + 1] };
        }
    }

    return { escalate: false, nextTier: currentTier };
}
```

**Escalation triggers:**
- Repeated verification failures
- Review rejection after fix attempts
- Execution timeout or crash

## Write Operation Tracking

### Session-Level File Tracking

Track files modified during a session:

```typescript
interface WriteOperation {
    file: string;
    timestamp: Date;
    operation: "create" | "modify" | "delete";
    lines: { added: number; removed: number };
}

class SessionTracker {
    private writes: WriteOperation[] = [];

    recordWrite(file: string, before: string | null, after: string | null): void {
        const operation = !before ? "create" : !after ? "delete" : "modify";
        const lines = this.computeLineDelta(before, after);
        this.writes.push({ file, timestamp: new Date(), operation, lines });
    }

    getModifiedFiles(): string[] {
        return [...new Set(this.writes.map(w => w.file))];
    }
}
```

**Why track writes:**
- Detect file conflicts before merge
- Scope review to changed files only
- Audit trail for debugging
