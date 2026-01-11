# Development Commands

## Building

```bash
pnpm install    # Install dependencies
pnpm build      # Compile TypeScript
pnpm dev        # Watch mode
```

## Testing

```bash
pnpm test            # Run tests (vitest)
pnpm test:coverage   # Run tests with coverage report
pnpm typecheck       # Type check without emitting
```

Coverage reports:
- Text summary: displayed in terminal
- HTML report: `coverage/index.html`
- JSON summary: `coverage/coverage-summary.json`

Pre-commit hook runs tests with coverage automatically.

## Format & Lint

```bash
pnpm format      # Check formatting
pnpm format:fix  # Fix formatting
pnpm lint        # Lint only
pnpm lint:fix    # Lint with auto-fixes
pnpm check       # Format + lint
pnpm check:fix   # All of the above with fixes
```

Uses Biome. Configuration in `biome.json`.

## Dependency Management

```bash
pnpm syncpack:lint  # Check dependency version consistency
pnpm syncpack:fix   # Fix version mismatches
```

## Code Quality (CodeScene)

```bash
pnpm quality:check   # Fast local check (staged files)
pnpm codescene:pr    # PR analysis vs main branch
cs check <file>      # Check specific file health
```

## Running

```bash
# Via global link (if set up)
undercity slingshot "goal"

# Directly
node ./bin/undercity.js slingshot "goal"

# Or via pnpm
pnpm start slingshot "goal"
```

## PM2 Daemon

```bash
pnpm daemon:start    # Start undercity daemon
pnpm daemon:stop     # Stop daemon
pnpm daemon:restart  # Restart daemon
pnpm daemon:status   # Check daemon status
pnpm daemon:logs     # View daemon logs
pnpm daemon:kill     # Kill PM2 entirely
```

PM2 config in `ecosystem.config.cjs`.

## State Cleanup

```bash
pnpm cleanup         # Clean stale state files before fresh grind
```

Clears:
- Stale recovery state (parallel-recovery.json)
- File tracking entries (file-tracking.json)
- Worktree state (worktree-state.json)
- Grind progress (grind-progress.json)
- Optionally archives large event logs

Creates timestamped backups before cleaning. Run before starting a fresh grind to prevent stale state interference.

## Semantic Density Analysis

```bash
pnpm semantic-check        # Analyze semantic density (JSON output)
pnpm semantic-check:fix    # Auto-fix issues
```

Measures facts per 1000 tokens across code and docs. See `.claude/rules/06-semantic-density.md` for details.

## Code Quality Targets

- Cyclomatic complexity: ≤10 per function
- Lines of code: ≤60 per function
- Nesting depth: ≤3 levels

## Logging

Uses Pino for structured logging. Import from `./logger.js`:

```typescript
import { sessionLogger, agentLogger, gitLogger } from "./logger.js";

sessionLogger.info({ sessionId, goal }, "Starting execution");
agentLogger.debug({ agentId, task }, "Worker spawned");
gitLogger.info({ branch }, "Creating worktree");
```

Available loggers: `sessionLogger`, `agentLogger`, `gitLogger`, `persistenceLogger`, `cacheLogger`, `serverLogger`

Set `LOG_LEVEL` environment variable to control verbosity (debug, info, warn, error).

## Path Navigation

When working with this codebase:
- Source files are in `src/`
- Compiled output goes to `dist/`
- CLI entry point is `bin/undercity.js`
- Runtime state stored in `.undercity/` (gitignored)

**Always run from repository root:**
```bash
# GOOD
pnpm build
pnpm test

# BAD
cd src && tsc
```
