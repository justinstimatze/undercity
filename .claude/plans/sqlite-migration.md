# SQLite Migration Plan for JSON Persistence Modules

## Overview

Migrate the remaining JSON file persistence modules to use SQLite storage for improved performance, concurrent access, and query capabilities.

## Current State

| Module | JSON File | SQLite Schema | Status |
|--------|-----------|---------------|--------|
| `knowledge.ts` | `knowledge.json` | `learnings` table | **Hybrid** (writes to both) |
| `error-fix-patterns.ts` | `error-fix-patterns.json` | `error_patterns`, `error_fixes`, `pending_errors`, `permanent_failures` | JSON only |
| `decision-tracker.ts` | `decisions.json` | `decisions`, `decision_resolutions`, `human_overrides` | JSON only |
| `task-file-patterns.ts` | `task-file-patterns.json` | `task_file_records`, `keyword_correlations`, `co_modifications` | JSON only |

## Migration Strategy

### Phase 1: Dual-Write Mode (Low Risk)

Add SQLite writes alongside existing JSON writes. Read continues from JSON.

**For each module:**
1. Import storage functions at the top
2. Add SQLite write after each JSON write
3. No changes to read path yet

**Files to modify:**
- `error-fix-patterns.ts`: After `saveErrorFixStore()`, also write to SQLite
- `decision-tracker.ts`: After `saveDecisionStore()`, also write to SQLite
- `task-file-patterns.ts`: After `saveTaskFileStore()`, also write to SQLite

**Example pattern:**
```typescript
// After existing saveErrorFixStore(store, stateDir)
try {
  const { upsertErrorPattern, addErrorFix } = await import("./storage.js");
  for (const pattern of Object.values(store.patterns)) {
    upsertErrorPattern(pattern.signature, pattern.category, pattern.sampleMessage, stateDir);
    for (const fix of pattern.fixes) {
      addErrorFix(pattern.signature, fix, stateDir);
    }
  }
} catch {
  // SQLite not available, continue with JSON only
}
```

### Phase 2: Read from SQLite with JSON Fallback (Medium Risk)

Switch read path to SQLite first, fall back to JSON if empty.

**For each module:**
1. Try loading from SQLite first
2. If SQLite has data, use it
3. If SQLite empty, load from JSON and migrate

**Example pattern:**
```typescript
export function loadErrorFixStore(stateDir: string = DEFAULT_STATE_DIR): ErrorFixStore {
  try {
    const { getStorageStats, getAllErrorPatterns } = await import("./storage.js");
    const stats = getStorageStats(stateDir);
    if (stats.errorPatterns.total > 0) {
      // Load from SQLite
      return loadFromSQLite(stateDir);
    }
  } catch {
    // SQLite not available
  }

  // Fallback to JSON
  return loadFromJSON(stateDir);
}
```

### Phase 3: SQLite Primary, JSON Deprecated (Higher Risk)

Remove JSON writes, keep JSON read for migration only.

**Changes:**
1. Remove `saveXxxStore()` JSON writes
2. Keep `loadXxxStore()` JSON read as migration path
3. Add deprecation warnings for JSON files
4. Update documentation

### Phase 4: JSON Removal (Breaking Change)

Remove JSON persistence entirely.

**Changes:**
1. Remove JSON read functions
2. Delete JSON schema types
3. Update tests to use SQLite only
4. Major version bump

## Implementation Tasks

### Phase 1 Tasks

1. **error-fix-patterns.ts**
   - [ ] Add SQLite write to `recordPendingError()`
   - [ ] Add SQLite write to `recordSuccessfulFix()`
   - [ ] Add SQLite write to `recordPermanentFailure()`
   - [ ] Add SQLite write to `clearPendingError()`

2. **decision-tracker.ts**
   - [ ] Add SQLite write to `captureDecision()`
   - [ ] Add SQLite write to `resolveDecision()`
   - [ ] Add SQLite write to `recordHumanOverride()`

3. **task-file-patterns.ts**
   - [ ] Add SQLite write to `recordTaskFiles()`
   - [ ] Add SQLite write to keyword correlation updates
   - [ ] Add SQLite write to co-modification pattern updates

### Phase 2 Tasks

4. **Add read-from-SQLite functions**
   - [ ] `loadErrorFixStoreFromSQLite()` in error-fix-patterns.ts
   - [ ] `loadDecisionStoreFromSQLite()` in decision-tracker.ts
   - [ ] `loadTaskFileStoreFromSQLite()` in task-file-patterns.ts

5. **Add auto-migration on read**
   - [ ] If SQLite empty but JSON exists, migrate
   - [ ] Log migration for visibility

### Phase 3 Tasks

6. **Remove JSON writes**
   - [ ] Remove `saveErrorFixStore()` calls
   - [ ] Remove `saveDecisionStore()` calls
   - [ ] Remove `saveTaskFileStore()` calls

7. **Add deprecation warnings**
   - [ ] Warn on JSON file detection
   - [ ] Suggest migration command

### Phase 4 Tasks

8. **Clean up**
   - [ ] Remove JSON load functions
   - [ ] Remove JSON schema types
   - [ ] Update all tests
   - [ ] Update documentation

## Risk Mitigation

1. **Data Loss Prevention**
   - Always write to JSON first, then SQLite
   - Keep JSON files until Phase 4
   - Backup JSON files before migration

2. **Performance Monitoring**
   - Log SQLite operation timing
   - Compare with JSON timing
   - Alert on significant slowdowns

3. **Rollback Plan**
   - Keep JSON files as backup
   - Feature flag to force JSON mode
   - `UNDERCITY_USE_JSON=1` env var

## Testing Requirements

1. **Unit Tests**
   - Test each storage function independently
   - Test migration from JSON to SQLite
   - Test fallback behavior

2. **Integration Tests**
   - Test full grind with SQLite storage
   - Test concurrent access patterns
   - Test crash recovery

3. **Performance Tests**
   - Benchmark read/write operations
   - Test with large data sets (1000+ entries)
   - Test concurrent workers

## Timeline Estimate

| Phase | Effort | Risk |
|-------|--------|------|
| Phase 1 | 2-4 hours | Low |
| Phase 2 | 4-6 hours | Medium |
| Phase 3 | 2-4 hours | Medium |
| Phase 4 | 2-4 hours | High |

**Total: 10-18 hours**

## Dependencies

- `better-sqlite3` (already installed)
- SQLite schema (already defined in `storage.ts`)
- Migration functions (already implemented in `storage.ts`)

## Success Criteria

1. All grind operations work with SQLite storage
2. No data loss during migration
3. Performance equal to or better than JSON
4. All tests passing
5. Clean deprecation path for JSON files
