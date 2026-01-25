# Influences

Projects and concepts that shaped undercity's design. Links preserved for reference.

## Projects

### Gas Town (Steve Yegge)

**Link:** https://github.com/steveyegge/gastown

**What it is:** Multi-agent autonomous orchestration system. Agents coordinate as a "town" with a Mayor directing work to Rigs (workers).

**Concepts borrowed:**
- Parallel agent execution with coordination
- Task decomposition into atomic units
- Worktree isolation for concurrent work
- Model tiering (cheap models for simple work, expensive for complex)

**Where implemented:**
- `orchestrator.ts` - Parallel execution, task routing
- `worktree-manager.ts` - Git worktree isolation
- `complexity.ts` - Model tier selection

---

### Rule of Five (Jeffrey Emanuel)

**Link:** Cited in [Six New Tips for Better Coding With Agents](https://steve-yegge.medium.com/six-new-tips-for-better-coding-with-agents-d4e9c86e42a9)

**What it is:** "When in doubt, have the agent review its own work 5 times." Multiple review passes catch errors that single-pass execution misses.

**Concepts borrowed:**
- Multi-pass review (sonnet → opus review chain)
- Review convergence (each tier reviews until no issues found)
- 2-3 passes on small tasks, 4-5 on big tasks

**Where implemented:**
- `review.ts` - ReviewManager with escalating review tiers
- `annealing-review.ts` - Simulated annealing for review temperature
- `DECISIONS.md:268-285` - Review chain documentation

---

### Zeroshot

**Link:** https://github.com/covibes/zeroshot

**What it is:** Multi-agent code orchestration with specialized roles (planners, implementers, validators). Blind validation prevents confirmation bias - validators review without seeing implementer's reasoning.

**Concepts borrowed:**
- Team composition by complexity level
- Blind validation (validators check work without prior context)
- Complexity-driven scaling (typo = 1 agent, critical = 7 agents)
- Trivial: single agent, no validation
- Simple: worker + 1 validator
- Standard: planner + worker + 2 validators
- Critical: planner + worker + 5 specialized validators
- Isolation via git worktrees
- Crash recovery through persistence

**Where implemented:**
- `complexity.ts:414-440` - `getTeamComposition()`
- `DECISIONS.md:270-282` - Team composition documentation

---

### multiclaude (dlorenc)

**Link:** https://github.com/dlorenc/multiclaude

**What it is:** Multi-Claude coordination system with emergency handling and retry loop detection.

**Concepts borrowed:**
- Human input tracking to break retry loops
- Emergency fix mode when main branch CI fails
- Docker-style naming (adjective-animal) for workers

**Where implemented:**
- `human-input-tracking.ts` - Detect stuck workers, request human input
- `emergency-mode.ts` - Halt merges on CI failure, emergency fix flow
- `names.ts` - `generateWorkerName()` for memorable identifiers

---

### claude-mem (thedotmack)

**Link:** https://github.com/thedotmack/claude-mem

**What it is:** Claude Code plugin for persistent memory across sessions. Captures observations, compresses with AI, injects relevant context into future sessions.

**Concepts borrowed:**
- Knowledge persistence across sessions
- Semantic search for relevant learnings
- Progressive disclosure (index → details) for token efficiency
- Learning from task completions

**Where implemented:**
- `knowledge.ts` - Knowledge base storage and retrieval
- `knowledge-extractor.ts` - Extract learnings from completed tasks
- `embeddings.ts` - Vector embeddings for semantic search
- `task-file-patterns.ts` - Task→file correlations

---

### Ralph Wiggum Loop

**Link:** https://github.com/anthropics/claude-code/blob/main/plugins/ralph-wiggum/README.md

**What it is:** Claude Code plugin implementing iterative, self-referential development loops. "Ralph is a Bash loop" - a `while true` that repeatedly feeds Claude the same prompt, letting it see its own past work through files and git history. Iteration > perfection.

**Concepts borrowed:**
- Self-referential feedback (agent sees its own past work)
- Iteration until completion criteria met
- "Signs for Ralph" - warnings injected into prompts about past failures
- Loop detection: same error 3+ times = fail fast (the anti-pattern to avoid)
- RULES injection (imperative directives from error patterns)
- Clear completion criteria for autonomous work

**Where implemented:**
- `worker.ts:439-442` - Error history tracking
- `worker.ts:2720` - Loop detection in escalation logic
- `error-fix-patterns.ts:691-695` - "Signs for Ralph" failure warnings
- `error-fix-patterns.ts:854-857` - `formatPatternsAsRules()`
- `orchestrator.ts:205-211, 2065-2068` - Opus budget enforcement
- `src/worker/escalation-logic.ts:37-54` - `checkRepeatedErrorLoop()`

---

### Agent-Native Architecture (Dan Shipper / Every)

**Link:** https://every.to/guides/agent-native

**What it is:** Framework for building apps where AI agents are first-class citizens. "Features are outcomes achieved by an agent operating in a loop." Five principles: Parity, Granularity, Composability, Emergent Capability, Improvement Over Time.

**Concepts borrowed:**
- Agents in loops achieving outcomes (not predetermined workflows)
- Atomic tools composed with judgment (granularity)
- Context injection (give agents visibility into resources)
- Explicit completion signals (don't guess when done)
- Observable progress (real-time visibility into agent actions)
- Improvement through context/prompt refinement, not code changes

**Where implemented:**
- `worker.ts` - Agent loop with tool composition
- `context.ts`, `knowledge.ts` - Context injection
- `verification.ts` - Explicit completion signals (tests pass = done)
- `dashboard.ts`, `grind-events.ts` - Observable progress
- `output.ts` - Real-time agent action visibility

---

### BMAD-METHOD

**Link:** https://github.com/bmad-code-org/BMAD-METHOD

**What it is:** Iterative, planning-first execution strategy. Plan before executing, iterate on plans.

**Concepts borrowed:**
- Pre-execution planning phase
- Plan review before implementation
- Iterative refinement

**Where implemented:**
- `task-planner.ts` - `planTaskWithReview()`
- `worker.ts` - Planning phase before execution

---

### DSPy / Ax

**Link:** https://axllm.dev/dspy/

**What it is:** Framework replacing manual prompt engineering with signatures (input/output declarations). Ax is the TypeScript implementation. Self-improving through examples - "train your programs with examples, watch them improve automatically."

**Concepts borrowed:**
- Signature-based prompts (declare inputs/outputs, not instructions)
- Automatic optimization through example collection
- Training data from successful task completions
- Built-in assertions for output validation
- Multi-step reasoning with chained operations

**Where implemented:**
- `ax-programs.ts` - Training data collection, outcome recording
- `ax-training.json` - Stored examples for self-improvement
- `recordComplexityOutcome()`, `recordPlanCreationOutcome()`, etc.

---

### "What Used to Take Months Now Takes Days" (Obie Fernandez)

**Link:** https://obie.medium.com/what-used-to-take-months-now-takes-days-cc8883cc21e9

**What it is:** Case study of building a production knowledge management system (Nexus) in 4 days with Claude Code. Demonstrates TDD as a forcing function in AI-assisted development and the strategic calculus of competitive advantage when replication barriers collapse.

**Why included:**
- Validates that substantial production systems can be built rapidly with AI assistance
- Articulates why TDD matters more, not less, with AI code generation

---

## Quick Reference

| Influence | Key Concept | Primary Files |
|-----------|-------------|---------------|
| Gas Town | Parallel multi-agent orchestration | `orchestrator.ts`, `worktree-manager.ts` |
| Rule of Five | Multi-pass review (5 reviews) | `review.ts`, `annealing-review.ts` |
| Zeroshot | Team sizing by complexity | `complexity.ts` |
| multiclaude | Emergency handling, retry breaking | `emergency-mode.ts`, `human-input-tracking.ts` |
| claude-mem | Persistent knowledge across sessions | `knowledge.ts`, `embeddings.ts` |
| Ralph Wiggum | Iterative loops, failure learning | `worker.ts`, `error-fix-patterns.ts` |
| Agent-Native | Outcomes via loops, context injection | `worker.ts`, `context.ts`, `dashboard.ts` |
| BMAD-METHOD | Planning-first execution | `task-planner.ts` |
| DSPy/Ax | Self-improving prompts via examples | `ax-programs.ts` |
| Obie Fernandez | TDD as forcing function, rapid AI dev | (validation) |
