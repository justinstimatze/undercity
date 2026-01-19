# Test Framework Analysis

## Executive Summary

The undercity project uses **Vitest v4.0.16** as its testing framework, with 34 test files containing approximately 18,935 lines of test code. Tests are organized into unit tests and integration tests, covering core functionality including task management, git operations, worker orchestration, and CLI commands.

## Testing Framework

### Primary Framework: Vitest

- **Version**: 4.0.16 (defined in package.json devDependencies)
- **Configuration**: `vitest.config.ts` in project root
- **Test Runner**: Modern, fast, Vite-based test framework compatible with Vitest/Jest APIs

### Key Configuration Details (vitest.config.ts)

```typescript
{
  test: {
    globals: true,              // Enable global describe/it/expect without imports
    environment: "node",        // Node.js environment (not browser/jsdom)
    include: ["src/__tests__/**/*.test.ts"],  // Test file pattern
    coverage: {
      provider: "v8",           // V8 coverage provider (faster than Istanbul)
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/__tests__/**",     // Don't measure coverage of test files
        "src/index.ts",         // Skip library entry point
        "src/cli.ts",           // Skip CLI entry point
        "src/commands/**"       // Skip command definitions
      ]
    }
  }
}
```

**Note**: Coverage thresholds are commented out (lines 70%, functions 70%, branches 70%, statements 70%). These can be enabled when ready to enforce minimum coverage requirements.

## Test Organization

### Directory Structure

```
src/__tests__/
├── *.test.ts                    # 30 unit test files
└── integration/
    └── *.test.ts                # 4 integration test files
```

### Test File Naming Convention

- **Pattern**: `*.test.ts`
- **Location**: All test files under `src/__tests__/`
- **Integration tests**: Subdirectory `src/__tests__/integration/`

## Complete Test File Inventory

### Unit Tests (30 files)

| Test File | Tests | Source File(s) |
|-----------|-------|----------------|
| api-usage-guard.test.ts | API usage limits, rate limiting | api-usage-guard.ts |
| ast-index.test.ts | AST indexing, symbol lookup | ast-index.ts |
| cache.test.ts | Context caching, error fix patterns | cache.ts |
| capability-ledger.test.ts | Model capability tracking | capability-ledger.ts |
| cli.test.ts | CLI argument parsing | cli.ts |
| complexity.test.ts | Task complexity assessment | complexity.ts |
| config.test.ts | Configuration loading, merging | config.ts |
| context.test.ts | Codebase context extraction | context.ts |
| decision-tracker.test.ts | Decision capture/resolution | decision-tracker.ts |
| dual-logger.test.ts | Worker logging (file + console) | dual-logger.ts |
| efficiency-tools.test.ts | ast-grep, jq, comby integration | efficiency-tools.ts |
| error-fix-patterns.test.ts | Error→fix pattern learning | error-fix-patterns.ts |
| fast-path.test.ts | Fast-path optimization | fast-path.ts |
| feedback-metrics.test.ts | Historical metrics analysis | feedback-metrics.ts |
| file-tracker.test.ts | File conflict detection | file-tracker.ts |
| git.test.ts | Git operations (mocked) | git.ts |
| knowledge.test.ts | Knowledge compounding | knowledge.ts |
| mcp-protocol.test.ts | MCP JSON-RPC 2.0 handler | mcp-protocol.ts |
| oracle-mcp-integration.test.ts | Oracle MCP tool integration | oracle.ts + mcp-tools.ts |
| orchestrator-validation.test.ts | Orchestrator pre-flight checks | orchestrator.ts |
| output.test.ts | Dual-mode output (human/agent) | output.ts |
| persistence.test.ts | State file I/O | persistence.ts |
| plan-parser.test.ts | Markdown plan parsing | plan-parser.ts |
| self-tuning.test.ts | Learned routing profile | self-tuning.ts |
| task-analyzer.test.ts | Task analysis (packages, files, risk) | task-analyzer.ts |
| task-board-analyzer.test.ts | Board-level insights | task-board-analyzer.ts |
| task-scheduler.test.ts | Compatible task matchmaking | task-scheduler.ts |
| task-schema.test.ts | Task prefix conventions | task-schema.ts |
| task.test.ts | Task board CRUD operations | task.ts |
| verification.test.ts | Build/test/lint verification | verification.ts |

### Integration Tests (4 files)

| Test File | Tests | Dependencies |
|-----------|-------|--------------|
| cli-smoke.test.ts | CLI commands don't crash, exit codes | Real CLI binary (bin/undercity.js) |
| grind-flow.test.ts | End-to-end grind workflow | Git repo, task board, orchestrator |
| merge-queue.test.ts | Serial merge pipeline | Real git operations |
| worktree-manager.test.ts | Git worktree lifecycle | Real git operations (skipped in coverage mode) |

**Total**: 34 test files, ~18,935 lines of test code

## Testing Patterns

### Test Syntax

Vitest uses the familiar describe/it/expect syntax from Vitest/Jest:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("module name", () => {
  beforeEach(() => {
    // Setup per test
  });

  afterEach(() => {
    // Cleanup per test
  });

  it("should do something", () => {
    const result = functionUnderTest();
    expect(result).toBe(expectedValue);
  });
});
```

### Common Patterns Used

#### 1. File System Fixtures (Temporary Directories)

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "test-prefix-"));
  // Create test files/directories
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});
```

**Usage**: task.test.ts, cli-smoke.test.ts, worktree-manager.test.ts, merge-queue.test.ts, grind-flow.test.ts

#### 2. Module Mocking (vi.mock)

```typescript
import { vi } from "vitest";

// Mock entire module before import
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => "mock content"),
  writeFileSync: vi.fn(),
}));

// Import after mocking
import { readFileSync } from "node:fs";
```

**Usage**: cache.test.ts (mocks fs, child_process)

#### 3. CLI Process Spawning (execFileSync)

```typescript
import { execFileSync } from "node:child_process";

function runCli(args: string[]): string {
  return execFileSync("node", [CLI_PATH, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

it("CLI command works", () => {
  const output = runCli(["tasks"]);
  expect(output).toContain("expected content");
});
```

**Usage**: cli-smoke.test.ts

#### 4. Git Repository Setup for Integration Tests

```typescript
beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "git-test-"));

  // Initialize git repo
  execSync("git init -b main", { cwd: testDir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: testDir });
  execSync('git config user.name "Test"', { cwd: testDir });

  // Create initial commit
  writeFileSync(join(testDir, "README.md"), "# Test");
  execSync("git add . && git commit -m 'init'", { cwd: testDir });
});
```

**Usage**: worktree-manager.test.ts, merge-queue.test.ts, grind-flow.test.ts, cli-smoke.test.ts

#### 5. Conditional Test Skipping

```typescript
const isCoverage = process.env.npm_lifecycle_event?.includes("coverage");
const describeGit = isCoverage ? describe.skip : describe.sequential;

describeGit("Git Operations", () => {
  // These tests run normally but skip during coverage runs
});
```

**Usage**: worktree-manager.test.ts (skips git operations during coverage to prevent interference)

#### 6. State Isolation Between Tests

```typescript
beforeEach(() => {
  mockFiles.clear();
  mockDirs.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetAllMocks();
});
```

**Usage**: All unit tests that use mocks

## Test Execution

### NPM Scripts

```bash
# Run all tests (watch mode)
pnpm test

# Run tests with coverage report
pnpm test:coverage

# Type checking (no tests)
pnpm typecheck
```

### Vitest CLI

Vitest provides additional options:

```bash
# Run tests matching pattern
vitest task.test.ts

# Run in watch mode
vitest --watch

# Generate coverage
vitest --coverage

# Run tests once and exit
vitest --run
```

## Coverage Configuration

### Provider: V8

- **Why V8**: Faster than Istanbul, native to Node.js
- **Reporters**:
  - `text` - Console output with summary
  - `html` - Interactive HTML report at `coverage/index.html`
  - `json-summary` - Machine-readable summary at `coverage/coverage-summary.json`

### Coverage Targets

Files included in coverage:
- All `src/**/*.ts` files

Files excluded from coverage:
- `src/__tests__/**` - Test files themselves
- `src/index.ts` - Library entry point (trivial re-exports)
- `src/cli.ts` - CLI entry point (trivial command registration)
- `src/commands/**` - Command definitions (thin wrappers)

### Coverage Thresholds (Currently Disabled)

The following thresholds are commented out in vitest.config.ts but can be enabled:

```typescript
thresholds: {
  lines: 70,
  functions: 70,
  branches: 70,
  statements: 70,
}
```

## Test Types

### Unit Tests

**Characteristics**:
- Test individual modules in isolation
- Use mocks for external dependencies (fs, child_process, network)
- Fast execution (<100ms per test file typically)
- No external state dependencies

**Examples**:
- `task.test.ts` - CRUD operations on task board
- `cache.test.ts` - Context caching with mocked file system
- `complexity.test.ts` - Task complexity assessment
- `config.test.ts` - Configuration loading and merging

### Integration Tests

**Characteristics**:
- Test multiple modules working together
- Use real external systems (git, file system, CLI binary)
- Slower execution (seconds per test file)
- Require setup/teardown of test environments

**Examples**:
- `cli-smoke.test.ts` - Real CLI binary execution
- `worktree-manager.test.ts` - Real git worktree operations
- `merge-queue.test.ts` - Real git merge operations
- `grind-flow.test.ts` - End-to-end orchestrator workflow

## Testing Dependencies

### Core Testing Tools

From package.json:

```json
{
  "devDependencies": {
    "vitest": "^4.0.16",
    "@vitest/coverage-v8": "^4.0.16"
  }
}
```

### Test Helper Libraries

All tests use Node.js built-in modules:
- `node:fs` - File system operations
- `node:child_process` - Process spawning (execSync, execFileSync)
- `node:os` - OS utilities (tmpdir)
- `node:path` - Path manipulation

No external test utility libraries are used (no sinon, no test-data-bot, etc.). Tests use Vitest's built-in mocking (`vi.mock`, `vi.fn`, `vi.spyOn`).

## Pre-Commit Hook Integration

From `.husky/pre-commit` (inferred from package.json scripts):

```bash
pnpm test:coverage  # Runs tests with coverage before commit
```

This ensures:
1. All tests pass before commit
2. Coverage reports are generated
3. No regressions are committed

## Key Testing Insights

### Test Coverage Scope

**Well-covered modules** (based on test file presence):
- Task management (task.test.ts - 377 lines)
- Caching (cache.test.ts - 518 lines)
- Git operations (git.test.ts + integration tests)
- Configuration (config.test.ts)
- Worker components (dual-logger.test.ts, verification.test.ts)
- Analysis tools (complexity.test.ts, task-analyzer.test.ts, feedback-metrics.test.ts)

**Integration coverage**:
- CLI smoke tests verify all commands don't crash
- Git worktree lifecycle fully tested
- Merge queue tested with real git operations
- End-to-end grind workflow tested

### Testing Philosophy

From test file analysis:
1. **Isolation**: Unit tests use mocks for external dependencies
2. **Real operations for integration**: Git operations use real git commands in temp directories
3. **Fast feedback**: Unit tests run quickly, integration tests run separately
4. **Pragmatic**: Some tests skip during coverage mode to prevent interference
5. **Safety**: Integration tests clean up temp directories in afterAll hooks

## Future Improvements (Recommendations)

Based on analysis:

1. **Enable coverage thresholds**: Uncomment the 70% thresholds in vitest.config.ts when codebase stabilizes
2. **Separate integration tests**: Consider moving integration tests to a separate test command for faster unit test feedback
3. **Add benchmark tests**: Consider using Vitest's benchmark feature for performance-critical code
4. **Snapshot testing**: For complex output formatting (output.ts), consider snapshot tests
5. **Parallel execution**: Most unit tests could run in parallel - consider enabling `test.threads: true` in vitest.config.ts

## Quick Reference

### Running Specific Tests

```bash
# Single test file
pnpm test task.test.ts

# Pattern matching
pnpm test integration

# Watch mode for TDD
pnpm test --watch
```

### Viewing Coverage

```bash
# Generate coverage report
pnpm test:coverage

# Open HTML report
open coverage/index.html  # macOS
xdg-open coverage/index.html  # Linux
start coverage/index.html  # Windows
```

### Writing New Tests

Template for new unit test:

```typescript
/**
 * Module Name Tests
 *
 * Brief description of what this test suite covers.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { functionUnderTest } from "../module.js";

describe("module.ts", () => {
  beforeEach(() => {
    // Setup
  });

  afterEach(() => {
    // Cleanup
  });

  describe("functionUnderTest", () => {
    it("should handle normal case", () => {
      const result = functionUnderTest("input");
      expect(result).toBe("expected");
    });

    it("should handle edge case", () => {
      const result = functionUnderTest("");
      expect(result).toBe("");
    });
  });
});
```

## Appendix: Test File Details

### Test Line Counts

Approximate distribution:
- **Smallest**: ~100-200 lines (simple modules like task-schema.test.ts)
- **Medium**: ~200-400 lines (most unit tests)
- **Largest**: ~500+ lines (cache.test.ts, task.test.ts, worktree-manager.test.ts)
- **Total**: ~18,935 lines across 34 test files

### Test Execution Time Estimate

Based on test patterns:
- **Unit tests**: ~5-10 seconds total (fast mocked tests)
- **Integration tests**: ~30-60 seconds total (real git operations)
- **Total suite**: ~40-70 seconds

Actual times may vary based on hardware and parallel execution settings.
