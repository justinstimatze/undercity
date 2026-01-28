# Security Patterns

Critical security patterns to prevent common vulnerabilities in this codebase.

## ReDoS Prevention

**CRITICAL**: Avoid nested quantifiers in regex patterns that process untrusted input.

```typescript
// BAD: Polynomial backtracking with nested quantifiers
/(?:[\w.-]+\/)*[\w.-]+\.[\w]+/g  // Can cause ReDoS

// GOOD: Split-based approach avoids regex backtracking
const tokens = input.split(/\s+/);
for (const token of tokens) {
    if (/^[.\w~/-]+$/.test(token)) {  // Simple character class, no backtracking
        // process token
    }
}

// GOOD: Limit quantifiers to prevent catastrophic backtracking
/[\w.-]{1,100}/  // Bounded repetition
```

**Warning signs (avoid these patterns on untrusted input):**
- `(a+)+` - nested quantifiers
- `(a|b)*` - alternation inside quantifier
- `.*.*` - overlapping greedy quantifiers
- `(\w+)*` - capturing group with quantifier

## Command Injection Prevention

**CRITICAL**: Use `execFileSync` over `execSync` for external commands.

```typescript
// BAD: Shell interpretation allows injection
execSync(`git commit -m "${userInput}"`);

// GOOD: execFileSync passes args directly, no shell
execFileSync("git", ["commit", "-m", userInput]);
```

**When using validated input with exec functions:**

```typescript
// Validation functions should RETURN the validated value
// This helps static analyzers track data flow sanitization
export function validateGitRef(ref: string): string {
    if (!/^[\w./-]+$/.test(ref)) {
        throw new Error(`Invalid git ref: ${ref}`);
    }
    return ref;  // Return validated value
}

// Use returned value to make sanitization explicit
const sanitizedRef = validateGitRef(userInput);
execFileSync("git", ["checkout", sanitizedRef]);
```

## Stack Trace Exposure Prevention

**CRITICAL**: Never expose error details or stack traces to HTTP clients.

```typescript
// BAD: Leaks internal error details
catch (err) {
    res.json({ error: err.message });  // Message might contain paths/traces
}

// GOOD: Generic error for clients, detailed logging server-side
catch (err) {
    logger.error({ err }, "Request failed");  // Full details in logs
    res.json({ error: "Internal server error" });  // Generic to client
}
```

**Exception**: Development mode can show detailed errors, but never in production.

## Prototype Pollution Prevention

**CRITICAL**: Use pnpm overrides for vulnerable transitive dependencies.

```json
{
  "pnpm": {
    "overrides": {
      "lodash": ">=4.17.21",
      "xml2js": ">=0.5.0"
    }
  }
}
```

**Check Dependabot alerts regularly** and add overrides for vulnerable packages.

## Input Validation Patterns

### Allowlist over Blocklist

```typescript
// BAD: Blocklist (can be bypassed)
if (input.includes("..") || input.includes("~")) {
    throw new Error("Invalid path");
}

// GOOD: Allowlist (explicitly permit safe patterns)
if (!/^[\w./-]+$/.test(input)) {
    throw new Error("Invalid path");
}
```

### Path Traversal Prevention

```typescript
import { normalize, isAbsolute, resolve } from "node:path";

function validatePath(basePath: string, userPath: string): string {
    const normalized = normalize(userPath);
    const resolved = resolve(basePath, normalized);

    // Ensure resolved path is within base directory
    if (!resolved.startsWith(basePath)) {
        throw new Error("Path traversal detected");
    }

    return resolved;
}
```

### URL Validation

**CRITICAL**: Never use substring checks to validate URLs.

```typescript
// BAD: Substring can appear anywhere in URL
if (url.includes("example.com")) {
    // Bypassed by: http://evil.com/example.com
    // Bypassed by: http://evil.com?x=example.com
    // Bypassed by: http://example.com.evil.com
}

// BAD: Even checking parsed host with includes is vulnerable
const host = new URL(url).host;
if (host.includes("example.com")) {
    // Bypassed by: http://example.com.evil.com
}

// GOOD: Parse URL and check exact host match
const host = new URL(url).host;
if (host === "example.com" || host.endsWith(".example.com")) {
    // Safe: only matches example.com and subdomains
}

// GOOD: Allowlist of valid hosts
const ALLOWED_HOSTS = ["example.com", "api.example.com", "cdn.example.com"];
const host = new URL(url).host;
if (ALLOWED_HOSTS.includes(host)) {
    // Safe: explicit allowlist
}
```

**In tests**: Use exact URL match when asserting URL values:
```typescript
// BAD: Substring check (CodeQL flags this)
expect(urls.some((u) => u.includes("example.com"))).toBe(true);

// GOOD: Exact match
expect(urls.some((u) => u === "https://example.com/path")).toBe(true);
```

## Security Checklist

Before merging code that handles:

**User input:**
- [ ] Input validated with allowlist pattern
- [ ] No regex with nested quantifiers
- [ ] Sanitization functions return validated value
- [ ] URL checks use parsed host, not substring match

**External commands:**
- [ ] Using `execFileSync` not `execSync`
- [ ] Arguments passed as array, not string interpolation
- [ ] User input validated before passing to commands

**HTTP responses:**
- [ ] No stack traces in error responses
- [ ] No internal paths exposed
- [ ] Generic error messages for 5xx errors

**Dependencies:**
- [ ] No known vulnerabilities (check Dependabot)
- [ ] Overrides added for vulnerable transitive deps
- [ ] Native modules use prebuilt binaries where possible

## CodeQL Integration

This repo runs CodeQL on PRs. Common alerts and fixes:

| Alert | Fix |
|-------|-----|
| `js/polynomial-redos` | Rewrite regex or use split-based approach |
| `js/command-line-injection` | Use execFileSync with array args |
| `js/second-order-command-line-injection` | Return validated value from sanitizer |
| `js/stack-trace-exposure` | Use generic error messages |
| `js/prototype-polluting-assignment` | Validate object keys before assignment |
| `js/incomplete-url-substring-sanitization` | Parse URL and check exact host or use allowlist |

## Semgrep Rules

Local security scanning runs via `pnpm security`. Rules catch:
- Command injection patterns
- ReDoS-prone regexes
- Hardcoded secrets
- Unsafe deserialization
