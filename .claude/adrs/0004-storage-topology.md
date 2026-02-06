# ADR-0004: Storage Topology (SQLite + JSON Split)

## Status
Accepted

## Context
Undercity has two categories of persistent state:
1. **Structured data** with concurrent access (task board, patterns, decisions) - needs transactions and query support
2. **Simple key-value data** with infrequent writes (knowledge base, routing profile, capability ledger) - simpler access patterns

Options: all SQLite, all JSON files, or a split approach.

## Decision
Split storage by access pattern:
- **SQLite (WAL mode, busy_timeout=5000ms)**: task board, task-file-patterns, error-fix-patterns, decision-tracker, RAG index. These benefit from SQL queries, transactions, and built-in concurrency.
- **JSON files (with file locking via `withFileLock`)**: knowledge.json, capability-ledger.json, routing-profile.json. These are append-mostly, read-heavy, and benefit from human readability.

## Consequences
**Benefits:**
- SQLite WAL mode allows concurrent readers + single writer without blocking
- JSON files are debuggable (human-readable, git-diffable)
- Each storage type matches its access pattern naturally
- busy_timeout prevents "database locked" errors in parallel execution

**Tradeoffs:**
- Two persistence mechanisms to maintain
- File locking adds complexity for JSON files (stale lock detection, retry logic)
- Migration path needed when moving from JSON to SQLite (already done for patterns/decisions)

**What breaks if violated:**
- Without WAL mode: readers block writers during parallel task execution
- Without file locking: concurrent JSON writes corrupt data (partial writes, lost updates)
- Without busy_timeout: parallel workers get sporadic "database locked" errors

## Code Locations
- `src/storage.ts` - SQLite database with WAL mode + busy_timeout=5000
- `src/file-lock.ts` - `withFileLock()`, `withFileLockAsync()` for JSON files
- `src/knowledge.ts` - JSON file-backed with file locking
- `src/capability-ledger.ts` - JSON file-backed with file locking
