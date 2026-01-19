# Integration Test Guide

This directory contains integration tests that verify Undercity's behavior with real file systems, git repositories, and CLI execution. Integration tests are more expensive than unit tests but provide confidence that components work together correctly.

## Directory Structure

```
integration/
├── README.md              # This file
├── fixtures.ts            # Reusable test fixtures (git repos, projects)
├── helpers.ts             # Test utilities (CLI execution, git operations)
├── cli-smoke.test.ts      # CLI command smoke tests
├── worktree-manager.test.ts  # Git worktree operations
├── merge-queue.test.ts    # Merge queue operations
└── grind-flow.test.ts     # End-to-end grind workflow
```

## Fixtures vs Helpers

### Fixtures (`fixtures.ts`)

Factory functions that create complete test environments with cleanup:

- **`createTempGitRepo()`** - Git repository with initial commit
- **`createMinimalUndercityProject()`** - Full project structure
- **`createMockFileSystem()`** - Isolated temp directory
- **`createGitRepoWithHistory()`** - Repo with multiple commits
- **`createWorktreeTestFixture()`** - Project with worktrees directory

All fixtures return a `cleanup()` function that must be called to remove temp resources.

### Helpers (`helpers.ts`)

Utility functions for common test operations:

- **CLI execution**: `executeCli()`, safe command execution
- **Git operations**: `executeGit()`, `createGitCommit()`, `createGitBranch()`
- **Task board operations**: `readTaskBoard()`, `addTaskViaCli()`
- **Async utilities**: `waitFor()`, `sleep()`
- **Environment checks**: `isCoverageMode()`, `isVerificationMode()`

## Basic Usage

### Creating a Test with Git Repo

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempGitRepo } from "./fixtures.js";
import { executeCli, getCurrentGitBranch } from "./helpers.js";

describe("My Integration Test", () => {
  let repo: GitRepoFixture;

  beforeAll(() => {
    repo = createTempGitRepo({ branch: "main" });
  });

  afterAll(() => {
    repo.cleanup();
  });

  it("should work with git repo", () => {
    const branch = getCurrentGitBranch(repo.path);
    expect(branch).toBe("main");
  });
});
```

### Creating a Test with Undercity Project

```typescript
import { createMinimalUndercityProject } from "./fixtures.js";
import { executeCli, readTaskBoard } from "./helpers.js";

describe("Task Board Operations", () => {
  let project: UndercityProjectFixture;

  beforeAll(() => {
    project = createMinimalUndercityProject({
      initialTasks: [
        { objective: "Test task", priority: 1 }
      ]
    });
  });

  afterAll(() => {
    project.cleanup();
  });

  it("should add task via CLI", () => {
    executeCli(["add", "New task"], { cwd: project.path });
    const tasks = readTaskBoard(project.path);
    expect(tasks).toHaveLength(2);
  });
});
```

## Common Patterns

### Pattern 1: CLI Execution

```typescript
// Execute CLI command safely
const result = executeCli(["tasks"], { cwd: projectPath });
expect(result.success).toBe(true);
expect(result.stdout).toContain("tasks");

// Execute command that should fail
const result = executeCli(["invalid-command"], {
  shouldFail: true
});
expect(result.success).toBe(false);
```

### Pattern 2: Git Operations

```typescript
// Create a commit
writeFileToRepo(repoPath, "test.txt", "content");
createGitCommit(repoPath, "Add test file");

// Check working directory
expect(isGitWorkingDirClean(repoPath)).toBe(true);

// Get commit history
const log = getGitLog(repoPath, { limit: 5 });
expect(log[0]).toContain("Add test file");
```

### Pattern 3: Task Board Operations

```typescript
// Add task via CLI
const taskId = addTaskViaCli(projectPath, "Test task", {
  priority: 5
});

// Read task board
const tasks = readTaskBoard(projectPath);
const task = tasks.find(t => t.id === taskId);
expect(task?.status).toBe("pending");

// Modify board directly
writeTaskBoard(projectPath, [
  { id: taskId, objective: "Updated", status: "complete", priority: 5 }
]);
```

### Pattern 4: Async Operations

```typescript
// Wait for a condition
await waitFor(() => fileExistsInRepo(repoPath, "output.txt"), {
  timeout: 5000,
  interval: 100
});

// Simple delay
await sleep(1000);
```

## Test Lifecycle Hooks

### `beforeAll` - Setup Phase

Create fixtures and initialize test environment:

```typescript
beforeAll(() => {
  project = createMinimalUndercityProject();
  // Additional setup
});
```

### `afterAll` - Cleanup Phase

Clean up all resources:

```typescript
afterAll(() => {
  project.cleanup();
  // Additional cleanup
});
```

### `afterEach` - Per-Test Cleanup

Reset state between tests:

```typescript
afterEach(() => {
  // Reset task board
  writeTaskBoard(project.path, []);
});
```

## Sequential Execution

Git operations can interfere with each other when run in parallel. Use `describe.sequential` for git-heavy tests:

```typescript
import { describe } from "vitest";

describe.sequential("Git Operations", () => {
  // Tests run one at a time
  it("test 1", () => { /* ... */ });
  it("test 2", () => { /* ... */ });
});
```

## Skipping Tests in Coverage Mode

Some tests should skip in coverage mode to avoid interference:

```typescript
import { isCoverageMode, isVerificationMode } from "./helpers.js";

const describeGit = isCoverageMode() || isVerificationMode()
  ? describe.skip
  : describe.sequential;

describeGit("Git Tests", () => {
  // Only runs in normal test mode
});
```

## Fixture Types

### `GitRepoFixture`

```typescript
interface GitRepoFixture {
  path: string;           // Absolute path to repo
  defaultBranch: string;  // Branch name (main/master)
  cleanup: () => void;    // Remove repo
}
```

### `UndercityProjectFixture`

```typescript
interface UndercityProjectFixture {
  path: string;           // Project root
  defaultBranch: string;  // Git branch
  undercityDir: string;   // .undercity path
  tasksFile: string;      // tasks.json path
  cleanup: () => void;    // Remove project
}
```

## Best Practices

### 1. Always Clean Up Resources

```typescript
afterAll(() => {
  fixture.cleanup(); // REQUIRED - prevents disk pollution
});
```

### 2. Use Fixtures Over Manual Setup

```typescript
// BAD: Manual setup
const dir = mkdtempSync("/tmp/test-");
execSync("git init", { cwd: dir });
// ... forget to cleanup

// GOOD: Use fixture
const repo = createTempGitRepo();
// ... automatic cleanup
repo.cleanup();
```

### 3. Isolate Tests

Each test should start with a clean state. Don't reuse fixtures across tests unless necessary.

### 4. Test One Thing

Keep integration tests focused. If testing CLI output, don't also test git operations.

### 5. Use Type-Safe Helpers

```typescript
// BAD: Raw shell commands
execSync(`git commit -m "${userInput}"`, { cwd });

// GOOD: Type-safe helper
createGitCommit(repoPath, userInput);
```

### 6. Handle Failures Gracefully

```typescript
try {
  const result = executeCli(["command"], { shouldFail: true });
  expect(result.success).toBe(false);
} catch (error) {
  // Expected failure
}
```

## Performance Considerations

Integration tests are slower than unit tests:

- **Temp directory creation**: ~5-10ms
- **Git init + commit**: ~50-100ms
- **CLI execution**: ~100-500ms
- **Worktree operations**: ~200-1000ms

Keep test suites focused and use `describe.sequential` only when necessary.

## Troubleshooting

### "ENOENT: no such file or directory"

**Cause**: Fixture cleanup happened before test finished.

**Fix**: Ensure `cleanup()` is in `afterAll`, not `afterEach`.

### "fatal: not a git repository"

**Cause**: Working directory not set correctly.

**Fix**: Use `cwd` option in all CLI/git operations:

```typescript
executeCli(["command"], { cwd: repo.path });
```

### Tests hang indefinitely

**Cause**: Async operation not awaited or no timeout.

**Fix**: Always await async helpers and set timeouts:

```typescript
await waitFor(() => condition(), { timeout: 5000 });
```

### "worktree already exists"

**Cause**: Previous test didn't clean up worktrees.

**Fix**: Use `afterEach` to clean up per-test state:

```typescript
afterEach(() => {
  // Clean up worktrees
});
```

## Examples

See existing integration tests for complete examples:

- **`cli-smoke.test.ts`** - CLI command execution patterns
- **`worktree-manager.test.ts`** - Git worktree operations
- **`merge-queue.test.ts`** - Serial merge queue testing
- **`grind-flow.test.ts`** - End-to-end workflow testing

## Contributing

When adding new integration tests:

1. Use fixtures from `fixtures.ts` when possible
2. Add new helpers to `helpers.ts` for reusable operations
3. Document complex test setups
4. Use `describe.sequential` for git operations
5. Always clean up resources in `afterAll`
6. Consider skipping in coverage mode for expensive tests
