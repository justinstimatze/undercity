# TypeScript Null-Safety Guide

Comprehensive guide to null-safe property access patterns in TypeScript, with best practices and real-world examples from the Undercity codebase.

## Table of Contents

- [Core Concepts](#core-concepts)
- [Operators and Syntax](#operators-and-syntax)
- [Type System Fundamentals](#type-system-fundamentals)
- [Best Practices](#best-practices)
- [Common Patterns](#common-patterns)
- [Anti-Patterns](#anti-patterns)
- [TypeScript Configuration](#typescript-configuration)
- [Migration Guide](#migration-guide)
- [Reference](#reference)

## Core Concepts

In TypeScript with `strictNullChecks` enabled, `null` and `undefined` are distinct types that must be explicitly handled. This prevents entire classes of runtime errors.

### Why Null-Safety Matters

**Without null-safety:**
```typescript
// Crashes at runtime
const name = obj.user.profile.firstName;  // What if user is null?
name.toUpperCase();  // TypeError: Cannot read property 'toUpperCase' of null
```

**With null-safety:**
```typescript
// TypeScript catches this at compile time
const name = obj.user.profile.firstName;
//         ^^^^^^^ Type error: Object is possibly 'null'

// Fix it with optional chaining
const name = obj.user?.profile?.firstName;
```

### Types vs Values

In TypeScript, `null` and `undefined` are:
- **Types**: Indicate a value might be absent (`null | undefined`, `?`)
- **Values**: The actual runtime `null` or `undefined`

TypeScript's type system helps you handle both correctly.

## Operators and Syntax

### 1. Optional Property Marker (`?`)

Marks a property as optional in type definitions:

```typescript
interface User {
  id: string;              // Required
  name: string;            // Required
  email?: string;          // Optional (can be undefined)
  phone?: string;          // Optional (can be undefined)
}

// All valid
const user1: User = { id: "1", name: "Alice" };
const user2: User = { id: "2", name: "Bob", email: "bob@example.com" };
const user3: User = { id: "3", name: "Charlie", email: undefined };
```

**When the property is accessed:**
```typescript
const user: User = { id: "1", name: "Alice" };

// Type of email is string | undefined
const email = user.email;
console.log(email?.length);  // undefined (no error)

// Inside a type guard, property is definitely present
if (user.email) {
  console.log(user.email.length);  // Safe - definitely string
}
```

### 2. Optional Chaining (`?.`)

Safely accesses properties that might be null/undefined:

```typescript
// Single level
const firstName = user?.name;  // string | undefined

// Nested access
const city = user?.address?.city;  // string | undefined

// Array access
const firstTag = tags?.[0];  // string | undefined

// Function calls
const result = obj?.method?.();  // any | undefined
```

**Short-circuit behavior:**
```typescript
const user: User | null = null;

// Stops at null, doesn't continue
const email = user?.address?.email;  // undefined (not an error)

// Equivalent to:
const email = user !== null && user !== undefined
  ? user.address?.email
  : undefined;
```

### 3. Nullish Coalescing (`??`)

Provides a default value for null/undefined:

```typescript
// Defaults to "Unknown" if email is null or undefined
const email = user.email ?? "unknown@example.com";

// Different from || (which treats falsy values like 0, "", false as empty)
const count = stats.count ?? 0;      // Returns 0 if stats.count is null/undefined
const count = stats.count || 0;      // Returns 0 if stats.count is null/undefined/0/""/false

// Combine with optional chaining
const city = user?.address?.city ?? "Unknown";

// Chain multiple defaults
const value = obj.a ?? obj.b ?? "default";
```

### 4. Non-Null Assertion (`!`)

Tells TypeScript "I know this isn't null" - **use sparingly**:

```typescript
// TypeScript thinks this might be null
const value = getValue();  // Type: string | null

// Assert it's definitely not null
const definiteValue = value!;  // Type: string

// Common in callbacks where TypeScript can't infer safety
array.forEach(item => {
  const required = item.optional!;  // You promise it exists
});
```

**⚠️ Warning:** Non-null assertions bypass type safety. Only use when:
- You have external knowledge TypeScript can't infer
- You're certain the value cannot be null
- Document why the assertion is safe

**Better alternatives:**
```typescript
// Instead of:
const value = getValue()!;

// Prefer type guards:
const value = getValue();
if (value) {
  // Type is narrowed to string
  console.log(value);
}

// Or functions that guarantee non-null:
const value = getValueOrThrow();
```

### 5. Type Narrowing with Conditions

TypeScript automatically refines types in conditional blocks:

```typescript
const value: string | null = getValue();

// Before: string | null
if (value !== null) {
  // After: string (null eliminated)
  console.log(value.toUpperCase());
}

// Truthy check (eliminates null, undefined, and falsy values)
if (value) {
  // After: string (null and undefined eliminated, but not 0/""/false)
  console.log(value.length);
}

// Explicit undefined check
if (value !== undefined) {
  // After: string | null (undefined eliminated)
  console.log(value?.length);
}
```

## Type System Fundamentals

### Optional vs Union

```typescript
// Optional property (might be undefined)
interface Config {
  timeout?: number;  // number | undefined
}

// Union type (might be null or something else)
interface Result {
  data: string | null;  // Explicit: could be string or null
}

// Different handling:
const config: Config = {};
const timeout = config.timeout ?? 5000;  // Safe, defaults to 5000

const result: Result = { data: null };
const text = result.data ?? "default";   // Safe, defaults to "default"
```

### Strict Mode Requirements

TypeScript has `strictNullChecks` as part of `strict: true`. With it enabled:

```typescript
// NOT enabled (lenient, old code)
let value: string = null;  // No error (null is assignable)
function getName() { }     // Returns any (implicitly)

// Enabled (strict mode, required in Undercity)
let value: string = null;  // ERROR: cannot assign null to string
function getName(): string { }  // Must return a string, never null
```

## Best Practices

### 1. Prefer Optional Properties Over Null

```typescript
// GOOD: Explicit about optionality
interface User {
  id: string;
  name: string;
  email?: string;  // Clear: might not exist
}

// BAD: Null as absence indicator
interface User {
  id: string;
  name: string;
  email: string | null;  // Less clear intent
}
```

### 2. Use Optional Chaining for Nested Access

```typescript
// GOOD: Stops safely at any null/undefined
const city = user?.address?.city;

// BAD: Crashes if user is null
const city = user.address.city;

// BAD: Verbose type checks
const city = user && user.address && user.address.city;
```

### 3. Use Nullish Coalescing for Defaults

```typescript
// GOOD: Clear default handling
const timeout = config.timeout ?? 5000;
const name = user?.name ?? "Guest";

// BAD: Treats falsy values as absent
const timeout = config.timeout || 5000;  // 0 becomes 5000!
const name = user?.name || "Guest";      // "" becomes "Guest"!

// BAD: Ternary is verbose
const timeout = config.timeout !== undefined ? config.timeout : 5000;
```

### 4. Provide Type Guards for Complex Checks

```typescript
// GOOD: Reusable type guard
function isValidUser(user: User | null): user is User {
  return user !== null && user.id !== "";
}

if (isValidUser(user)) {
  // Type narrowed: user is definitely User
  console.log(user.id, user.name);
}

// GOOD: Predicate for filtering
const validUsers = users.filter((u): u is User => u !== null);
```

### 5. Use Type Assertions Responsibly

```typescript
// GOOD: Narrow with explicit check
if (typeof value === "string") {
  const length = value.length;  // No assertion needed
}

// GOOD: Use a function for complex narrowing
function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// ACCEPTABLE: When certain of the type
const id = (element as HTMLInputElement).value;
```

## Common Patterns

### Pattern 1: Configuration with Defaults

```typescript
// From src/config.ts pattern
interface UndercityRc {
  timeout?: number;
  retries?: number;
  verbose?: boolean;
}

function loadConfig(): Required<UndercityRc> {
  const config: UndercityRc = {};

  // Merge defaults
  return {
    timeout: config.timeout ?? 30000,
    retries: config.retries ?? 3,
    verbose: config.verbose ?? false
  };
}
```

### Pattern 2: Statistics Aggregation

```typescript
// From src/capability-ledger.ts pattern
interface PatternModelStats {
  attempts: number;
  totalTokens: number;
  totalDurationMs: number;
}

function aggregateStats(stats: PatternModelStats[]) {
  return stats.reduce((acc, stat) => ({
    totalTokens: acc.totalTokens + (stat.totalTokens ?? 0),
    totalDurationMs: acc.totalDurationMs + (stat.totalDurationMs ?? 0)
  }), { totalTokens: 0, totalDurationMs: 0 });
}
```

### Pattern 3: Optional Property Access

```typescript
// From src/ast-index.ts pattern
class FileInfo {
  exports?: ExportedSymbol[];
  summary?: string;

  // Safe access
  getSummary(): string | null {
    return this.summary?.trim() ?? null;
  }

  // Safe array access
  getFirstExport(): ExportedSymbol | null {
    return this.exports?.[0] ?? null;
  }
}
```

### Pattern 4: Nested Object Access with Defaults

```typescript
// Safely navigate deep structures
const value = obj?.user?.address?.city ?? "Unknown";
const count = stats?.metrics?.[0]?.count ?? 0;

// Function calls with optional receiver
const result = handler?.process?.() ?? defaultValue;
```

### Pattern 5: Type Guard Predicates

```typescript
// Create predicates for filtering and narrowing
function isNonNull<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

// Usage
const values: (string | null)[] = ["a", null, "b"];
const nonNull = values.filter(isNonNull);  // Type: string[]
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Non-Null Assertions Everywhere

```typescript
// BAD: Defeats type safety
const name = user!.address!.city!.toUpperCase()!;

// GOOD: Use optional chaining
const name = user?.address?.city?.toUpperCase();

// GOOD: Use type guards
if (user?.address?.city) {
  const name = user.address.city.toUpperCase();
}
```

### ❌ Anti-Pattern 2: Using `||` for Defaults

```typescript
// BAD: Treats 0, "", false, [] as absent
const timeout = config.timeout || 5000;        // 0 becomes 5000!
const name = user.name || "Unknown";           // "" becomes "Unknown"!
const items = options.items || [];             // [] becomes []!

// GOOD: Use ?? for null/undefined only
const timeout = config.timeout ?? 5000;
const name = user.name ?? "Unknown";
const items = options.items ?? [];
```

### ❌ Anti-Pattern 3: Ignoring Null in Array Operations

```typescript
// BAD: Might crash on null item
const values = items.map(item => item.value);

// GOOD: Filter nulls first
const values = items
  .filter((item): item is Item => item !== null)
  .map(item => item.value);

// GOOD: Handle in map
const values = items
  .map(item => item?.value)
  .filter(isDefined);
```

### ❌ Anti-Pattern 4: Over-Defensive Coding

```typescript
// BAD: Redundant checks (Optional chaining already handles this)
if (user && user.address && user.address.city) {
  console.log(user.address.city);
}

// GOOD: Let optional chaining do the work
const city = user?.address?.city;
if (city) {
  console.log(city);
}
```

### ❌ Anti-Pattern 5: Mixing Null and Undefined Carelessly

```typescript
// BAD: Ambiguous meaning
interface Config {
  value: string | null | undefined;  // Hard to reason about
}

// GOOD: Be explicit about what absent means
interface Config {
  value?: string;  // Clearly: optional (undefined when absent)
  // OR
  value: string | null;  // Clearly: always present, but might be null
}
```

## TypeScript Configuration

### Strict Mode (Required in Undercity)

```json
{
  "compilerOptions": {
    "strict": true
  }
}
```

`strict: true` enables all strict type-checking options:

| Option | Effect |
|--------|--------|
| `strictNullChecks` | Treat null/undefined as distinct types |
| `strictFunctionTypes` | Enforce strict function parameter types |
| `strictBindCallApply` | Check bind/call/apply method arguments |
| `strictPropertyInitialization` | Properties must be initialized |
| `noImplicitThis` | `this` must have explicit type |
| `noImplicitAny` | Infer types or explicitly annotate |
| `noImplicitReturns` | All code paths must return value |
| `noFallthroughCasesInSwitch` | Switch cases must have break/return |
| `noImplicitOverride` | Must explicitly mark overridden methods |

### Recommended Additional Settings

```json
{
  "compilerOptions": {
    "strict": true,
    "useUnknownInCatchVariables": true,  // Catch variables as unknown
    "exactOptionalPropertyTypes": true,   // Distinguish undefined vs optional
    "noUncheckedIndexedAccess": true     // Index access returns T | undefined
  }
}
```

## Migration Guide

### From Lenient to Strict

**Step 1: Enable strict mode incrementally**
```json
{
  "compilerOptions": {
    "strictNullChecks": true,
    "noImplicitAny": true
  }
}
```

**Step 2: Address type errors (in priority order)**

1. Add return types to functions
```typescript
// Before
function getName() { return user.name; }

// After
function getName(): string { return user.name; }
```

2. Make properties optional or add null checks
```typescript
// Before
interface User { email: string; }

// After
interface User { email?: string; }  // OR
interface User { email: string | null; }
```

3. Replace `!` assertions with type guards
```typescript
// Before
const value = getValue()!;

// After
function getValue(): string {
  // Guarantee non-null return
}
```

**Step 3: Use optional chaining and nullish coalescing**
```typescript
// Before
const city = user && user.address && user.address.city || "Unknown";

// After
const city = user?.address?.city ?? "Unknown";
```

**Step 4: Run tests and type-check**
```bash
pnpm typecheck
pnpm test
```

## Reference

### Quick Operator Comparison

| Operator | Use Case | Example |
|----------|----------|---------|
| `?` | Optional property in type | `email?: string` |
| `?.` | Safe property access | `user?.email` |
| `??` | Default for null/undefined | `value ?? "default"` |
| `!` | Assert non-null | `value!` (use sparingly) |
| `\|\|` | Default for falsy values | `value \|\| "default"` |
| `&& ` | Type narrowing | `user && user.name` |

### Type Narrowing Reference

```typescript
// Check existence
if (value)                        // Eliminates null, undefined, falsy
if (value !== null)              // Eliminates null only
if (value !== undefined)         // Eliminates undefined only
if (value !== null && value !== undefined)  // Eliminates both

// Type checks
if (typeof value === "string")   // Narrows to string type
if (value instanceof MyClass)    // Narrows to MyClass

// Array/object checks
if (Array.isArray(value))        // Narrows to array
if ("property" in value)         // Checks property exists

// User-defined guards
if (isNonNull(value))            // Custom predicate (if defined)
```

### Common Type Signatures

```typescript
// Function parameter - required
function process(value: string): void {}

// Function parameter - optional (undefined when absent)
function process(value?: string): void {}

// Function parameter - might be null
function process(value: string | null): void {}

// Function return - never null
function getValue(): string {}

// Function return - might be null
function getValue(): string | null {}

// Function return - might be undefined (optional return)
function getValue(): string | undefined {}

// Array of items (some might be null)
const items: (Item | null)[] = [item1, null, item2];

// Array might be null
const items: Item[] | null = null;
```

### Safe Access Chains

```typescript
// Property access
user?.name                          // string | undefined
user?.profile?.email                // string | undefined

// Array/tuple access
items?.[0]                          // Item | undefined
items?.[0]?.name                    // string | undefined

// Function call
handler?.process()                  // any | undefined
handler?.process?.()                // any | undefined

// Combination
data?.users?.[0]?.name ?? "Unknown" // string
```

## See Also

- [TypeScript Handbook: Null and Undefined](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#null-and-undefined)
- [TypeScript Release Notes: Optional Chaining](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-7.html#optional-chaining)
- [TypeScript Release Notes: Nullish Coalescing](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-7.html#nullish-coalescing)
- [Error Handling Patterns](./docs/error-handling-patterns.md)
