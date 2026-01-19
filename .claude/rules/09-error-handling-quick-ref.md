# Error Handling Quick Reference

Fast lookup for common error handling scenarios in TypeScript/Node.js.

## Decision Tree: What to Do When Error Occurs?

```
Does error happen in normal operation?
├─ NO (programmer error: type error, logic bug)
│  └─ Let it crash → FIX THE CODE
│
└─ YES (operational error: network, validation, etc)
   ├─ Can THIS function handle it?
   │  ├─ YES (has recovery)
   │  │  └─ Catch and handle
   │  │
   │  └─ NO (caller must decide)
   │     └─ Let it propagate
   │
   └─ Is it transient? (network, timeout, 5xx)
      ├─ YES
      │  └─ RETRY with exponential backoff
      │
      └─ NO (validation, not found, auth)
         └─ Fail and return error to caller
```

## Quick Patterns

### Custom Error Class Template

```typescript
export class DomainError extends Error {
    readonly code: string;
    readonly statusCode: number;

    constructor(message: string, code: string, statusCode = 500) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        this.statusCode = statusCode;
        Object.setPrototypeOf(this, DomainError.prototype);  // Critical!
    }
}
```

### Async Error Handling

```typescript
// Safe async pattern
async function doWork(): Promise<Result> {
    try {
        const data = await fetchData();  // MUST await
        return processData(data);
    } catch (error: unknown) {  // unknown, not any
        if (isTransientError(error)) {
            return retry(doWork);
        }
        throw error;  // or handle appropriately
    }
}
```

### Discriminated Union (Type-Safe)

```typescript
type Outcome<T> =
    | { ok: true; value: T }
    | { ok: false; error: string };

// Usage: TypeScript enforces both branches
const result = getUser(id);
if (result.ok) {
    console.log(result.value);  // T type
} else {
    console.error(result.error);  // string type
}
```

### Retry with Backoff

```typescript
async function retry<T>(
    fn: () => Promise<T>,
    attempts = 3,
    baseDelay = 100
): Promise<T> {
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e) {
            if (i === attempts - 1) throw e;
            const delay = baseDelay * Math.pow(2, i);
            await sleep(delay);
        }
    }
    throw new Error("Unreachable");
}
```

### Graceful Degradation

```typescript
async function fetchWithFallback<T>(
    primary: () => Promise<T>,
    fallback: T
): Promise<T> {
    try {
        return await primary();
    } catch (error) {
        logger.warn({ error }, "Primary failed, using fallback");
        return fallback;
    }
}
```

### Structured Logging (Pino)

```typescript
import { logger } from "./logger.js";

try {
    await operation();
} catch (error: unknown) {
    logger.error(
        {
            error: String(error),
            stack: error instanceof Error ? error.stack : undefined,
            context: { userId, action }
        },
        "Operation failed"
    );
}
```

## Error Type Classification

| Error Type | Examples | Handle? | Retry? |
|-----------|----------|---------|--------|
| Network | ECONNREFUSED, ETIMEDOUT | Yes | Yes |
| Server Error | 500-599 | Yes | Yes |
| Rate Limit | 429 | Yes | Yes |
| Not Found | 404 | Yes | No |
| Validation | 400 | Yes | No |
| Authorization | 401, 403 | Yes | No |
| Programmer | TypeError, ReferenceError | No | No |

## Testing Errors

```typescript
import { expect, it, vi } from "vitest";

it("retries on transient error", async () => {
    const fn = vi.fn()
        .mockRejectedValueOnce(new Error("Network timeout"))
        .mockResolvedValueOnce("success");

    const result = await retry(fn);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
});
```

## TypeScript Configuration

```json
{
    "compilerOptions": {
        "strict": true,
        "useUnknownInCatchVariables": true,  // Catch as unknown, not any
        "noImplicitAny": true,
        "noImplicitThis": true
    }
}
```

## Common Mistakes

| Mistake | Issue | Fix |
|---------|-------|-----|
| Throw string | No stack trace | Throw Error objects |
| Catch `any` | Lose type safety | Use `unknown` |
| Forget `await` | Errors invisible | Always `await` in try/catch |
| Retry 4xx errors | Infinite loop | Only retry 5xx, 429, network |
| No error context | Hard to debug | Include context in errors |
| Sync try/catch on promises | Won't catch rejections | Use `await` or `.catch()` |
| Ignore unhandled rejections | Process crash | Add global handlers |
| Missing `Object.setPrototypeOf` | instanceof fails | Always set prototype in Error classes |

## When to Use Each Pattern

| Pattern | Use Case | Example |
|---------|----------|---------|
| Try/Catch | Async operations | Wrapping API calls |
| .catch() | Promise chains | .then(x).catch(e) |
| Discriminated Union | Function returns | Result<T, Error> |
| Custom Error | Domain errors | ValidationError |
| Retry | Transient failures | Network requests |
| Graceful Degradation | Optional features | Recommendation engine |
| Circuit Breaker | Overloaded service | External API client |

## Key Principles (Memorize These)

1. **Classify first**: Is this operational or programmer error?
2. **Fail fast on programmer errors**: Don't mask bugs
3. **Recover operationally**: Network, timeout, rate limits
4. **Type-safe always**: No `any`, use `unknown`
5. **Propagate when unsure**: Let caller decide
6. **Log with context**: Structured, searchable
7. **Retry transient only**: Not validation or auth
8. **Degrade gracefully**: Maintain partial functionality

## Files to Reference

- **Full patterns**: `09-error-handling-patterns.md`
- **Implementation guide**: See code examples in patterns file
- **TypeScript setup**: Enable `useUnknownInCatchVariables` in tsconfig.json
- **Logging setup**: Use logger from `logger.ts`

## Common Error Codes to Define

```typescript
const ERROR_CODES = {
    // Validation
    VALIDATION_ERROR: "VALIDATION_ERROR",

    // Not found
    NOT_FOUND: "NOT_FOUND",

    // Auth
    UNAUTHORIZED: "UNAUTHORIZED",
    FORBIDDEN: "FORBIDDEN",

    // External service
    EXTERNAL_SERVICE_ERROR: "EXTERNAL_SERVICE_ERROR",
    TIMEOUT: "TIMEOUT",
    RATE_LIMIT: "RATE_LIMIT",

    // Internal
    INTERNAL_ERROR: "INTERNAL_ERROR",
    DATABASE_ERROR: "DATABASE_ERROR",
} as const;
```

## Remember

- **Operational errors** are OK, catch them
- **Programmer errors** must surface, fix them
- **Always await** in try/catch
- **Type safety** prevents bugs at compile time
- **Structured logging** enables debugging at scale
- **Retry strategically** with exponential backoff
- **Degrade gracefully** to maintain user experience
