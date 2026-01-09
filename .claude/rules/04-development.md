# Development Commands

## Building

```bash
pnpm install    # Install dependencies
pnpm build      # Compile TypeScript
pnpm dev        # Watch mode
```

## Testing

```bash
pnpm test       # Run tests
pnpm typecheck  # Type check without emitting
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

## Code Quality

**Always run from repository root:**
```bash
# GOOD
pnpm build
pnpm test

# BAD
cd src && tsc
```

## Path Navigation

When working with this codebase:
- Source files are in `src/`
- Compiled output goes to `dist/`
- CLI entry point is `bin/undercity.js`
- Runtime state stored in `.undercity/` (gitignored)
