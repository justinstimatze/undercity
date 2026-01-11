# Undercity

Multi-agent task orchestrator for Claude. Parallel execution in isolated git worktrees.

## Installation

```bash
git clone https://github.com/anthropics/undercity.git
cd undercity
pnpm install && pnpm build
ln -sf $(pwd)/bin/undercity.js ~/.local/bin/undercity
```

Requires Node.js 24+ and `ANTHROPIC_API_KEY`.

## Commands

```bash
undercity init                     # Initialize in repo
undercity add "task description"   # Add task to board
undercity tasks                    # Show task board
undercity grind                    # Process tasks (serial)
undercity grind --parallel 3       # 3 tasks concurrently
undercity grind -n 5               # Process 5 tasks then stop
undercity limits                   # Show API usage
undercity watch                    # Live TUI dashboard
```

## Configuration

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Optional: Create `.undercityrc` for defaults (see `.claude/rules/` for config options).

## License

MIT
