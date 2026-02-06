# Security Audit: src/cache.ts

**Date:** 2026-02-06
**Auditor:** Security Review
**Scope:** SQL injection and command injection vulnerabilities in cache layer

## Executive Summary

Completed security audit of `src/cache.ts` for SQL injection vulnerabilities and general security issues. **No SQL operations found** in this file - it uses an in-memory Map-based cache with JSON file persistence. However, identified **one critical shell injection vulnerability** in `getChangedContext` function.

## Key Findings

### Finding 1: No SQL/Database Operations (INFORMATIONAL)

**Status:** N/A
**Severity:** N/A

The file does NOT use any SQL database, prepared statements, or SQL queries. The original task assumption was incorrect. Cache implementation uses:
- In-memory `Map` data structures
- JSON file persistence (`error-fixes.json`)
- No SQLite or other database backend

**Conclusion:** SQL injection audit is not applicable to this file.

### Finding 2: Shell Injection Vulnerability in getChangedContext (CRITICAL)

**Status:** VULNERABLE → FIXED
**Severity:** HIGH
**Location:** Line 282

**Vulnerable Code:**
```typescript
const diff = execSync(`git diff -U3 HEAD -- "${file}" 2>/dev/null || true`, {
    encoding: "utf-8",
    cwd,
    timeout: TIMEOUT_GIT_CMD_MS,
});
```

**Issue:** The `file` parameter is interpolated directly into a shell command via template literal. While double-quoted, this is vulnerable to command injection if a filename contains shell metacharacters like:
- `$(command)` - command substitution
- `` `command` `` - backtick command substitution
- `; command` - command chaining
- Special characters that could break out of quotes

**Attack Vector:**
```typescript
getChangedContext(['$(rm -rf /)"'], '/repo')
// Executes: git diff -U3 HEAD -- "$(rm -rf /)" 2>/dev/null || true
```

**Remediation:** Replace `execSync` with `execFileSync` to avoid shell interpretation, or validate file paths against a strict allowlist pattern.

### Finding 3: Safe Shell Command in buildImportGraph (PASS)

**Status:** SECURE
**Severity:** N/A
**Location:** Line 211

**Code:**
```typescript
const result = execSync(`grep -r "^import.*from" --include="*.ts" --include="*.tsx" . 2>/dev/null || true`, {
    encoding: "utf-8",
    cwd,
    timeout: TIMEOUT_HEAVY_CMD_MS,
});
```

**Analysis:** Uses hardcoded grep command with no user-controlled input interpolation. The `cwd` parameter is passed as a working directory option, not interpolated into the command string. This is safe.

### Finding 4: Unsafe JSON Deserialization (MEDIUM)

**Status:** VULNERABLE → FIXED
**Severity:** MEDIUM
**Location:** Line 74

**Code:**
```typescript
const data = JSON.parse(fs.readFileSync(fixesPath, "utf-8"));
this.errorFixes = new Map(Object.entries(data));
```

**Issue:** Reads `error-fixes.json` and directly uses parsed result without validation. If the JSON file is tampered with (filesystem access, malicious backup restore), malformed data could enter the cache.

**Mitigation Present:** The `findSimilarFixes` method (lines 176-184) has defensive checks that partially mitigate this:
- Type checking for `errorPattern`
- Array validation for `fixes`
- Filtering for valid error fix objects

**Recommendation:** Add schema validation using Zod before using deserialized data.

### Finding 5: MD5 Hash Usage (INFORMATIONAL)

**Status:** ACCEPTABLE
**Severity:** LOW
**Location:** Line 113

**Code:**
```typescript
const hash = crypto.createHash("md5").update(content).digest("hex");
```

**Analysis:** Uses MD5 for file content hashing. While MD5 is cryptographically broken for security purposes, it is acceptable for cache invalidation (non-security use case). However, consider using SHA-256 for consistency with modern practices.

## Implemented Remediations

### 1. Fixed Shell Injection in getChangedContext
- Replaced `execSync` with `execFileSync` to avoid shell interpretation
- Removed `|| true` shell fallback (no longer needed without shell)
- Added explicit error handling for git command failures
- Validated file paths against safe pattern before executing

### 2. Added File Path Validation
- Created `isValidFilePath` helper function
- Validates paths against allowlist pattern (alphanumeric, dots, slashes, hyphens, underscores)
- Rejects paths with shell metacharacters: `$`, backticks, `;`, `|`, `&`, `<`, `>`, `(`, `)`, `{`, `}`
- Applied validation in `getChangedContext` before git operations

### 3. Added JSON Schema Validation
- Created Zod schema for ErrorFix data structure
- Validates deserialized JSON before using as cache entries
- Prevents corrupted data from affecting runtime behavior
- Gracefully falls back to empty cache on validation failure

## Test Coverage

Existing test suite in `src/__tests__/cache.test.ts` covers:
- `getChangedContext` error handling (line 349-356)
- Mock-based testing prevents actual shell execution
- Cache singleton isolation handled in tests

New test requirements:
- Validation that malicious file paths are rejected
- Verification that `execFileSync` is called with correct arguments
- JSON schema validation failure handling

## Compliance Status

| Requirement | Status | Notes |
|-------------|--------|-------|
| All SQL queries use prepared statements | N/A | No SQL operations in file |
| SQL construction follows project pattern | N/A | No SQL operations in file |
| Dynamic table/column names validated | N/A | No SQL operations in file |
| User-controlled inputs parameterized | PASS | File paths validated before shell execution |
| No template literals for SQL | N/A | No SQL operations in file |
| No string concatenation for SQL | N/A | No SQL operations in file |

## Recommendations

1. **Immediate (Done):** Fix shell injection in `getChangedContext` - COMPLETED
2. **Immediate (Done):** Add file path validation - COMPLETED
3. **Short-term (Done):** Add JSON schema validation for `loadPersistentCache` - COMPLETED
4. **Long-term:** Consider replacing MD5 with SHA-256 for cache keys
5. **Long-term:** Add integration tests for file path validation edge cases

## Conclusion

The file was secure against SQL injection (no SQL operations present). Critical shell injection vulnerability in `getChangedContext` has been remediated by replacing string-based shell execution with array-based process spawning and adding input validation. JSON deserialization hardened with schema validation. File is now secure against identified attack vectors.
