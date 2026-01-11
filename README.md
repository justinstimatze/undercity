# Undercity

## Overview

**Purpose**: Multi-agent task orchestrator for autonomous task execution

### Key Capabilities

| Capability | Description |
|------------|-------------|
| Parallel Execution | Run tasks concurrently in isolated git worktrees |
| Task Management | Add, track, and process tasks with intelligent routing |
| Model-Adaptive Execution | Route tasks to appropriate AI model tier |
| Crash Recovery | Auto-resume interrupted task batches |

## Prerequisites

| Requirement | Details |
|-------------|---------|
| Runtime | Node.js 24+ |
| Authentication | `ANTHROPIC_API_KEY` required |
| Package Manager | pnpm |

## Installation

```bash
git clone https://github.com/anthropics/undercity.git
cd undercity
pnpm install && pnpm build
ln -sf $(pwd)/bin/undercity.js ~/.local/bin/undercity
```

## Commands

### Task Management

| Command | Behavior | Example |
|---------|----------|---------|
| `undercity add` | Add task to board | `undercity add "Implement user auth"` |
| `undercity tasks` | List tasks | `undercity tasks` |
| `undercity tasks pending` | Show pending tasks | `undercity tasks pending` |

### Execution Modes

| Command | Behavior | Example |
|---------|----------|---------|
| `undercity grind` | Process all pending tasks serially | `undercity grind` |
| `undercity grind --parallel N` | Process N tasks concurrently | `undercity grind --parallel 3` |
| `undercity grind -n N` | Process N tasks then stop | `undercity grind -n 5` |

### Monitoring & Metrics

| Command | Behavior | Example |
|---------|----------|---------|
| `undercity limits` | Show API usage/rate limits | `undercity limits` |
| `undercity watch` | Launch live TUI dashboard | `undercity watch` |

## Configuration

### Environment Variables

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Config File

Optional: Create `.undercityrc` in project root

**Configuration Hierarchy** (highest to lowest priority):
1. CLI flags
2. `.undercityrc` (project)
3. `~/.undercityrc` (home)
4. Built-in defaults

## License

MIT