---
paths:
  - src/automated-pm.ts
  - src/worker/prompt-builder.ts
  - src/content-sanitizer.ts
  - src/task-security.ts
  - src/url-validator.ts
  - src/commands/**
---

# Security Patterns

Critical security patterns for this codebase.

## ReDoS Prevention

Avoid nested quantifiers in regex patterns that process untrusted input.

```typescript
// BAD: Polynomial backtracking
/(?:[\w.-]+\/)*[\w.-]+\.[\w]+/g

// GOOD: Split-based approach
const tokens = input.split(/\s+/);
for (const token of tokens) {
    if (/^[.\w~/-]+$/.test(token)) { /* process */ }
}
```

Warning signs: `(a+)+`, `(a|b)*`, `.*.*`, `(\w+)*` on untrusted input.

### File-Matching Regexes

Every regex matching file paths/filenames MUST use bounded quantifiers. Unbounded `[\w-]+` on task objectives triggers CodeQL `js/polynomial-redos`.

```typescript
// BAD: Unbounded
/[\w-]+\.(?:ts|js|json|md)/g

// GOOD: Bounded
/[\w-]{1,100}\.(?:ts|js|json|md)/g
```

Bounds: `{1,100}` filenames, `{1,200}` paths, `{1,20}` extensions.

## Command Injection Prevention

Use `execFileSync` over `execSync` for external commands:

```typescript
// BAD: Shell injection risk
execSync(`git commit -m "${userInput}"`);

// GOOD: No shell interpretation
execFileSync("git", ["commit", "-m", userInput]);
```

Validation functions should RETURN the validated value for static analyzer tracking:

```typescript
export function validateGitRef(ref: string): string {
    if (!/^[\w./-]+$/.test(ref)) {
        throw new Error(`Invalid git ref: ${ref}`);
    }
    return ref;
}
```

## URL Validation

Never use substring checks to validate URLs:

```typescript
// BAD: Bypassable
if (url.includes("example.com")) { ... }

// GOOD: Parse and check exact host
const host = new URL(url).host;
if (host === "example.com" || host.endsWith(".example.com")) { ... }
```

In tests: use exact URL match, not substring checks (CodeQL flags `js/incomplete-url-substring-sanitization`).

## Path Traversal Prevention

```typescript
function validatePath(basePath: string, userPath: string): string {
    const resolved = resolve(basePath, normalize(userPath));
    if (!resolved.startsWith(basePath)) {
        throw new Error("Path traversal detected");
    }
    return resolved;
}
```

## HTTP Error Responses

Never expose error details or stack traces to clients. Log details server-side, return generic messages.

## Security Scanning

```bash
pnpm security        # Pre-commit scan (gitleaks + semgrep)
pnpm security:full   # Full codebase scan
```

Required tools: gitleaks (secrets), semgrep (static analysis). Pre-commit hook runs both.
