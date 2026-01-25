# Undercity: Multi-Agent Autonomous Task Orchestrator

| Property | Value |
|----------|-------|
| Purpose | Multi-agent autonomous task orchestrator with learning |
| Runtime | Node.js 24+ |
| Auth | Claude Max OAuth (via Agent SDK) |
| Package Manager | pnpm |
| CLI Command | `undercity` |

## Core Capabilities

| Capability | Implementation | State File |
|------------|----------------|------------|
| Task Management | Priority queuing | `.undercity/tasks.json` |
| Parallel Execution | Isolated git worktrees | `.undercity/worktree-state.json` |
| Model Routing | Complexity-based + learned routing | `.undercity/routing-profile.json` |
| Crash Recovery | Auto-resume batch | `.undercity/parallel-recovery.json` |
| Rate Limiting | Exponential backoff | `.undercity/rate-limit-state.json` |
| Merge Pipeline | Serial git merge | In-memory (MergeQueue) |
| Knowledge Compounding | Learn from task completions | `.undercity/knowledge.json` |
| Decision Tracking | Capture/resolve agent decisions | `.undercity/decisions.json` |
| Pattern Learning | Task→file correlations | `.undercity/task-file-patterns.json` |
| Error Fix Learning | Error→fix patterns | `.undercity/error-fix-patterns.json` |

## Installation

### Prerequisites

| Requirement | Version | Check Command |
|-------------|---------|---------------|
| Node.js | 24+ | `node --version` |
| pnpm | 9+ | `pnpm --version` |
| Git | 2.20+ | `git --version` |
| gitleaks | Latest | `gitleaks version` |
| semgrep | Latest | `semgrep --version` |
| Claude Max subscription | Active | Required for OAuth |

**Security tools installation:**
```bash
# gitleaks (secrets detection)
sudo apt install gitleaks        # Debian/Ubuntu
# or: brew install gitleaks      # macOS

# semgrep (static analysis) - use pipx for isolated install
sudo apt install pipx && pipx install semgrep   # Debian/Ubuntu
# or: brew install semgrep                       # macOS
```

### For Humans (Manual Setup)

```bash
# 1. Clone and build
git clone https://github.com/justinstimatze/undercity.git
cd undercity
pnpm install
pnpm build

# 2. Add to PATH (choose one)
ln -sf $(pwd)/bin/undercity.js ~/.local/bin/undercity  # Linux
# OR add to shell profile:
echo 'export PATH="$PATH:/path/to/undercity/bin"' >> ~/.bashrc

# 3. Initialize in your project
cd /path/to/your/project
undercity init

# 4. Authenticate with Claude Max (one-time)
undercity usage --login
# This opens a browser for Claude.ai OAuth login

# 5. Verify installation
undercity --version
undercity tasks  # Should show empty task board
```

### For Claude Code (Agent Setup)

Undercity integrates with Claude Code via the `/undercity` skill. To enable:

```bash
# In your project directory, ensure undercity is in PATH
which undercity  # Should return path to undercity binary

# Initialize undercity state
undercity init

# Copy the skill file to your project (optional - enables /undercity command)
mkdir -p .claude/skills
cp /path/to/undercity/.claude/skills/undercity.md .claude/skills/
```

**Claude Code workflow:**
1. Add tasks: `undercity add "task description"`
2. Start autonomous execution: `undercity grind`
3. Monitor progress: `undercity watch` or `undercity pulse`
4. Check results: `undercity brief`

See [docs/claude-code-integration.md](docs/claude-code-integration.md) for detailed agent workflow.

### Quick Verification

```bash
# Test basic commands
undercity --help              # Show all commands
undercity tasks               # View task board (should be empty)
undercity add "Test task"     # Add a test task
undercity tasks               # Should show 1 pending task
undercity remove <task-id>    # Clean up test task
```

## Task Operations

| Command | Behavior | State Impact |
|---------|----------|--------------|
| `undercity add "task"` | Add task | Append to `tasks.json` |
| `undercity tasks` | List tasks | Read-only |
| `undercity tasks pending` | Show pending | Read-only |
| `undercity load <file>` | Bulk import | Append multiple tasks |

## Execution Modes

| Command | Parallelism | Recovery | Scope |
|---------|-------------|----------|-------|
| `undercity grind` | 1 task | Auto-resume | Task board |
| `undercity grind "goal"` | Single task | N/A | Direct execution |
| `undercity grind -n 5` | 1 task | Auto-resume | Max 5 tasks |
| `undercity grind --parallel 3` | 1-5 tasks | Auto-resume | Concurrent |

## Planning Commands

| Command | Input | Behavior |
|---------|-------|----------|
| `undercity import-plan <file>` | Markdown | Extract task steps |
| `undercity plan <file>` | Markdown | Execute with context |
| `undercity plan <file> -c` | Markdown | Continuous execution |

## Infrastructure Commands

| Command | Purpose |
|---------|---------|
| `undercity init` | Setup `.undercity/` |
| `undercity serve -p 7331` | Start HTTP daemon |
| `undercity daemon status` | Check daemon |
| `undercity setup` | Verify API key |

## Model Routing Strategy

| Complexity | Model | Use Cases | Token Cost |
|------------|-------|-----------|------------|
| Standard | sonnet | Most tasks: docs, features, refactoring | Medium |
| Critical | opus | Architecture, security, complex bugs | Highest |

## Verification Stages

| Stage | Command | Failure Handling |
|-------|---------|-----------------|
| Typecheck | `pnpm typecheck` | Fix → Escalate |
| Tests | `pnpm test` | Fix → Escalate |
| Lint | `pnpm lint` | Fix → Escalate |
| Build | `pnpm build` | Fix → Escalate |

## Escalation Path

| Step | Action |
|------|--------|
| 1 | Retry with same model |
| 2 | Escalate: sonnet → opus |
| 3 | Human notification |

## Configuration Precedence

| Source | Priority | Format | Example |
|--------|----------|--------|---------|
| CLI flags | Highest | `--flag value` | `--parallel 3` |
| `.undercityrc` (cwd) | 2 | JSON | `{"parallel": 3}` |
| `~/.undercityrc` | 3 | JSON | `{"model": "sonnet"}` |
| Built-in defaults | Lowest | Hardcoded | `parallel: 1` |

## Runtime Configuration

| Env Var | Required | Values |
|---------|----------|--------|
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error` |

Auth via Claude Max OAuth - run `undercity setup` to verify login status.

## Error Recovery Strategies

| Scenario | Detection | Action |
|----------|-----------|--------|
| Grind interruption | `recovery.json` exists | Auto-resume |
| Rate limit | 429 response | Pause + backoff |
| Git conflict | Pre-merge check | Manual resolve |
| Verification fail | Hook exit code | Fix → Escalate |
| Worktree leak | `git worktree list` | `git worktree prune` |

## Monitoring Commands

| Command | Purpose | Output |
|---------|---------|--------|
| `undercity limits` | Rate limit snapshot | Usage summary |
| `undercity watch` | Live TUI dashboard | Matrix-style visualization |
| `undercity status` | Grind session status | JSON (default) |
| `undercity pulse` | Quick state check | JSON: workers, queue, health |
| `undercity brief` | Narrative summary | JSON: accomplishments, failures, recommendations |
| `undercity usage` | Live Claude Max usage | JSON: fetches from claude.ai |
| `undercity metrics-dashboard` | Interactive TUI | Token usage, success rates, costs |

## Learning & Intelligence Commands

| Command | Purpose | Output |
|---------|---------|--------|
| `undercity knowledge <query>` | Search accumulated learnings | JSON: matching learnings |
| `undercity knowledge --stats` | Knowledge base statistics | JSON: counts, categories |
| `undercity decide` | View pending decisions | JSON: decisions needing resolution |
| `undercity decide --resolve <id>` | Resolve a decision | - |
| `undercity patterns` | Task→file correlations | Human: top keywords, files, risks |
| `undercity prime-patterns` | Seed patterns from git history | - |
| `undercity tuning` | View learned routing profile | Human: model thresholds |
| `undercity introspect` | Analyze own metrics | Human/JSON: success rates, patterns |
| `undercity decisions` | Decision tracking stats | Human: pending, resolved, overrides |
| `undercity ax` | Ax/DSPy training data stats | Human: example counts |

## Analysis Commands

| Command | Purpose | Output |
|---------|---------|--------|
| `undercity metrics` | Performance metrics | Human: success rate, tokens |
| `undercity complexity-metrics` | Success by complexity level | Human/JSON |
| `undercity enhanced-metrics` | Token usage + escalation | Human/JSON |
| `undercity escalation-patterns` | Escalation effectiveness | Human |
| `undercity insights` | Routing recommendations | Human/JSON |
| `undercity semantic-check` | Semantic density analysis | JSON |
| `undercity semantic-check --fix` | Auto-fix density issues | - |

## State Files

| File | Purpose | Tracked |
|------|---------|---------|
| `tasks.json` | Task board | Yes |
| `knowledge.json` | Accumulated learnings | No |
| `decisions.json` | Decision history | No |
| `task-file-patterns.json` | Task→file correlations | No |
| `error-fix-patterns.json` | Error→fix patterns | No |
| `routing-profile.json` | Learned model routing | No |
| `worktree-state.json` | Active worktrees | No |
| `parallel-recovery.json` | Crash recovery | No |
| `rate-limit-state.json` | Rate limit state | No |
| `live-metrics.json` | Token usage/cost | No |
| `grind-events.jsonl` | Event log | No |
| `ast-index.json` | Symbol/dependency index | No |
| `ax-training.json` | Ax/DSPy examples | No |

## Development Commands

| Command | Purpose |
|---------|---------|
| `pnpm build` | Compile TypeScript |
| `pnpm test` | Run tests |
| `pnpm lint` | Check code style |
| `pnpm typecheck` | Type check |
| `pnpm semantic-check` | Analyze semantic density |

## Learning Systems

### Knowledge Compounding

| Category | Extracted From | Injected When |
|----------|----------------|---------------|
| `pattern` | Code/architectural approaches | Similar task keywords match |
| `gotcha` | Pitfalls encountered | Keywords match |
| `preference` | Project conventions | Keywords match |
| `fact` | Codebase facts | Keywords match |

**Flow**: Task complete → Extract learnings → Store with keywords → Score by keyword overlap + confidence → Inject top 5 into future tasks

**Confidence**: Starts 0.5, +0.05 on successful reuse, -0.10 on failed reuse

### Decision Tracking

| Category | Handling | Example |
|----------|----------|---------|
| `auto_handle` | Execute immediately | Retries, lint fixes, rebases |
| `pm_decidable` | Automated PM decides | Scope, approach, priority |
| `human_required` | Escalate to user | Security, breaking changes |

**Flow**: Agent surfaces question → Classify by patterns → Route to handler → Record outcome for learning

### Pattern Learning

| Pattern Type | Source | Used For |
|--------------|--------|----------|
| Task→File | Completed tasks | Suggest relevant files for new tasks |
| Co-modification | Git history | "When file A changes, B usually needs updating" |
| Error→Fix | Failed verifications | Suggest fixes for known error patterns |

**Decay**: Patterns weight halves every 14 days of inactivity. Fresh patterns preferred over stale.

### Self-Tuning

Model routing thresholds learned from historical success rates:

```
undercity tuning           # View current profile
undercity tuning --rebuild # Rebuild from metrics
```

## Output Modes

| Context | Mode | Format |
|---------|------|--------|
| TTY (terminal) | human | Colored, formatted |
| Pipe (agent) | agent | Structured JSON |
| `--human` flag | human | Force human mode |
| `--agent` flag | agent | Force agent mode |

## Daemon Mode Commands

| Command | Purpose |
|---------|---------|
| `pnpm daemon:start` | Start daemon |
| `pnpm daemon:status` | Check status |
| `pnpm daemon:logs` | View logs |

## Daemon HTTP Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/status` | GET | Session/agent/task summary |
| `/tasks` | GET | Full task board |
| `/tasks` | POST | Add task `{"objective": "..."}` |
| `/metrics` | GET | Usage metrics |
| `/pause` | POST | Pause grind |
| `/resume` | POST | Resume grind |
| `/stop` | POST | Stop daemon |

## Rate Limit Management

| Command | Purpose |
|---------|---------|
| `undercity usage` | Fetch live Claude Max usage from claude.ai |
| `undercity usage --login` | One-time browser auth setup |
| `undercity limits` | Local rate limit state |

**Pacing**: Dynamic based on live usage queries. Auto-pauses when approaching limits, resumes when headroom available. Usage cached 5 minutes to avoid excessive scraping.