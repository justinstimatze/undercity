# Code Style Guidelines

## TypeScript

### Type Safety

Never use `any` types. See `00-critical.md` for details.

**Type inference:**
```typescript
// Let TypeScript infer when it can
const item = items.find((i) => i.id === targetId);

// Use explicit types when needed for clarity
const processItem = (item: ItemType): Result => { ... };
```

**Type assertions (when absolutely necessary):**
```typescript
// Use double assertion for safety
value as unknown as TargetType

// Add comments explaining why
// Avoid `as any` - it's almost never right
```

### Zod Schema Patterns

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

**Plain `KEY=value` format in `.env` files:**
```bash
# BAD
export API_KEY=secret123

# GOOD
API_KEY=secret123
```

**Why**: Docker Compose and many tools don't support `export` prefix.

**Loading in shell:**
```bash
set -a; source .env; set +a
```

## Structured Logging

**Prefer structured data over template literals:**
```typescript
// BAD: Template literals
console.log(`Processing ${taskId} for user ${userId}`);

// GOOD: Structured data
console.log("Processing task", { taskId, userId });
```

**Security:**
- Never log passwords, tokens, or API keys
- Mask PII: `user@example.com` → `us***@example.com`
- Be cautious with request/response bodies

## Shell Command Safety

**Use `execFileSync` over `execSync` when including variables:**
```typescript
// BAD: Shell injection risk with user input
execSync(`git commit -m "${userInput}"`, { cwd });

// GOOD: No shell interpretation
execFileSync("git", ["commit", "-m", userInput], { cwd });
```

**When `execSync` is acceptable:**
- Command requires shell features (pipes, redirects, `||`, `&&`)
- All interpolated values are trusted internal values (numbers, controlled paths)
- Values are properly escaped

CodeQL runs on PRs and will catch shell injection from user input.

## Code Quality Targets

- Cyclomatic complexity: ≤10 per function
- Lines of code: ≤60 per function
- Nesting depth: ≤3 levels
- Prefer early returns to reduce nesting

## Testing

### Mock Strategy

**Use focused mock factories instead of `any`:**
```typescript
// GOOD: Type-safe mock factory
const createMockTask = (overrides: Partial<Task> = {}): Task => ({
  id: "test-task-1",
  status: "pending",
  ...overrides,
});

// BAD: Lazy any casting
const mockTask = { id: "test" } as any;
```

### Console Mocking (Vitest)

```typescript
let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  consoleInfoSpy.mockRestore();
});

it("logs when processing", () => {
  doSomething();
  expect(consoleInfoSpy).toHaveBeenCalledWith("Expected message", expect.any(Object));
});
```
