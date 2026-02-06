# ADR-0007: Three-State Error Learning

## Status
Accepted

## Context
When verification fails, the system retries with feedback. We need to learn from both successful fixes and permanent failures to improve future attempts. A simple pass/fail model loses the temporal dimension: was the error fixed on retry, or did it persist across all attempts?

## Decision
Error-fix patterns follow a three-state lifecycle:
1. **Pending**: `recordPendingError()` - verification failed, fix not yet attempted
2. **Successful fix**: `recordSuccessfulFix()` - error was fixed, patch recorded for reuse
3. **Permanent failure**: `recordPermanentFailure()` - max retries exhausted, error persists

Transitions are one-way: pending -> success OR pending -> permanent. A successful fix stores the diff/patch so future occurrences of the same error signature can receive auto-remediation hints.

## Consequences
**Benefits:**
- Successful fixes become reusable knowledge (error signature -> fix pattern)
- Permanent failures prevent wasting retries on known-unfixable errors
- `getFailureWarningsForTask()` can warn workers about errors that previously failed permanently
- Fix patterns accumulate over time, improving first-attempt success rates

**Tradeoffs:**
- Error signature matching is heuristic (normalized message + category)
- Stale fix patterns may suggest outdated fixes after codebase changes
- Pending errors from crashed tasks need cleanup (handled by `pruneOldPendingErrorsDB`)

**What breaks if violated:**
- Without pending state: can't correlate a verification failure with its eventual fix
- Without fix recording: same error types require rediscovery every time
- Without permanent failure tracking: workers waste retries on errors that never succeed

## Code Locations
- `src/error-fix-patterns.ts:292` - `recordPendingError()` (state 1)
- `src/error-fix-patterns.ts:367` - `recordSuccessfulFix()` (state 2)
- `src/error-fix-patterns.ts:457` - `recordPermanentFailure()` (state 3)
- `src/worker/verification-handler.ts` - Calls `recordPendingError` on failure
- `src/worker.ts` - Calls `recordSuccessfulFix` after recovery, `recordPermanentFailure` on exhaust
