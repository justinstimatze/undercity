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

### Before Removing a Dependency

**CRITICAL**: A dependency may appear "unused" in source code but still be required:

1. **Peer dependencies** - Required by other packages (e.g., `@xenova/transformers` is needed by `embeddings.js`)
2. **Runtime dependencies** - Loaded dynamically or by other packages
3. **Build-time dependencies** - Used by tooling, not application code

**Before removing any dependency, run:**
```bash
pnpm why <package-name>  # Shows what depends on it
```

If `pnpm why` shows the package is a peer dependency of something we use, **do not remove it**.

**Example:**
```bash
$ pnpm why @xenova/transformers
@xenova/transformers 2.17.2
└── is peer of @themaximalist/embeddings.js 0.1.3  # <-- DON'T REMOVE
```

## Security Scanning

```bash
pnpm security        # Pre-commit security scan (gitleaks + semgrep)
pnpm security:full   # Full codebase scan
```

**Required tools** (commits blocked if missing):
- **gitleaks**: Secrets detection
- **semgrep**: Static security analysis (command injection, ReDoS, etc.)

```bash
# Debian/Ubuntu
sudo apt install gitleaks
sudo apt install pipx && pipx install semgrep

# macOS
brew install gitleaks semgrep
```

Pre-commit hook runs both tools automatically. Security is mandatory given undercity's autonomous execution model.

## Git & CI

```bash
pnpm push            # Push and watch CI, auto-add fix task on failure
git push             # Standard push (no CI monitoring)
```

`pnpm push` wraps `git push` to:
1. Push to remote
2. Watch CI status until completion
3. On failure: auto-add high-priority task to fix CI

Pre-commit hook applies all lint fixes (including "unsafe" ones like template literals).

## Code Quality (CodeScene)

```bash
pnpm quality:check   # Fast local check (staged files)
pnpm codescene:pr    # PR analysis vs main branch
cs check <file>      # Check specific file health
```

## Running

```bash
# Via global link (if set up)
undercity grind "goal"              # Single task
undercity grind                     # Process task board

# Directly
node ./bin/undercity.js grind "goal"

# Or via pnpm
pnpm start grind "goal"
```

## Monitoring & Learning

```bash
undercity pulse                     # Quick state check (JSON)
undercity brief                     # Narrative summary (JSON)
undercity usage                     # Live Claude Max usage
undercity usage --login             # One-time browser auth
undercity knowledge "query"         # Search learnings
undercity patterns                  # Task→file correlations
undercity tuning                    # View learned routing
undercity introspect                # Self-analysis
```

## Analysis

```bash
undercity metrics                   # Performance metrics
undercity complexity-metrics        # Success by complexity
undercity insights                  # Routing recommendations
undercity decisions                 # Decision tracking stats
undercity ax                        # Ax/DSPy training stats
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
