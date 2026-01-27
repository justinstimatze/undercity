# Coding Standards

This document establishes consistent coding conventions across the undercity codebase. These standards are derived from patterns observed in 136+ modified files across 100+ completed tasks.

## Table of Contents
- [General Conventions](#general-conventions)
- [Naming Conventions](#naming-conventions)
- [File Organization](#file-organization)
- [TypeScript Patterns](#typescript-patterns)
- [Code Style](#code-style)
- [Documentation Standards](#documentation-standards)
- [Error Handling](#error-handling)
- [Testing Guidelines](#testing-guidelines)

---

## General Conventions

### Philosophy
- **Type Safety First**: Never use `any` types. Use strict TypeScript settings.
- **Explicit Over Implicit**: Prefer explicit return types and parameter types for exported functions.
- **Fail Fast**: Validate inputs early, return errors explicitly using Result types or discriminated unions.
- **Token Efficiency**: Cache context, compress where possible, avoid redundant LLM calls.

### Code Quality Targets
- **Cyclomatic complexity**: ≤10 per function
- **Lines of code**: ≤60 per function
- **Nesting depth**: ≤3 levels (prefer early returns)
- **Function naming**: Clear intent (avoid vague names like `process`, `handle`, `do`)

---

## Naming Conventions

### Variables and Constants

**Variables (camelCase)**:
```typescript
// GOOD
const targetFiles: string[] = [];
const fileSummaries: Record<string, string> = {};
const isNewFileTask = task.toLowerCase().includes("new file");

// BAD
const target_files: string[] = [];       // snake_case
const FileSummaries = {};                // PascalCase for variables
const NewFileTask = false;               // PascalCase for booleans
```

**Constants (SCREAMING_SNAKE_CASE for config-level constants)**:
```typescript
// GOOD
const CONTEXT_LIMITS: Record<AgentType, number> = {
	scout: 1000,
	planner: 10000,
	builder: 5000,
};

const MAX_BATCH_SIZE = 10000;
const DEFAULT_TIMEOUT_MS = 30000;

// Inline constants can use camelCase if they're simple values
const defaultRetryCount = 3;
```

**Unused parameters (underscore prefix + JSDoc notation)**:
```typescript
// GOOD: Document why parameter is unused
/**
 * Build briefing document
 * @param _mode - Unused for now, reserved for future context modes
 * @param _tokenBudget - Unused for now, reserved for budget enforcement
 */
function buildBriefingDoc(briefing: ContextBriefing, _mode: ContextMode, _tokenBudget: number): string {
	// Implementation
}

// BAD: No underscore or documentation
function buildBriefingDoc(briefing: ContextBriefing, mode: ContextMode, tokenBudget: number): string {
	// Triggers "unused variable" linting errors
}
```

### Functions and Methods

**Functions (camelCase, verb-first)**:
```typescript
// GOOD: Clear action verbs
export function extractSearchTerms(task: string): string[] { }
export function parseMarkdownSections(content: string): PlanSection[] { }
export async function prepareContext(task: string, options?: ContextOptions): Promise<ContextBriefing> { }

// BAD: Noun-based or vague names
export function searchTerms(task: string) { }     // Missing verb
export function process(content: string) { }      // Too vague
export function doStuff(task: string) { }         // Meaningless
```

**Boolean-returning functions (is/has/should prefix)**:
```typescript
// GOOD
export function isNewFileTask(task: string): boolean { }
export function hasFileChanged(filePath: string): boolean { }
export function shouldEscalate(attempts: number): boolean { }

// BAD
export function newFileTask(task: string): boolean { }    // Ambiguous
export function fileChanged(filePath: string): boolean { } // Looks like a setter
```

### Types and Interfaces

**Types (PascalCase)**:
```typescript
// GOOD
export type SessionStatus = "planning" | "executing" | "complete" | "failed";
export type ModelTier = "sonnet" | "opus";
export type ContextMode = "full" | "compact" | "minimal";

// BAD
export type sessionStatus = "planning" | "executing";  // camelCase
export type model_tier = "sonnet" | "opus";            // snake_case
```

**Interfaces (PascalCase, no 'I' prefix)**:
```typescript
// GOOD: Descriptive names without prefix
export interface ContextBriefing {
	objective: string;
	targetFiles: string[];
	constraints: string[];
}

export interface PackageValidationResult {
	isSafe: boolean;
	warnings: string[];
}

// BAD: Hungarian notation 'I' prefix (avoid)
export interface IContextBriefing { }
export interface IPackageValidationResult { }
```

**Result types (descriptive suffix)**:
```typescript
// GOOD: Clear intent with Result/Response/Options suffix
export interface ASTIndexResult {
	sufficient: boolean;
	filesFound: number;
}

export interface ValidationResult {
	isSafe: boolean;
	warnings: string[];
}

// Pattern for options/config objects
export interface PrepareContextOptions {
	cwd?: string;
	repoRoot?: string;
	mode?: ContextMode;
}
```

### Modules and Files

**File names (kebab-case)**:
```
// GOOD
context.ts
package-validator.ts
task-file-patterns.ts
error-fix-patterns.ts

// BAD
Context.ts              // PascalCase
packageValidator.ts     // camelCase
task_file_patterns.ts   // snake_case
```

**Module exports (descriptive)**:
```typescript
// GOOD: Export primary class/function with descriptive name
export class ContextCache { }
export function prepareContext() { }
export function getASTIndex() { }

// GOOD: Export types alongside implementation
export type { ContextBriefing, ContextMode };

// BAD: Default exports (avoid - harder to refactor)
export default class Cache { }
```

---

## File Organization

### File Header Comments

Every file should start with a block comment describing its purpose:

```typescript
/**
 * Context Summarization Module
 *
 * Provides smart context extraction for agents to reduce token usage.
 * Instead of passing entire plan files to every agent, this module
 * extracts only the relevant sections each agent needs.
 *
 * Context limits by agent type:
 * - Scout: Just the goal (~1K chars)
 * - Planner: Full scout report (~10K chars)
 * - Builder: Implementation details only (~5K chars)
 * - Reviewer: Review requirements (~3K chars)
 */
```

### Section Dividers

Use comment dividers to organize large files:

```typescript
// ============================================================================
// PRE-FLIGHT CONTEXT PREPARATION ("Innie" Factory)
// ============================================================================
//
// This section provides context preparation for solo mode.
// Uses FREE local tools (no LLM tokens) to gather exactly what the agent needs.
//
// Philosophy:
// - Agent should know WHERE to look before starting
// - Agent should know WHAT signatures/types it's working with
// ============================================================================

export async function prepareContext() { }
export function extractSearchTerms() { }
```

### Import Organization

Order imports in three groups:

```typescript
// 1. Node.js built-ins (node: prefix)
import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// 2. Third-party packages
import chalk from "chalk";
import pino from "pino";

// 3. Local modules (with .js extension for ESM)
import { sessionLogger } from "./logger.js";
import type { AgentType, ContextMode } from "./types.js";
```

**ESM imports require `.js` extension**:
```typescript
// GOOD: Explicit .js extension
import { getASTIndex } from "./ast-index.js";
import type { Task } from "./types.js";

// BAD: Missing extension (breaks ESM)
import { getASTIndex } from "./ast-index";
```

### Function Organization Within Files

Order functions logically:

1. **Exported functions first** (public API)
2. **Private helper functions** (prefixed with `_` or not exported)
3. **Type guards and utility functions**
4. **Constants and lookup tables**

```typescript
// PUBLIC API
export async function prepareContext() { }
export function summarizeContextForAgent() { }

// PRIVATE HELPERS
function identifyTargetAreas(task: string): string[] { }
function extractSearchTerms(task: string): string[] { }

// TYPE GUARDS
function isNewFileTask(task: string): boolean { }

// CONSTANTS
const CONTEXT_LIMITS = { /* ... */ };
```

---

## TypeScript Patterns

### Strict Mode

Always enable strict mode in `tsconfig.json`:

```json
{
	"compilerOptions": {
		"strict": true,
		"noImplicitAny": true,
		"noImplicitThis": true,
		"useUnknownInCatchVariables": true
	}
}
```

### Type Inference vs Explicit Types

**Let TypeScript infer when obvious**:
```typescript
// GOOD: Inference is clear
const items = [1, 2, 3];
const targetFiles = briefing.targetFiles.slice(0, 10);
const isNewFile = task.includes("new file");

// GOOD: Explicit types for clarity
const processItem = (item: ItemType): Result => {
	// ...
};
```

**Always use explicit types for**:
- Function parameters
- Function return types (exported functions)
- Public API interfaces

```typescript
// GOOD
export async function prepareContext(
	task: string,
	options: PrepareContextOptions = {},
): Promise<ContextBriefing> {
	// ...
}

// BAD: Missing return type
export async function prepareContext(task: string, options = {}) {
	// TypeScript infers Promise<any> - loses type safety
}
```

### Discriminated Unions (Preferred for State)

Use discriminated unions over boolean flags:

```typescript
// GOOD: Discriminated union
export type SessionStatus =
	| "planning"
	| "executing"
	| "complete"
	| "failed";

export type Result<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

// BAD: Boolean flags
export interface SessionState {
	isPlanning: boolean;
	isExecuting: boolean;
	isComplete: boolean;
	isFailed: boolean;
}
```

### Record Types Over Index Signatures

```typescript
// GOOD: Explicit keys with Record
const CONTEXT_LIMITS: Record<AgentType, number> = {
	scout: 1000,
	planner: 10000,
	builder: 5000,
	reviewer: 3000,
};

// BAD: Index signature (less type-safe)
const CONTEXT_LIMITS: { [key: string]: number } = {
	scout: 1000,
	// Typos not caught: "planer" would be valid
};
```

### Optional Chaining and Nullish Coalescing

```typescript
// GOOD: Use optional chaining
const line = error?.message?.split("\n")[0];
const timeout = options.timeout ?? DEFAULT_TIMEOUT;

// BAD: Manual null checks
const line = error && error.message ? error.message.split("\n")[0] : undefined;
const timeout = options.timeout !== undefined ? options.timeout : DEFAULT_TIMEOUT;
```

### Type Guards

```typescript
// GOOD: Type guard function
export function isAppError(error: unknown): error is AppError {
	return error instanceof AppError;
}

// Usage with type narrowing
try {
	// ...
} catch (error: unknown) {
	if (isAppError(error)) {
		// TypeScript knows error is AppError here
		console.error(error.code);
	}
}
```

### Never Use `any`

```typescript
// BAD: Loses all type safety
const data = response as any;
function process(input: any): any { }

// GOOD: Use unknown and narrow the type
const data = response as unknown as ExpectedType;

function process(input: unknown): Result {
	if (typeof input === "string") {
		// TypeScript knows input is string here
	}
	// ...
}
```

---

## Code Style

Style is enforced by Biome. Configuration in `biome.json`:

### Indentation and Spacing

```typescript
// Tabs (width 2)
function example() {
	if (condition) {
		doSomething();
	}
}

// Line width: 120 characters
const longLine = "This is a long line that should not exceed 120 characters to maintain readability and consistency";
```

### Quotes and Semicolons

```typescript
// Double quotes (enforced by Biome)
const message = "Hello, world";
const path = "./src/index.ts";

// Semicolons always (enforced by Biome)
const x = 1;
const y = 2;
```

### Trailing Commas

```typescript
// GOOD: Trailing commas in multi-line (enforced by Biome)
const obj = {
	name: "test",
	value: 123,
};

const arr = [
	"first",
	"second",
	"third",
];
```

### Structured Logging

**Use structured data, not template literals**:

```typescript
// GOOD: Structured logging with Pino
sessionLogger.info({ taskId, duration }, "Task completed");
sessionLogger.error({ error: String(error), context: { userId } }, "Operation failed");

// BAD: Template literals
console.log(`Task ${taskId} completed in ${duration}ms`);
console.error(`Error for user ${userId}: ${error}`);
```

**Security in logging**:
- Never log passwords, tokens, API keys
- Mask PII: `user@example.com` → `us***@example.com`
- Be cautious with request/response bodies

---

## Documentation Standards

### JSDoc Requirements

**All exported functions must have JSDoc** with:
- Description
- `@param` for each parameter
- `@returns` for return value
- `@example` for complex functions

```typescript
/**
 * Prepare context briefing for a task
 *
 * Uses local tools to gather relevant context before agent runs.
 * This is FREE - no LLM tokens consumed.
 *
 * @param task - Task description to gather context for
 * @param options - Optional configuration
 * @param options.cwd - Current working directory
 * @param options.repoRoot - Repository root directory
 * @param options.mode - Context verbosity mode (default: compact)
 * @returns Context briefing with target files and related information
 *
 * @example
 * ```typescript
 * const briefing = await prepareContext("Add login button", {
 *   cwd: process.cwd(),
 *   mode: "compact",
 * });
 * console.log(briefing.targetFiles);
 * ```
 */
export async function prepareContext(
	task: string,
	options: PrepareContextOptions = {},
): Promise<ContextBriefing> {
	// ...
}
```

### Inline Comments

**Use inline comments for**:
- Non-obvious logic
- Performance optimizations
- Security considerations
- Why, not what

```typescript
// GOOD: Explains WHY
// Use AST index first - faster and more accurate than git grep
const astResult = await tryASTIndexFirst(briefing, searchTerms, repoRoot, mode);

// Split-based approach avoids regex backtracking (ReDoS prevention)
const tokens = input.split(/\s+/);

// BAD: Explains WHAT (obvious from code)
// Set the value to 10
const maxRetries = 10;

// Increment counter
counter++;
```

### Unused Parameters

Document unused parameters with underscore prefix and JSDoc:

```typescript
/**
 * Build briefing document
 * @param briefing - Context briefing data
 * @param _mode - Reserved for future context modes (currently unused)
 * @param _tokenBudget - Reserved for budget enforcement (currently unused)
 */
function buildBriefingDoc(
	briefing: ContextBriefing,
	_mode: ContextMode,
	_tokenBudget: number,
): string {
	// Implementation
}
```

### Type Definitions

Document complex types with comments:

```typescript
/**
 * Context mode - controls verbosity/size of context
 *
 * - full: ~2000 tokens - comprehensive context
 * - compact: ~1000 tokens - balanced, preferred for most tasks
 * - minimal: ~375 tokens - simple tasks only
 */
export type ContextMode = "full" | "compact" | "minimal";

/**
 * Result of package validation
 */
export interface PackageValidationResult {
	/** Whether the package is safe to use */
	isSafe: boolean;
	/** Whether the package passed all checks (no warnings) */
	isClean: boolean;
	/** Reasons for concern */
	warnings: string[];
}
```

---

## Error Handling

### Catch Variables as `unknown`

```typescript
// GOOD: Catch as unknown, narrow the type
try {
	await operation();
} catch (error: unknown) {
	if (error instanceof ValidationError) {
		logger.warn({ field: error.field }, "Validation failed");
	} else if (error instanceof Error) {
		logger.error({ error: error.message }, "Unexpected error");
	} else {
		logger.error({ error: String(error) }, "Unknown error type");
	}
}

// BAD: Catch as any
try {
	await operation();
} catch (error: any) {
	// Loses all type safety
	console.error(error.message);
}
```

### Custom Error Classes

```typescript
// GOOD: Custom error with proper prototype chain
export class ValidationError extends Error {
	readonly code = "VALIDATION_ERROR";

	constructor(
		public readonly field: string,
		message?: string,
	) {
		super(message ?? `Validation failed for field: ${field}`);
		this.name = "ValidationError";
		Object.setPrototypeOf(this, ValidationError.prototype);  // Critical for instanceof
	}
}
```

### Result Types for Expected Failures

```typescript
// GOOD: Use Result types for expected failures
export type Result<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

export function parseInput(input: string): Result<ParsedData> {
	if (!input) {
		return { ok: false, error: "Input is empty" };
	}

	try {
		const data = JSON.parse(input);
		return { ok: true, value: data };
	} catch {
		return { ok: false, error: "Invalid JSON" };
	}
}

// BAD: Throw for expected failures
export function parseInput(input: string): ParsedData {
	if (!input) {
		throw new Error("Input is empty");  // Expected case shouldn't throw
	}
	return JSON.parse(input);
}
```

### Silent Failures for Optional Features

```typescript
// GOOD: Optional feature - silent failure
try {
	execSync("ast-grep --version", { timeout: 1000 });
	// ast-grep available, use it
} catch {
	// Not installed, skip (no error logging needed)
	return [];
}

// GOOD: Important feature - log and provide fallback
try {
	const config = loadConfig(path);
	return config;
} catch (error) {
	logger.warn({ error: String(error), path }, "Failed to load config, using defaults");
	return defaultConfig;
}
```

---

## Testing Guidelines

### Test File Naming

```
// GOOD
context.test.ts
package-validator.test.ts
cache.test.ts

// BAD
contextTest.ts
test-context.ts
context.spec.ts  // Use .test.ts consistently
```

### Mock Factories

**Use type-safe mock factories**:

```typescript
// GOOD: Factory function with partial overrides
function createMockTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "test-task-1",
		objective: "Test objective",
		status: "pending",
		createdAt: new Date(),
		...overrides,
	};
}

// Usage
const task = createMockTask({ status: "complete" });

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
	processTask("task-1");
	expect(consoleInfoSpy).toHaveBeenCalledWith(
		"Processing task",
		expect.objectContaining({ taskId: "task-1" }),
	);
});
```

### Test Structure

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("prepareContext", () => {
	beforeEach(() => {
		// Setup
	});

	afterEach(() => {
		// Cleanup
	});

	it("should extract target files from task description", async () => {
		// Arrange
		const task = "Modify src/context.ts to add caching";

		// Act
		const result = await prepareContext(task);

		// Assert
		expect(result.targetFiles).toContain("src/context.ts");
	});

	it("should handle new file tasks", async () => {
		const task = "Create new file src/new-module.ts (new file)";
		const result = await prepareContext(task);

		expect(result.constraints).toContain("CREATE NEW FILE: src/new-module.ts");
	});
});
```

---

## Enforcement

These standards are enforced by:
- **TypeScript compiler** (`strict: true`)
- **Biome** (formatting and linting)
- **CodeQL** (security patterns)
- **Semgrep** (additional security rules)
- **Code reviews** (manual verification)

Run checks before committing:
```bash
pnpm typecheck      # TypeScript type checking
pnpm lint           # Biome linting
pnpm format         # Biome formatting
pnpm test           # Run test suite
pnpm security       # Security scanning
```

---

## Reference

For more detailed guidance, see:
- `.claude/rules/00-critical.md` - Critical rules (git, security, scope)
- `.claude/rules/02-code-style.md` - Code style guidelines
- `.claude/rules/09-error-handling-patterns.md` - Error handling patterns
- `biome.json` - Formatting/linting configuration
- `tsconfig.json` - TypeScript configuration
