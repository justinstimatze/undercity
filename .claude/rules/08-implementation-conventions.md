---
paths:
  - src/**/*.ts
---

# Implementation Conventions

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

Group imports: 1) Node.js built-ins (`node:*`), 2) Third-party packages, 3) Local modules.

### Type-Only Imports

Use `import type` for type-only imports:

```typescript
import type { ModelChoice, TokenUsage } from "./types.js";
```

## File Locking for Concurrent Access

Use `withFileLock`/`withFileLockAsync` from `file-lock.ts` for JSON state files accessed by multiple workers. See ADR-0004 for storage topology.

## Constants

```typescript
const MODEL_NAMES: Record<ModelTier, string> = {
    sonnet: "claude-sonnet-4-5-20250929",
    opus: "claude-opus-4-6",
};

const DEFAULT_STATE_DIR = ".undercity";
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_RETRIES_PER_TIER = 3;
const DEFAULT_MAX_OPUS_RETRIES = 3;
```

## SDK Query Pattern

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
    if (message.type === "result" && message.subtype === "success") {
        result = message.result;
    }
}
```

Important: `cwd` must point to worktree path. `settingSources: ["project"]` loads disallowedTools.

## Task Status Flow

```
pending --> in_progress --> complete
                       --> failed
                       --> escalated (retry with better model)
        --> blocked (waiting on dependency)
        --> duplicate | canceled | obsolete
```

## Task Prefix Conventions

| Prefix | Purpose | Skips Verification |
|--------|---------|-------------------|
| `[meta:triage]` | Board analysis | Yes |
| `[meta:prune]` | Board cleanup | Yes |
| `[plan]` | Subtask planning | Yes |
| `[research]` | Information gathering | Partial |
| (none) | Implementation | No |

## Model Selection and Review Level

Sonnet for trivial/simple/standard/complex tasks. Opus only for critical.

Review capped by complexity: trivial/simple/standard cap at sonnet (no opus review). Complex/critical get full escalation + annealing. See ADR-0006.

## Git Operations Safety

Use `execFileSync` over `execSync` when possible. Always specify `cwd` (critical for worktrees). Use `|| true` for commands that might fail gracefully.

## Verification Configuration

Verification commands loaded from project profile (`.undercity/profile.json`). Defaults: `pnpm typecheck`, `pnpm lint`, `pnpm test`. Overridable per project.
