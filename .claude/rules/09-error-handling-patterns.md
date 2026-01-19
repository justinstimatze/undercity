# Error Handling and Edge Case Management

Comprehensive patterns for robust error handling, edge case management, and recovery strategies in TypeScript/Node.js applications.

## Classification: Operational vs Programmer Errors

### Operational Errors
Runtime problems in correctly written code:
- Network failures
- Invalid user input
- File not found
- API timeouts
- Database connection failures

**Response**: Handle gracefully with recovery strategies, logging, and user-friendly messages.

### Programmer Errors
Bugs in the code that require fixing:
- Type errors
- Reference errors
- Logic mistakes
- Invalid state transitions
- Incorrect function calls

**Response**: Crash fast, log with context, fix the bug. Do NOT attempt recovery.

## Type-Safe Error Handling

### Discriminated Union Pattern (Recommended)

```typescript
// Define explicit error variants
export type Result<T, E> =
    | { success: true; data: T }
    | { success: false; error: E };

// For API responses
export type ApiResponse<T> =
    | { status: 200; data: T }
    | { status: 400; error: string; code: "VALIDATION_ERROR" }
    | { status: 401; error: string; code: "UNAUTHORIZED" }
    | { status: 500; error: string; code: "INTERNAL_ERROR" };

// Usage with type narrowing
function handleResponse<T>(response: ApiResponse<T>): void {
    if (response.status === 200) {
        // TypeScript knows data exists here
        console.log(response.data);
    } else if (response.status === 400) {
        // TypeScript knows error exists with specific code
        console.error(`Validation failed: ${response.error}`);
    }
}
```

**Benefits:**
- Compiler enforces handling all cases
- No optional properties creating runtime confusion
- Clear relationship between discriminant and data
- Eliminates `as any` type assertions

### Result Type with Custom Errors

```typescript
export class ValidationError extends Error {
    readonly code = "VALIDATION_ERROR";
    constructor(
        public readonly field: string,
        public readonly value: unknown,
        message?: string
    ) {
        super(message ?? `Validation failed for field: ${field}`);
        this.name = "ValidationError";
        Object.setPrototypeOf(this, ValidationError.prototype);
    }
}

export class TimeoutError extends Error {
    readonly code = "TIMEOUT_ERROR";
    constructor(
        public readonly timeoutMs: number,
        message?: string
    ) {
        super(message ?? `Operation timed out after ${timeoutMs}ms`);
        this.name = "TimeoutError";
        Object.setPrototypeOf(this, TimeoutError.prototype);
    }
}

type Result<T> =
    | { ok: true; value: T }
    | { ok: false; error: ValidationError | TimeoutError };

// Usage
const result = validateInput(data);
if (!result.ok) {
    if (result.error instanceof ValidationError) {
        logger.warn({ field: result.error.field }, "Validation failed");
    } else if (result.error instanceof TimeoutError) {
        logger.error({ timeoutMs: result.error.timeoutMs }, "Operation timeout");
    }
}
```

## Custom Error Classes

### Proper Implementation

```typescript
// Base application error
export class AppError extends Error {
    readonly timestamp = new Date();

    constructor(
        message: string,
        public readonly code: string,
        public readonly statusCode: number = 500,
        public readonly context?: Record<string, unknown>
    ) {
        super(message);
        this.name = this.constructor.name;
        // Critical for instanceof checks in transpiled code
        Object.setPrototypeOf(this, AppError.prototype);
    }
}

// Domain-specific errors
export class ValidationError extends AppError {
    constructor(
        message: string,
        public readonly field: string,
        context?: Record<string, unknown>
    ) {
        super(message, "VALIDATION_ERROR", 400, context);
        Object.setPrototypeOf(this, ValidationError.prototype);
    }
}

export class NotFoundError extends AppError {
    constructor(
        public readonly resource: string,
        public readonly id: string,
        context?: Record<string, unknown>
    ) {
        super(
            `${resource} not found: ${id}`,
            "NOT_FOUND",
            404,
            context
        );
        Object.setPrototypeOf(this, NotFoundError.prototype);
    }
}

export class RateLimitError extends AppError {
    constructor(
        public readonly retryAfterMs: number,
        context?: Record<string, unknown>
    ) {
        super(
            `Rate limit exceeded. Retry after ${retryAfterMs}ms`,
            "RATE_LIMIT",
            429,
            context
        );
        Object.setPrototypeOf(this, RateLimitError.prototype);
    }
}

// Type guard for checking error type
export function isAppError(error: unknown): error is AppError {
    return error instanceof AppError;
}

export function isValidationError(error: unknown): error is ValidationError {
    return error instanceof ValidationError;
}
```

### Avoiding Common Pitfalls

```typescript
// BAD: Throwing strings
throw "Something went wrong";

// BAD: Anonymous errors with no context
throw new Error("error");

// BAD: Using any type
catch (error: any) {
    console.error(error.message);  // Could be anything
}

// GOOD: Proper error with context
throw new ValidationError(
    "Email format invalid",
    "email",
    { providedValue: userInput }
);

// GOOD: Type-safe error handling
catch (error: unknown) {
    if (error instanceof ValidationError) {
        return { field: error.field, error: error.message };
    }
    if (isAppError(error)) {
        return { code: error.code, statusCode: error.statusCode };
    }
    return { error: "Unknown error" };
}
```

## Asynchronous Error Handling

### Try/Catch Pattern (Primary)

```typescript
// GOOD: Always await promises
async function fetchUserData(id: string): Promise<User> {
    try {
        // Must await to catch rejections
        const response = await fetchApi(`/users/${id}`);
        return response.data;
    } catch (error: unknown) {
        if (error instanceof TimeoutError) {
            logger.warn({ userId: id }, "Fetch timeout");
            throw new RetryableError("User fetch timed out");
        }
        throw error;
    }
}

// BAD: Forgetting to await
async function fetchUserData(id: string): Promise<User> {
    try {
        const response = fetchApi(`/users/${id}`);  // Missing await!
        return response.data;  // Type error, but runtime issue
    } catch (error) {
        // Won't catch rejection
    }
}

// GOOD: Multiple async operations
async function processMultipleTasks(ids: string[]): Promise<void> {
    try {
        // Run in parallel, wait for all
        const results = await Promise.all(
            ids.map(id => fetchTask(id))
        );
        await processBatch(results);
    } catch (error: unknown) {
        logger.error({ error: String(error), ids }, "Batch processing failed");
        throw error;
    }
}

// GOOD: Graceful handling of partial failures
async function processMultipleWithRecovery(ids: string[]): Promise<void> {
    const results = await Promise.allSettled(
        ids.map(id => fetchTask(id))
    );

    const successes = results
        .map((r, i) => r.status === "fulfilled" ? r.value : null)
        .filter((v): v is Task => v !== null);

    const failures = results
        .map((r, i) => r.status === "rejected" ? { id: ids[i], error: r.reason } : null)
        .filter((v): v is { id: string; error: unknown } => v !== null);

    if (failures.length > 0) {
        logger.warn({ failures }, "Some tasks failed");
    }

    await processBatch(successes);
}
```

### Catch Handler at Call Site

```typescript
// GOOD: Handling errors at call site
async function processData(): Promise<Result<ProcessedData>> {
    return fetchData()
        .then(validate)
        .then(process)
        .catch((error: unknown) => ({
            ok: false as const,
            error: handleError(error)
        }));
}

// Best of both worlds: await with catch at call site
async function main() {
    const result = await processData().catch(error => {
        logger.error({ error }, "Process failed");
        return handleError(error);
    });
}
```

### Promise.allSettled for Resilience

```typescript
// Partial failures don't stop entire operation
const results = await Promise.allSettled([
    fetchUser(id1),
    fetchUser(id2),
    fetchUser(id3),
]);

const succeeded = results
    .filter((r): r is PromiseFulfilledResult<User> => r.status === "fulfilled")
    .map(r => r.value);

const failed = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r, i) => ({ index: i, error: r.reason }));

// Continue with succeeded results
if (succeeded.length > 0) {
    await processBatch(succeeded);
}
```

## Retry Patterns

### Exponential Backoff with Jitter

```typescript
interface RetryConfig {
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
    jitterFactor: number;  // 0-1, adds randomness to prevent thundering herd
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxAttempts: 5,
    initialDelayMs: 100,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    jitterFactor: 0.1,
};

function calculateBackoffMs(
    attempt: number,
    config: RetryConfig
): number {
    // Exponential: initialDelay * (multiplier ^ attempt)
    const exponentialDelay = config.initialDelayMs *
        Math.pow(config.backoffMultiplier, attempt);

    // Cap at maximum
    const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);

    // Add jitter: randomness between 0 and jitterFactor * delay
    // Prevents synchronized retries from multiple clients
    const jitter = Math.random() * config.jitterFactor * cappedDelay;

    return cappedDelay + jitter;
}

async function retryWithBackoff<T>(
    operation: () => Promise<T>,
    config: Partial<RetryConfig> = {}
): Promise<T> {
    const finalConfig = { ...DEFAULT_RETRY_CONFIG, ...config };

    let lastError: unknown;

    for (let attempt = 0; attempt < finalConfig.maxAttempts; attempt++) {
        try {
            return await operation();
        } catch (error: unknown) {
            lastError = error;

            // Don't retry on non-transient errors
            if (isNonTransientError(error)) {
                throw error;
            }

            // Last attempt failed
            if (attempt === finalConfig.maxAttempts - 1) {
                break;
            }

            const delayMs = calculateBackoffMs(attempt, finalConfig);
            logger.info(
                { attempt: attempt + 1, delayMs, error: String(error) },
                "Retrying operation"
            );

            await sleep(delayMs);
        }
    }

    throw new RetryExhaustedError(
        `Operation failed after ${finalConfig.maxAttempts} attempts`,
        { lastError, config: finalConfig }
    );
}

// Usage
const result = await retryWithBackoff(
    () => fetchFromUnstableAPI(id),
    { maxAttempts: 5, initialDelayMs: 100 }
);
```

### Transient Error Detection

```typescript
function isTransientError(error: unknown): boolean {
    // Network-related errors are transient
    if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (
            message.includes("econnrefused") ||
            message.includes("econnreset") ||
            message.includes("etimedout") ||
            message.includes("timeout")
        ) {
            return true;
        }
    }

    // HTTP 5xx errors are transient (server error)
    if (isAppError(error)) {
        return error.statusCode >= 500 && error.statusCode < 600;
    }

    // Rate limiting is transient
    if (error instanceof RateLimitError) {
        return true;
    }

    return false;
}

function isNonTransientError(error: unknown): boolean {
    // Validation errors are never transient
    if (error instanceof ValidationError) {
        return true;
    }

    // 4xx errors (except 429) are non-transient
    if (isAppError(error) && error.statusCode >= 400 && error.statusCode < 500) {
        return error.statusCode !== 429;
    }

    return false;
}
```

## Graceful Degradation

### Fallback Mechanisms

```typescript
// Primary feature with fallback
async function fetchUserProfile(id: string): Promise<UserProfile> {
    try {
        // Try primary service
        return await primaryProfileService.get(id);
    } catch (error: unknown) {
        logger.warn({ error, userId: id }, "Primary service failed, using fallback");

        // Fall back to cached/secondary source
        const cached = await cache.get(`user:${id}`);
        if (cached) {
            return cached;
        }

        // Last resort fallback with degraded functionality
        return createMinimalProfile(id);
    }
}

// Feature flag for graceful feature disabling
function isFeatureEnabled(feature: string): boolean {
    if (process.env.FEATURE_FLAGS?.includes(feature)) {
        return true;
    }
    return false;
}

async function enhanceData<T>(data: T): Promise<T> {
    if (!isFeatureEnabled("AI_ENHANCEMENT")) {
        return data;  // Return unenhanced
    }

    try {
        return await aiService.enhance(data);
    } catch (error: unknown) {
        logger.warn({ error }, "AI enhancement failed, returning base data");
        return data;  // Graceful fallback
    }
}
```

### Load Shedding for Overload

```typescript
class CircuitBreaker {
    private failureCount = 0;
    private lastFailureTime: number | null = null;

    constructor(
        private failureThreshold: number = 5,
        private resetTimeoutMs: number = 60000  // 1 minute
    ) {}

    async execute<T>(operation: () => Promise<T>): Promise<T> {
        // Check if circuit is open
        if (this.isOpen()) {
            throw new CircuitBreakerOpenError(
                "Circuit breaker is open, rejecting request"
            );
        }

        try {
            const result = await operation();
            this.onSuccess();
            return result;
        } catch (error: unknown) {
            this.onFailure();
            throw error;
        }
    }

    private isOpen(): boolean {
        if (this.failureCount === 0) {
            return false;
        }

        // Circuit opens after threshold
        if (this.failureCount >= this.failureThreshold) {
            return true;
        }

        // Auto-reset after timeout
        if (this.lastFailureTime &&
            Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
            this.failureCount = 0;
            return false;
        }

        return false;
    }

    private onSuccess(): void {
        this.failureCount = 0;
        this.lastFailureTime = null;
    }

    private onFailure(): void {
        this.failureCount++;
        this.lastFailureTime = Date.now();
    }
}

// Usage
const breaker = new CircuitBreaker();

async function safeExternalCall(): Promise<Data> {
    return breaker.execute(() => fetchFromExternalAPI());
}
```

## Structured Error Logging

### Using Pino for Structured Logs

```typescript
import pino from "pino";

// Create base logger
const logger = pino({
    level: process.env.LOG_LEVEL || "info",
    transport: {
        target: "pino-pretty",
        options: {
            colorize: true,
            translateTime: "yyyy-mm-dd HH:MM:ss Z",
        },
    },
});

// Log with structured context
async function processTask(taskId: string): Promise<void> {
    const taskLogger = logger.child({ taskId, module: "worker" });

    try {
        taskLogger.info({ status: "starting" }, "Task started");

        const result = await executeTask(taskId);

        taskLogger.info(
            { status: "complete", duration: result.durationMs },
            "Task completed"
        );
    } catch (error: unknown) {
        taskLogger.error(
            {
                error: String(error),
                stack: error instanceof Error ? error.stack : undefined,
                status: "failed"
            },
            "Task failed"
        );
        throw error;
    }
}

// Error logging patterns
function logError(error: unknown, context: Record<string, unknown>): void {
    if (error instanceof AppError) {
        logger.error(
            {
                code: error.code,
                statusCode: error.statusCode,
                message: error.message,
                stack: error.stack,
                context: error.context,
                ...context,
            },
            "Application error"
        );
    } else if (error instanceof Error) {
        logger.error(
            {
                message: error.message,
                stack: error.stack,
                ...context,
            },
            "Unexpected error"
        );
    } else {
        logger.error(
            {
                value: String(error),
                type: typeof error,
                ...context,
            },
            "Unknown error"
        );
    }
}
```

## Edge Case Management

### Input Validation

```typescript
// Validate before processing to prevent errors
export function validateUserId(id: unknown): { ok: true; id: string } | { ok: false; error: string } {
    if (typeof id !== "string") {
        return { ok: false, error: "User ID must be a string" };
    }

    if (id.length === 0) {
        return { ok: false, error: "User ID cannot be empty" };
    }

    if (id.length > 128) {
        return { ok: false, error: "User ID is too long" };
    }

    return { ok: true, id };
}

// Use Zod for schema validation
import { z } from "zod";

const CreateUserSchema = z.object({
    email: z.string().email(),
    name: z.string().min(1).max(255),
    age: z.number().int().positive().optional(),
});

type CreateUserInput = z.infer<typeof CreateUserSchema>;

async function createUser(input: unknown): Promise<User> {
    // Validate first
    const validated = CreateUserSchema.parse(input);  // Throws ZodError on invalid

    // Now process with confidence
    return db.users.create(validated);
}
```

### Boundary Conditions

```typescript
// Handle empty collections
function processItems<T>(items: T[], processor: (item: T) => void): void {
    if (items.length === 0) {
        logger.info("No items to process");
        return;
    }

    for (const item of items) {
        processor(item);
    }
}

// Handle large numbers
const MAX_BATCH_SIZE = 10000;

function splitIntoBatches<T>(items: T[], batchSize: number = 100): T[][] {
    if (batchSize <= 0 || batchSize > MAX_BATCH_SIZE) {
        throw new RangeError(`Batch size must be between 1 and ${MAX_BATCH_SIZE}`);
    }

    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
        batches.push(items.slice(i, i + batchSize));
    }
    return batches;
}

// Handle null/undefined safely
function extractProperty<T, K extends keyof T>(
    obj: T | null | undefined,
    key: K
): T[K] | undefined {
    if (obj === null || obj === undefined) {
        return undefined;
    }
    return obj[key];
}
```

### Timeout Handling

```typescript
// Implement operation timeouts
async function withTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number
): Promise<T> {
    let timeoutId: NodeJS.Timeout | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new TimeoutError(timeoutMs));
        }, timeoutMs);
    });

    try {
        return await Promise.race([operation(), timeoutPromise]);
    } finally {
        // Clean up timeout
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

// AbortController for cancellation
async function fetchWithTimeout(
    url: string,
    timeoutMs: number = 30000
): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}
```

## Monitoring and Error Tracking

### Error Metrics Collection

```typescript
interface ErrorMetrics {
    total: number;
    byCode: Record<string, number>;
    byType: Record<string, number>;
    lastError: { error: string; timestamp: Date } | null;
}

class ErrorTracker {
    private metrics: ErrorMetrics = {
        total: 0,
        byCode: {},
        byType: {},
        lastError: null,
    };

    recordError(error: unknown): void {
        this.metrics.total++;
        this.metrics.lastError = {
            error: String(error),
            timestamp: new Date(),
        };

        if (isAppError(error)) {
            this.metrics.byCode[error.code] =
                (this.metrics.byCode[error.code] ?? 0) + 1;
        }

        const type = error?.constructor?.name ?? "Unknown";
        this.metrics.byType[type] =
            (this.metrics.byType[type] ?? 0) + 1;
    }

    getMetrics(): Readonly<ErrorMetrics> {
        return { ...this.metrics };
    }
}
```

## Testing Error Cases

### Mocking Errors

```typescript
import { expect, it, vi } from "vitest";

it("retries on transient error", async () => {
    let attempts = 0;
    const operation = vi.fn(async () => {
        attempts++;
        if (attempts < 3) {
            throw new Error("Network timeout");
        }
        return "success";
    });

    const result = await retryWithBackoff(operation, { maxAttempts: 5 });

    expect(result).toBe("success");
    expect(operation).toHaveBeenCalledTimes(3);
});

it("fails on non-transient error without retry", async () => {
    const operation = vi.fn(async () => {
        throw new ValidationError("Invalid input", "email");
    });

    await expect(
        retryWithBackoff(operation, { maxAttempts: 3 })
    ).rejects.toThrow(ValidationError);

    // Should fail immediately without retrying
    expect(operation).toHaveBeenCalledTimes(1);
});
```

## Decision Tree: When to Catch

```
Does the error occur?
├─ It shouldn't occur (programmer error)
│  └─ Let it crash → Fix the bug
│
├─ It might occur (operational error)
│  ├─ Can this function handle it?
│  │  ├─ Yes, it has a clear recovery
│  │  │  └─ Catch and handle with try/catch
│  │  │
│  │  └─ No, caller must decide
│  │     └─ Let it propagate
│  │
│  └─ Is this a critical operation?
│     ├─ Yes (saving data, security)
│     │  └─ Catch and fail loudly
│     │
│     └─ No (optional enhancement)
│        └─ Catch and degrade gracefully
```

## Summary Table

| Pattern | Use Case | Pros | Cons |
|---------|----------|------|------|
| **Discriminated Unions** | Type-safe error variants | Compiler verified, clear cases | Verbose type definitions |
| **Custom Error Classes** | Domain-specific errors | Semantic clarity, instanceof checks | Requires proper implementation |
| **Result<T, E> Type** | Function return errors | Explicit error handling | Can't use throw, different paradigm |
| **Try/Catch** | Async operations, synchronous code | Familiar, exception-based | Stack trace overhead |
| **Promise.catch()** | Promise chains | Explicit at call site | Chaining can be verbose |
| **Retry with Backoff** | Transient failures | Automatic recovery, configurable | Can mask real issues if misused |
| **Graceful Degradation** | Non-critical features | Better UX, maintains functionality | Harder to test all paths |
| **Structured Logging** | Error tracking and debugging | Queryable, machine-readable | Performance overhead |

## Sources

- [The 5 Commandments of Clean Error Handling in TypeScript](https://medium.com/with-orus/the-5-commandments-of-clean-error-handling-in-typescript-93a9cbdf1af5)
- [A Comprehensive Guide to Error Handling in Node.js](https://www.honeybadger.io/blog/errors-nodejs/)
- [Discriminated Unions in TypeScript](https://basarat.gitbook.io/typescript/type-system/discriminated-unions)
- [Error Handling with Async/Await in JavaScript](https://wesbos.com/javascript/12-advanced-flow-control/71-async-await-error-handling)
- [Exponential Backoff and Jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
- [Graceful Degradation in Error Handling](https://medium.com/@satyendra.jaiswal/graceful-degradation-handling-errors-without-disrupting-user-experience-fd4947a24011)
- [Pino Logger: Complete Node.js Guide](https://betterstack.com/community/guides/logging/how-to-install-setup-and-use-pino-to-log-node-js-applications/)
- [Custom Error Classes in TypeScript](https://bobbyhadz.com/blog/typescript-extend-error-class)
- [TypeScript Best Practices: Error Types](https://www.convex.dev/typescript/best-practices/error-handling-debugging/typescript-error-type)
- [Let It Crash: Best Practices for Handling Node.js Errors on Shutdown](https://www.heroku.com/blog/best-practices-nodejs-errors/)
