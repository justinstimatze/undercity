/**
 * Shared constants used across the codebase.
 *
 * Centralizes magic numbers so they can be tuned in one place
 * and carry semantic meaning at every call site.
 */

// ---------------------------------------------------------------------------
// Shell command timeouts (milliseconds)
// ---------------------------------------------------------------------------

/** Quick tool-exists check (e.g. `which ast-grep`) */
export const TIMEOUT_TOOL_CHECK_MS = 1_000;

/** File search / git ls-files / git grep for names */
export const TIMEOUT_FILE_SEARCH_MS = 3_000;

/** Standard git operations: grep, diff, rev-parse, ls-files */
export const TIMEOUT_GIT_CMD_MS = 5_000;

/** Heavier operations: patch apply, large grep, element wait */
export const TIMEOUT_HEAVY_CMD_MS = 10_000;

/** Lint/fix, security scan, spell check, ast-grep rewrite */
export const TIMEOUT_LINT_FIX_MS = 30_000;

/** Build, typecheck, lint (full project) */
export const TIMEOUT_BUILD_STEP_MS = 60_000;

/** Full test suite */
export const TIMEOUT_TEST_SUITE_MS = 120_000;

// ---------------------------------------------------------------------------
// Browser automation timeouts (milliseconds)
// ---------------------------------------------------------------------------

/** Page navigation / load */
export const TIMEOUT_PAGE_LOAD_MS = 60_000;

/** Waiting for a specific DOM element */
export const TIMEOUT_ELEMENT_WAIT_MS = 10_000;

// ---------------------------------------------------------------------------
// Agent SDK max turns
// ---------------------------------------------------------------------------

/** Single response, no tool use (classification, extraction, JSON gen) */
export const MAX_TURNS_SINGLE = 1;

/** Review pass with potential fixes */
export const MAX_TURNS_REVIEW = 5;

/** Planning / decision-making with tool use */
export const MAX_TURNS_PLANNING = 10;

/** Complex planning requiring extended exploration */
export const MAX_TURNS_EXTENDED_PLANNING = 15;
