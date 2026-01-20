/**
 * Null-Safety Patterns - Real-world examples from the Undercity codebase
 *
 * This file demonstrates null-safe property access patterns using optional chaining (?.)
 * and nullish coalescing (??), with examples derived from actual code in the project.
 *
 * Run with: pnpm typecheck (validates TypeScript)
 */

// ============================================================================
// 1. Configuration with Optional Properties and Defaults
// ============================================================================

/**
 * Example from src/config.ts
 * Shows how to handle optional configuration properties with type-safe defaults
 */
namespace ConfigPattern {
  interface UndercityRc {
    timeout?: number;
    retries?: number;
    verbose?: boolean;
    stream?: boolean;
    parallel?: number;
  }

  const DEFAULT_CONFIG: Required<UndercityRc> = {
    timeout: 30000,
    retries: 3,
    verbose: false,
    stream: false,
    parallel: 1,
  };

  /**
   * Load config with defaults - uses ?? for null/undefined handling
   */
  function loadConfig(raw: UndercityRc): Required<UndercityRc> {
    return {
      timeout: raw.timeout ?? DEFAULT_CONFIG.timeout,
      retries: raw.retries ?? DEFAULT_CONFIG.retries,
      verbose: raw.verbose ?? DEFAULT_CONFIG.verbose,
      stream: raw.stream ?? DEFAULT_CONFIG.stream,
      parallel: raw.parallel ?? DEFAULT_CONFIG.parallel,
    };
  }

  // Usage examples
  const config1 = loadConfig({});  // All defaults
  const config2 = loadConfig({ timeout: 5000 });  // Mixed

  console.log(config1.timeout);  // 30000
  console.log(config2.timeout);  // 5000
}

// ============================================================================
// 2. Statistics Aggregation with Nullish Coalescing
// ============================================================================

/**
 * Example from src/capability-ledger.ts
 * Shows how to safely aggregate optional numeric properties
 */
namespace StatsPattern {
  interface PatternModelStats {
    attempts: number;
    totalTokens?: number;
    totalDurationMs?: number;
    totalRetries?: number;
  }

  /**
   * Aggregate stats with safe null handling
   * Uses ?? 0 to provide defaults for optional numeric properties
   */
  function aggregateStats(
    stats: PatternModelStats[],
  ): { totalTokens: number; totalDurationMs: number; totalRetries: number } {
    let totalTokens = 0;
    let totalDurationMs = 0;
    let totalRetries = 0;

    for (const stat of stats) {
      totalTokens += stat.totalTokens ?? 0;
      totalDurationMs += stat.totalDurationMs ?? 0;
      totalRetries += stat.totalRetries ?? 0;
    }

    return { totalTokens, totalDurationMs, totalRetries };
  }

  // Usage examples
  const stats: PatternModelStats[] = [
    {
      attempts: 5,
      totalTokens: 1000,
      totalDurationMs: 500,
      totalRetries: 1,
    },
    {
      attempts: 3,
      // totalTokens is undefined
      totalDurationMs: 300,
      // totalRetries is undefined
    },
  ];

  const result = aggregateStats(stats);
  console.log(result);  // Safe: all values are definitely numbers
}

// ============================================================================
// 3. Nested Object Access with Optional Chaining
// ============================================================================

/**
 * Example from src/ast-index.ts and other modules
 * Shows safe navigation through potentially null/undefined nested structures
 */
namespace NestedAccessPattern {
  interface FileInfo {
    path: string;
    summary?: string;
    exports?: ExportedSymbol[];
    metadata?: FileMetadata;
  }

  interface ExportedSymbol {
    name: string;
    type: string;
    line: number;
  }

  interface FileMetadata {
    dependencies?: string[];
    lastModified?: Date;
  }

  /**
   * Safe access to deeply nested properties
   * Uses ?. to stop at any null/undefined
   */
  function getFileSummary(file: FileInfo | null): string {
    // Optional chaining with nullish coalescing
    return file?.summary?.trim() ?? "No summary";
  }

  /**
   * Safe array access with optional chaining
   */
  function getFirstExport(file: FileInfo | null): string | null {
    // file?.exports?.[0]?.name is null if any step is null/undefined
    return file?.exports?.[0]?.name ?? null;
  }

  /**
   * Safe navigation with multiple fallbacks
   */
  function getDependencies(file: FileInfo | null): string[] {
    return file?.metadata?.dependencies ?? [];
  }

  // Usage examples
  const file: FileInfo = {
    path: "src/module.ts",
    summary: "  Module documentation  ",
  };

  console.log(getFileSummary(file));  // "Module documentation"
  console.log(getFirstExport(file));  // null (no exports)
  console.log(getDependencies(file));  // [] (no metadata)

  // With null
  console.log(getFileSummary(null));  // "No summary"
  console.log(getFirstExport(null));  // null
  console.log(getDependencies(null));  // []
}

// ============================================================================
// 4. Function Calls with Optional Receivers
// ============================================================================

/**
 * Example from src/automated-pm.ts, src/context.ts
 * Shows how to safely call methods on possibly null/undefined objects
 */
namespace OptionalCallPattern {
  interface Decision {
    question: string;
    options?: string[];
  }

  interface Handler {
    process?: (data: unknown) => string;
  }

  /**
   * Safely call optional methods with fallback
   */
  function formatDecision(decision: Decision | null): string {
    // Format options if present, otherwise use default
    const optionsStr = decision?.options?.join(", ") ?? "No options provided";
    return `${decision?.question ?? "Unknown"}: ${optionsStr}`;
  }

  /**
   * Call optional function with default result
   */
  function handleData(handler: Handler | null, data: unknown): string {
    return handler?.process?.(data) ?? "No handler available";
  }

  // Usage examples
  const decision: Decision = {
    question: "Which model?",
    options: ["haiku", "sonnet", "opus"],
  };

  console.log(formatDecision(decision));
  // "Which model?: haiku, sonnet, opus"

  console.log(formatDecision(null));
  // "Unknown: No options provided"

  const handler: Handler = {
    process: (data) => `Processed: ${String(data)}`,
  };

  console.log(handleData(handler, "test"));
  // "Processed: test"

  console.log(handleData(null, "test"));
  // "No handler available"
}

// ============================================================================
// 5. Type Guards and Narrowing
// ============================================================================

/**
 * Example of type-safe filtering and narrowing
 * Shows how to eliminate null/undefined types through runtime checks
 */
namespace TypeGuardPattern {
  /**
   * Reusable type guard to filter nulls
   * Narrows type from T | null | undefined to T
   */
  function isNonNull<T>(value: T | null | undefined): value is T {
    return value !== null && value !== undefined;
  }

  /**
   * Predicate for filtering
   */
  function isValidUser(user: User | null): user is User {
    return user !== null && user.id !== "";
  }

  interface User {
    id: string;
    name: string;
    email?: string;
  }

  /**
   * Filter array of nullable items
   * Result type is narrowed to User[]
   */
  function getValidUsers(users: (User | null)[]): User[] {
    return users.filter(isNonNull);
  }

  /**
   * Type narrowing in conditional
   */
  function processUser(user: User | null): void {
    if (isValidUser(user)) {
      // Type is narrowed to User here
      console.log(user.id, user.name);
    }
  }

  // Usage examples
  const users: (User | null)[] = [
    { id: "1", name: "Alice" },
    null,
    { id: "2", name: "Bob", email: "bob@example.com" },
    null,
  ];

  const validUsers = getValidUsers(users);
  console.log(validUsers.length);  // 2

  // All users in validUsers array are definitely User
  validUsers.forEach((user) => {
    console.log(user.id);  // No type error
  });
}

// ============================================================================
// 6. Safe Property Access with Conditional Rendering
// ============================================================================

/**
 * Example of combining optional chaining with type narrowing
 * Shows patterns from src/dashboard.ts, src/feedback-metrics.ts
 */
namespace ConditionalAccessPattern {
  interface GrindMetrics {
    progress?: number;
    count?: number;
    errors?: string[];
  }

  interface Report {
    metrics?: GrindMetrics;
    timestamp?: Date;
  }

  /**
   * Safely access and process optional nested properties
   */
  function generateReport(data: Report | null): string {
    // Optional chaining prevents errors if any step is null/undefined
    const progress = data?.metrics?.progress;

    if (progress !== undefined && progress > 0) {
      return `Progress: ${progress}%`;
    }

    // Fallback to another optional property
    const count = data?.metrics?.count ?? 0;
    return `Count: ${count}`;
  }

  /**
   * Safely iterate over optional arrays
   */
  function summarizeErrors(data: Report | null): string {
    // If metrics or errors is undefined, optional chaining returns undefined
    // Nullish coalescing provides empty array as default
    const errors = data?.metrics?.errors ?? [];

    if (errors.length === 0) {
      return "No errors";
    }

    return `${errors.length} error(s): ${errors.slice(0, 3).join("; ")}`;
  }

  // Usage examples
  const report1: Report = {
    metrics: { progress: 75, count: 100 },
  };

  const report2: Report = {
    metrics: { errors: ["Error 1", "Error 2"] },
  };

  console.log(generateReport(report1));  // "Progress: 75%"
  console.log(generateReport(report2));  // "Count: 0"
  console.log(summarizeErrors(report1));  // "No errors"
  console.log(summarizeErrors(report2));  // "2 error(s): Error 1; Error 2"
  console.log(summarizeErrors(null));  // "No errors"
}

// ============================================================================
// 7. Common Anti-Patterns and How to Fix Them
// ============================================================================

/**
 * Shows problematic patterns and their fixes
 */
namespace AntiPatternComparison {
  interface Config {
    timeout?: number;
    name?: string;
    items?: string[];
  }

  // ❌ ANTI-PATTERN: Using || instead of ?? for numeric defaults
  function badDefaultHandling(config: Config): void {
    // If timeout is 0, this becomes 5000! (0 is falsy)
    const timeout = config.timeout || 5000;
    console.log(timeout);  // May not be what you want
  }

  // ✅ FIXED: Use ?? for null/undefined only
  function goodDefaultHandling(config: Config): void {
    // Only defaults to 5000 if timeout is null/undefined
    const timeout = config.timeout ?? 5000;
    console.log(timeout);  // Correct: preserves 0
  }

  // ❌ ANTI-PATTERN: Multiple ! assertions
  function badNonNullAssertions(config: Config): number {
    // Defeats type safety - TypeScript won't catch errors
    return config.timeout!.toString().length!;  // Crashes if timeout is undefined
  }

  // ✅ FIXED: Use type guards
  function goodNonNullHandling(config: Config): number {
    if (config.timeout !== undefined) {
      return config.timeout.toString().length;
    }
    return 0;
  }

  // ❌ ANTI-PATTERN: Verbose null checks
  function badVerboseChecks(config: Config): string {
    if (config && config.name && config.name.length > 0) {
      return config.name;
    }
    return "Unknown";
  }

  // ✅ FIXED: Use optional chaining and nullish coalescing
  function goodConciseChecks(config: Config): string {
    return config?.name?.trim() ?? "Unknown";
  }

  // Test cases
  const config: Config = { timeout: 0, name: "", items: [] };

  console.log("Default handling:");
  badDefaultHandling(config);  // Outputs 5000 (wrong!)
  goodDefaultHandling(config);  // Outputs 0 (correct)
}

// ============================================================================
// 8. Real-World Workflow: Processing Data with Optional Fields
// ============================================================================

/**
 * Shows a complete workflow combining multiple null-safety patterns
 */
namespace RealWorldWorkflow {
  interface TaskResult {
    id: string;
    objective?: string;
    status?: "pending" | "complete" | "failed";
    metadata?: {
      duration?: number;
      attempts?: number;
      error?: string;
    };
  }

  /**
   * Comprehensive example combining multiple patterns
   */
  function processTaskResult(result: TaskResult | null): string {
    // Return early if null
    if (!result) {
      return "No result";
    }

    // Type is narrowed to TaskResult here
    const objective = result.objective ?? "Unnamed task";
    const status = result.status ?? "pending";
    const duration = result.metadata?.duration ?? 0;
    const attempts = result.metadata?.attempts ?? 1;
    const error = result.metadata?.error;

    // Build report
    const report = [
      `Task: ${objective}`,
      `Status: ${status}`,
      `Duration: ${duration}ms`,
      `Attempts: ${attempts}`,
    ];

    if (error) {
      report.push(`Error: ${error}`);
    }

    return report.join("\n");
  }

  /**
   * Filter and transform array of results
   */
  function summarizeResults(results: (TaskResult | null)[]): {
    completed: number;
    failed: number;
    totalDuration: number;
  } {
    let completed = 0;
    let failed = 0;
    let totalDuration = 0;

    for (const result of results) {
      if (!result) continue;  // Skip nulls

      if (result.status === "complete") {
        completed++;
      } else if (result.status === "failed") {
        failed++;
      }

      totalDuration += result.metadata?.duration ?? 0;
    }

    return { completed, failed, totalDuration };
  }

  // Usage
  const results: (TaskResult | null)[] = [
    {
      id: "1",
      objective: "Add validation",
      status: "complete",
      metadata: { duration: 1000, attempts: 1 },
    },
    null,
    {
      id: "2",
      objective: "Fix bug",
      status: "failed",
      metadata: { duration: 2000, attempts: 3, error: "Timeout" },
    },
  ];

  for (const result of results) {
    if (result) {
      console.log(processTaskResult(result));
      console.log("---");
    }
  }

  const summary = summarizeResults(results);
  console.log(summary);  // { completed: 1, failed: 1, totalDuration: 3000 }
}

// ============================================================================
// Export for testing
// ============================================================================

// This file is used for type checking validation
export {};
