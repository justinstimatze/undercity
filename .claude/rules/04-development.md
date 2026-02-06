# Development Commands

## Build, Test, Lint

```bash
pnpm build           # Compile TypeScript
pnpm dev             # Watch mode
pnpm test            # Run tests (vitest)
pnpm test:coverage   # Tests with coverage
pnpm typecheck       # Type check without emitting
pnpm check:fix       # Format + lint with auto-fixes (Biome)
pnpm arch:check      # Architecture boundary verification (dependency-cruiser)
```

## Dependency Management

```bash
pnpm syncpack:lint   # Check version consistency
pnpm syncpack:fix    # Fix version mismatches
```

**Before removing a dependency**, run `pnpm why <package-name>`. If it's a peer dependency, do not remove it.

## Security Scanning

```bash
pnpm security        # Pre-commit scan (gitleaks + semgrep)
pnpm security:full   # Full codebase scan
```

Required tools: gitleaks (secrets), semgrep (static analysis). Pre-commit hook runs both.

## Git & CI

```bash
pnpm push            # Push and watch CI, auto-add fix task on failure
```

Always use `pnpm push` instead of `git push`.

## Running

```bash
undercity grind                     # Process task board
undercity grind "goal"              # Single task
node ./bin/undercity.js grind "goal"  # Direct
```

## State Cleanup

```bash
pnpm cleanup         # Clean stale state files before fresh grind
```

Clears recovery state, file tracking, worktree state. Creates timestamped backups.

## Logging

Uses Pino. Import from `./logger.js`. Available: `sessionLogger`, `agentLogger`, `gitLogger`, `persistenceLogger`, `cacheLogger`, `serverLogger`. Set `LOG_LEVEL` env var.

## Path Navigation

- Source: `src/`
- Compiled: `dist/`
- CLI: `bin/undercity.js`
- State: `.undercity/` (gitignored)
- Always run from repository root
