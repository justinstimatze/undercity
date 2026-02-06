# ADR-0006: Review Tier Capping by Complexity

## Status
Accepted

## Context
After verification passes, code review catches issues that automated checks miss (logic bugs, naming, edge cases). Review escalates through model tiers: sonnet, sonnet, opus. Running opus review on every task wastes tokens - most tasks are simple and don't benefit from opus-level review.

## Decision
Cap the maximum review tier based on task complexity assessment:
- **Trivial/simple/standard tasks**: review capped at sonnet (2 passes max)
- **Complex/critical tasks**: full escalation up to opus (3 passes + focused multi-lens review)

The `maxReviewTier` parameter filters the tier array: `allTiers.slice(0, maxTierIndex + 1)`.

## Consequences
**Benefits:**
- Significant token savings: opus review costs ~10x sonnet, most tasks don't need it
- Simple tasks complete faster (fewer review passes)
- Complex tasks still get thorough opus-level scrutiny

**Tradeoffs:**
- Simple tasks may occasionally miss issues that opus would catch
- Complexity assessment must be accurate (false "simple" on a complex task = less review)

**What breaks if violated:**
- Running opus review on all tasks: token budget exhausted 3-5x faster
- No review at all: logic bugs, naming issues, and edge cases merge uncaught
- No tier capping: overnight runs consume entire daily token budget on reviews

## Code Locations
- `src/review.ts:110-113` - Tier filtering by `maxReviewTier`
- `src/worker.ts` - `determineReviewLevel()` sets `maxReviewTier` based on complexity
