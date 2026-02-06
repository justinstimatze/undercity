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
- Prefer early returns to reduce nesting

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
