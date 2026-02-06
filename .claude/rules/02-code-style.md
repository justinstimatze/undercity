# Code Style Guidelines

## Zod Schema Patterns

**Discriminated unions:**
```typescript
// GOOD: Clear variants
const response = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true), data: z.string() }),
  z.object({ success: z.literal(false), error: z.string() }),
]);

// BAD: Optional fields without clear relationship
const response = z.object({
  success: z.boolean(),
  data: z.string().optional(),
  error: z.string().optional(),
});
```

**Defaults for robust parsing:**
```typescript
const configSchema = z.object({
  timeout: z.number().default(30000),
  retries: z.number().default(3),
});
```

## Environment Variables

Plain `KEY=value` in `.env` files (no `export` prefix). Load in shell: `set -a; source .env; set +a`.

## Structured Logging

Prefer structured data over template literals:
```typescript
// BAD
console.log(`Processing ${taskId} for user ${userId}`);

// GOOD
console.log("Processing task", { taskId, userId });
```

Never log passwords, tokens, or API keys.

## Shell Command Safety

Use `execFileSync` over `execSync` when including variables:
```typescript
// BAD: Shell injection risk
execSync(`git commit -m "${userInput}"`, { cwd });

// GOOD: No shell interpretation
execFileSync("git", ["commit", "-m", userInput], { cwd });
```

`execSync` acceptable when: command needs shell features (pipes, `||`, `&&`) and all values are trusted.

## Code Quality Targets

- Cyclomatic complexity: <=10 per function
- Lines of code: <=60 per function
- Nesting depth: <=3 levels
- Function parameters: <=3 (use an options object for more)
- Prefer early returns to reduce nesting

## Naming Conventions

**Boolean parameters and variables** must use `is`, `has`, `was`, `did`, `should`, or `can` prefix:
```typescript
// BAD
function complete(success: boolean): void {}

// GOOD
function complete(wasSuccessful: boolean): void {}
```

**Avoid magic numbers.** Use named constants from `src/constants.ts` for timeouts and agent turn limits:
```typescript
// BAD
execSync(cmd, { timeout: 60000 });

// GOOD
import { TIMEOUT_BUILD_STEP_MS } from "./constants.js";
execSync(cmd, { timeout: TIMEOUT_BUILD_STEP_MS });
```

Available constants: `TIMEOUT_TOOL_CHECK_MS` (1s), `TIMEOUT_FILE_SEARCH_MS` (3s), `TIMEOUT_GIT_CMD_MS` (5s), `TIMEOUT_HEAVY_CMD_MS` (10s), `TIMEOUT_LINT_FIX_MS` (30s), `TIMEOUT_BUILD_STEP_MS` (60s), `TIMEOUT_TEST_SUITE_MS` (120s), `MAX_TURNS_SINGLE` (1), `MAX_TURNS_REVIEW` (5), `MAX_TURNS_PLANNING` (10), `MAX_TURNS_EXTENDED_PLANNING` (15).

## Testing

### Mock Strategy

Use focused mock factories instead of `any`:
```typescript
const createMockTask = (overrides: Partial<Task> = {}): Task => ({
  id: "test-task-1",
  status: "pending",
  ...overrides,
});
```

### No Timing-Based Test Assertions

Never assert on wall-clock timing ratios or absolute durations. Test correctness, not speed. Only acceptable: generous upper bounds (5-10s) as timeout guards.

### Console Mocking (Vitest)

```typescript
let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  consoleInfoSpy.mockRestore();
});
```
