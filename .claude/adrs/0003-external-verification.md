# ADR-0003: External Verification Loop

## Status
Accepted

## Context
After an agent completes a task, we need to know if the code actually works. Two approaches:
1. **Self-verification**: tell the agent to run typecheck/test/lint and report results
2. **External verification**: run verification outside the agent loop, independently

Self-verification is unreliable: agents can hallucinate success, skip checks, or report partial results. It also wastes tokens on tool calls the orchestrator can run directly.

## Decision
Verification runs externally via `verifyWork()` after the agent loop completes. The agent prompt does NOT instruct the agent to run typecheck/test/lint. Verification results drive retry/escalation decisions. Agent claims of "already complete" are verified externally before being trusted.

## Consequences
**Benefits:**
- Deterministic: same verification runs every time, no agent discretion
- Token-efficient: no agent turns spent on running/interpreting build output
- Trustworthy: agent cannot bypass or misreport verification results
- Drives escalation: failed verification triggers model upgrade decisions

**Tradeoffs:**
- Agent cannot proactively fix issues it discovers during coding (must wait for external check)
- Extra latency: full verification suite runs after each agent attempt

**What breaks if violated:**
- Agents claim "tests pass" without running them (observed in practice)
- Silent failures merge to main because agent reported success
- Token waste on agent-side verification that gets re-run externally anyway

## Code Locations
- `src/verification.ts` - `verifyWork()` function (typecheck + lint + tests in parallel)
- `src/worker.ts:1571` - External verification call after agent loop
- `src/worker.ts:1363` - Verification of "already complete" claims
- `src/worker/verification-handler.ts` - Result handling, retry decisions
