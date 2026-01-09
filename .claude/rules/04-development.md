# Development Commands

## Building

```bash
pnpm install    # Install dependencies
pnpm build      # Compile TypeScript
pnpm dev        # Watch mode
```

## Testing

```bash
pnpm test       # Run tests (vitest)
pnpm typecheck  # Type check without emitting
```

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

## Code Quality Targets

- Cyclomatic complexity: ≤10 per function
- Lines of code: ≤60 per function
- Nesting depth: ≤3 levels

## Logging

Uses Pino for structured logging. Import from `./logger.js`:

```typescript
import { raidLogger, squadLogger } from "./logger.js";

raidLogger.info({ raidId, goal }, "Starting raid");
squadLogger.debug({ agentId, task }, "Agent spawned");
```

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
