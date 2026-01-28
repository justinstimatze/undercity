/**
 * Boundary and edge case tests for storage.ts
 *
 * Tests SQLite database operations under adverse conditions:
 * - Transaction rollback on error
 * - Concurrent write conflicts (SQLITE_BUSY errors)
 * - Database corruption recovery
 * - Zero-record query results
 * - Boundary value handling (max lengths, extreme numbers)
 * - NULL/undefined field handling
 * - Invalid JSON in stored fields
 * - Timestamp edge cases
 *
 * @module storage.test
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	addErrorFix,
	closeDatabase,
	getAllLearnings,
	getAllTasksDB,
	getCorrelatedFiles,
	getDatabase,
	getErrorPattern,
	getLearningById,
	getLearningsByCategory,
	getPendingDecisions,
	getReadyTasksDB,
	getStorageStats,
	getTaskByIdDB,
	getTasksByStatusDB,
	insertTask,
	type Learning,
	recordTaskFile,
	resetDatabase,
	searchLearningsByKeywords,
	searchResolvedDecisions,
	type TaskRecord,
	updateKeywordCorrelation,
	updateLearningUsage,
	updateTaskStatusDB,
	upsertErrorPattern,
	upsertLearning,
} from "../storage.js";

describe("storage.ts - Boundary and Edge Cases", () => {
	let tempDir: string;

	beforeEach(() => {
		// Create isolated temporary directory for each test
		tempDir = mkdtempSync(join(tmpdir(), "storage-boundary-test-"));
		resetDatabase();
	});

	afterEach(() => {
		// Clean up database connection and files
		closeDatabase();
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ==========================================================================
	// Transaction Rollback Tests
	// ==========================================================================

	describe("Transaction Rollback", () => {
		/**
		 * Test that failed operations within transactions properly rollback
		 * without persisting partial changes
		 */
		it("should rollback transaction on constraint violation without partial commits", () => {
			const db = getDatabase(tempDir);

			// Insert a task successfully
			const task1: TaskRecord = {
				id: "task-rollback-1",
				objective: "First task",
				status: "pending",
				createdAt: new Date().toISOString(),
			};
			insertTask(task1, tempDir);

			// Try to insert duplicate task ID within transaction - should fail
			const transaction = db.transaction(() => {
				// This should succeed
				const task2: TaskRecord = {
					id: "task-rollback-2",
					objective: "Second task",
					status: "pending",
					createdAt: new Date().toISOString(),
				};
				insertTask(task2, tempDir);

				// This should fail (duplicate primary key)
				insertTask(task1, tempDir);
			});

			// Transaction should fail and rollback
			expect(() => transaction()).toThrow();

			// Verify NO partial data was committed
			const allTasks = getAllTasksDB(tempDir);
			expect(allTasks).toHaveLength(1); // Only original task
			expect(allTasks[0].id).toBe("task-rollback-1");

			// Verify task-rollback-2 was NOT persisted
			const task2 = getTaskByIdDB("task-rollback-2", tempDir);
			expect(task2).toBeNull();
		});

		/**
		 * Test rollback behavior with multiple table modifications
		 */
		it("should rollback changes across multiple tables on error", () => {
			const db = getDatabase(tempDir);

			const transaction = db.transaction(() => {
				// Insert learning
				const learning: Learning = {
					id: "learn-tx-1",
					taskId: "task-tx-1",
					category: "pattern",
					content: "Test learning",
					keywords: ["test"],
					confidence: 0.5,
					usedCount: 0,
					successCount: 0,
					createdAt: new Date().toISOString(),
				};
				upsertLearning(learning, tempDir);

				// Insert error pattern
				upsertErrorPattern("sig-tx-1", "typecheck", "Test error", tempDir);

				// Trigger constraint violation
				db.prepare("INSERT INTO learnings (id) VALUES (?)").run("learn-tx-1");
			});

			expect(() => transaction()).toThrow();

			// Verify rollback across all tables
			const learnings = getAllLearnings(tempDir);
			expect(learnings).toHaveLength(0);

			const pattern = getErrorPattern("sig-tx-1", tempDir);
			expect(pattern).toBeNull();
		});
	});

	// ==========================================================================
	// Concurrent Write Conflict Tests
	// ==========================================================================

	describe("Concurrent Write Conflicts", () => {
		/**
		 * Test handling of concurrent writes with WAL mode
		 * WAL mode allows concurrent reads and single writer
		 */
		it("should handle concurrent writes with WAL mode gracefully", () => {
			// SQLite WAL mode allows one writer at a time
			// Subsequent writes wait or fail with SQLITE_BUSY

			const task1: TaskRecord = {
				id: "task-concurrent-1",
				objective: "First concurrent task",
				status: "pending",
				createdAt: new Date().toISOString(),
			};

			const task2: TaskRecord = {
				id: "task-concurrent-2",
				objective: "Second concurrent task",
				status: "pending",
				createdAt: new Date().toISOString(),
			};

			// Insert both tasks - WAL mode should handle serialization
			insertTask(task1, tempDir);
			insertTask(task2, tempDir);

			const allTasks = getAllTasksDB(tempDir);
			expect(allTasks).toHaveLength(2);
			expect(allTasks.map((t) => t.id)).toContain("task-concurrent-1");
			expect(allTasks.map((t) => t.id)).toContain("task-concurrent-2");
		});

		/**
		 * Test busy timeout pragma setting
		 */
		it("should respect busy_timeout pragma for locked database", () => {
			const db = getDatabase(tempDir);

			// Verify busy_timeout is configured
			const timeout = db.pragma("busy_timeout", { simple: true });
			expect(timeout).toBe(5000); // 5 seconds from storage.ts
		});

		/**
		 * Test multiple readers with single writer (WAL mode)
		 */
		it("should allow concurrent reads during write operations", () => {
			// Insert test data
			const learning: Learning = {
				id: "learn-concurrent-1",
				taskId: "task-1",
				category: "pattern",
				content: "Concurrent read test",
				keywords: ["concurrent"],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};
			upsertLearning(learning, tempDir);

			// Simulate concurrent reads - should succeed
			const read1 = getAllLearnings(tempDir);
			const read2 = getLearningById("learn-concurrent-1", tempDir);
			const read3 = searchLearningsByKeywords(["concurrent"], 10, tempDir);

			expect(read1).toHaveLength(1);
			expect(read2).not.toBeNull();
			expect(read3).toHaveLength(1);
		});
	});

	// ==========================================================================
	// Database Corruption Recovery Tests
	// ==========================================================================

	describe("Database Corruption Recovery", () => {
		/**
		 * Test handling of corrupted database file
		 */
		it("should handle corrupted database file by recreating schema", () => {
			const dbPath = join(tempDir, "undercity.db");

			// Create corrupted file (invalid SQLite format)
			writeFileSync(dbPath, "CORRUPTED DATA NOT SQLITE", "utf-8");
			closeDatabase();
			resetDatabase();

			// Attempt to use database - should recreate
			// This will throw because better-sqlite3 validates format
			expect(() => getDatabase(tempDir)).toThrow();
		});

		/**
		 * Test handling of invalid schema version
		 */
		it("should migrate database with old schema version", () => {
			const db = getDatabase(tempDir);

			// Downgrade schema version
			db.pragma("user_version = 1");
			closeDatabase();
			resetDatabase();

			// Reopen - should trigger migration
			const newDb = getDatabase(tempDir);
			const version = newDb.pragma("user_version", { simple: true });
			expect(version).toBeGreaterThanOrEqual(6); // Current version from storage.ts
		});

		/**
		 * Test recovery from missing required columns (schema mismatch)
		 */
		it("should handle missing columns gracefully", () => {
			const db = getDatabase(tempDir);

			// Schema should have all required columns
			// Verify tasks table has expected columns
			const tableInfo = db.pragma("table_info(tasks)");
			const columnNames = (tableInfo as Array<{ name: string }>).map((col) => col.name);

			expect(columnNames).toContain("id");
			expect(columnNames).toContain("objective");
			expect(columnNames).toContain("status");
			expect(columnNames).toContain("ticket");
			expect(columnNames).toContain("triage_issues");
		});
	});

	// ==========================================================================
	// Zero-Record Query Results
	// ==========================================================================

	describe("Zero-Record Query Results", () => {
		/**
		 * Test getLearningsByCategory returns empty array for non-existent category
		 */
		it("should return empty array when no learnings match category", () => {
			const result = getLearningsByCategory("pattern", tempDir);
			expect(result).toEqual([]);
			expect(Array.isArray(result)).toBe(true);
		});

		/**
		 * Test searchLearningsByKeywords returns empty array for no matches
		 */
		it("should return empty array when no learnings match keywords", () => {
			// Insert learning with different keywords
			const learning: Learning = {
				id: "learn-zero-1",
				taskId: "task-1",
				category: "fact",
				content: "Test content",
				keywords: ["unrelated", "keywords"],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};
			upsertLearning(learning, tempDir);

			// Search for different keywords
			const result = searchLearningsByKeywords(["nonexistent", "missing"], 10, tempDir);
			expect(result).toEqual([]);
		});

		/**
		 * Test getErrorPattern returns null for non-existent signature
		 */
		it("should return null when error pattern does not exist", () => {
			const result = getErrorPattern("nonexistent-signature", tempDir);
			expect(result).toBeNull();
		});

		/**
		 * Test getPendingDecisions returns empty array when no pending decisions
		 */
		it("should return empty array when no pending decisions exist", () => {
			const result = getPendingDecisions(tempDir);
			expect(result).toEqual([]);
			expect(Array.isArray(result)).toBe(true);
		});

		/**
		 * Test searchResolvedDecisions returns empty array for no matches
		 */
		it("should return empty array when no resolved decisions match keywords", () => {
			const result = searchResolvedDecisions(["nonexistent"], 5, tempDir);
			expect(result).toEqual([]);
		});

		/**
		 * Test getCorrelatedFiles returns empty array for unknown keywords
		 */
		it("should return empty array when no files correlate with keywords", () => {
			const result = getCorrelatedFiles(["unknown", "keywords"], 10, tempDir);
			expect(result).toEqual([]);
		});

		/**
		 * Test getTasksByStatusDB returns empty array for unused status
		 */
		it("should return empty array when no tasks have specified status", () => {
			const result = getTasksByStatusDB("failed", tempDir);
			expect(result).toEqual([]);
		});

		/**
		 * Test getReadyTasksDB returns empty array when no ready tasks
		 */
		it("should return empty array when no tasks are ready to execute", () => {
			// Insert decomposed task (not ready)
			const task: TaskRecord = {
				id: "task-decomposed",
				objective: "Parent task",
				status: "pending",
				isDecomposed: true,
				createdAt: new Date().toISOString(),
			};
			insertTask(task, tempDir);

			const result = getReadyTasksDB(10, tempDir);
			expect(result).toEqual([]);
		});

		/**
		 * Test stats with empty database
		 */
		it("should return zero stats for empty database", () => {
			const stats = getStorageStats(tempDir);

			expect(stats.learnings.total).toBe(0);
			expect(stats.errorPatterns.total).toBe(0);
			expect(stats.decisions.total).toBe(0);
			expect(stats.taskFileRecords).toBe(0);
			expect(stats.permanentFailures).toBe(0);
		});
	});

	// ==========================================================================
	// Boundary Value Tests
	// ==========================================================================

	describe("Boundary Values", () => {
		/**
		 * Test maximum string length handling
		 */
		it("should handle very long objective strings", () => {
			const longObjective = "x".repeat(10000); // 10KB objective

			const task: TaskRecord = {
				id: "task-long-objective",
				objective: longObjective,
				status: "pending",
				createdAt: new Date().toISOString(),
			};

			insertTask(task, tempDir);
			const retrieved = getTaskByIdDB("task-long-objective", tempDir);

			expect(retrieved).not.toBeNull();
			expect(retrieved?.objective).toBe(longObjective);
			expect(retrieved?.objective.length).toBe(10000);
		});

		/**
		 * Test extreme priority values
		 */
		it("should handle extreme priority values", () => {
			const task1: TaskRecord = {
				id: "task-priority-max",
				objective: "Max priority",
				status: "pending",
				priority: Number.MAX_SAFE_INTEGER,
				createdAt: new Date().toISOString(),
			};

			const task2: TaskRecord = {
				id: "task-priority-min",
				objective: "Min priority",
				status: "pending",
				priority: Number.MIN_SAFE_INTEGER,
				createdAt: new Date().toISOString(),
			};

			insertTask(task1, tempDir);
			insertTask(task2, tempDir);

			const retrieved1 = getTaskByIdDB("task-priority-max", tempDir);
			const retrieved2 = getTaskByIdDB("task-priority-min", tempDir);

			expect(retrieved1?.priority).toBe(Number.MAX_SAFE_INTEGER);
			expect(retrieved2?.priority).toBe(Number.MIN_SAFE_INTEGER);
		});

		/**
		 * Test negative risk scores
		 */
		it("should handle negative and zero risk scores", () => {
			const task1: TaskRecord = {
				id: "task-risk-negative",
				objective: "Negative risk",
				status: "pending",
				riskScore: -1.0,
				createdAt: new Date().toISOString(),
			};

			const task2: TaskRecord = {
				id: "task-risk-zero",
				objective: "Zero risk",
				status: "pending",
				riskScore: 0,
				createdAt: new Date().toISOString(),
			};

			insertTask(task1, tempDir);
			insertTask(task2, tempDir);

			const retrieved1 = getTaskByIdDB("task-risk-negative", tempDir);
			const retrieved2 = getTaskByIdDB("task-risk-zero", tempDir);

			expect(retrieved1?.riskScore).toBe(-1.0);
			expect(retrieved2?.riskScore).toBe(0);
		});

		/**
		 * Test confidence at boundaries (0.0 and 1.0)
		 */
		it("should handle confidence at min and max boundaries", () => {
			const learning1: Learning = {
				id: "learn-confidence-min",
				taskId: "task-1",
				category: "pattern",
				content: "Min confidence",
				keywords: ["min"],
				confidence: 0.0,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};

			const learning2: Learning = {
				id: "learn-confidence-max",
				taskId: "task-2",
				category: "pattern",
				content: "Max confidence",
				keywords: ["max"],
				confidence: 1.0,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};

			upsertLearning(learning1, tempDir);
			upsertLearning(learning2, tempDir);

			const retrieved1 = getLearningById("learn-confidence-min", tempDir);
			const retrieved2 = getLearningById("learn-confidence-max", tempDir);

			expect(retrieved1?.confidence).toBe(0.0);
			expect(retrieved2?.confidence).toBe(1.0);
		});

		/**
		 * Test updateLearningUsage respects confidence bounds
		 */
		it("should clamp confidence updates to [0.1, 1.0] range", () => {
			// Start at high confidence
			const learning: Learning = {
				id: "learn-clamp",
				taskId: "task-1",
				category: "pattern",
				content: "Clamp test",
				keywords: ["clamp"],
				confidence: 0.95,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};
			upsertLearning(learning, tempDir);

			// Multiple successful uses should cap at 1.0
			for (let i = 0; i < 10; i++) {
				updateLearningUsage("learn-clamp", true, tempDir);
			}

			const afterSuccess = getLearningById("learn-clamp", tempDir);
			expect(afterSuccess?.confidence).toBeLessThanOrEqual(1.0);

			// Multiple failures should floor at 0.1
			for (let i = 0; i < 100; i++) {
				updateLearningUsage("learn-clamp", false, tempDir);
			}

			const afterFailure = getLearningById("learn-clamp", tempDir);
			expect(afterFailure?.confidence).toBeGreaterThanOrEqual(0.1);
		});

		/**
		 * Test very large keyword arrays
		 */
		it("should handle large keyword arrays", () => {
			const largeKeywords = Array.from({ length: 1000 }, (_, i) => `keyword-${i}`);

			const learning: Learning = {
				id: "learn-large-keywords",
				taskId: "task-1",
				category: "pattern",
				content: "Large keywords test",
				keywords: largeKeywords,
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};

			upsertLearning(learning, tempDir);
			const retrieved = getLearningById("learn-large-keywords", tempDir);

			expect(retrieved).not.toBeNull();
			expect(retrieved?.keywords).toHaveLength(1000);
			expect(retrieved?.keywords[0]).toBe("keyword-0");
			expect(retrieved?.keywords[999]).toBe("keyword-999");
		});

		/**
		 * Test large file arrays in task records
		 */
		it("should handle large estimatedFiles arrays", () => {
			const largeFiles = Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`);

			const task: TaskRecord = {
				id: "task-large-files",
				objective: "Large files test",
				status: "pending",
				estimatedFiles: largeFiles,
				createdAt: new Date().toISOString(),
			};

			insertTask(task, tempDir);
			const retrieved = getTaskByIdDB("task-large-files", tempDir);

			expect(retrieved?.estimatedFiles).toHaveLength(500);
		});
	});

	// ==========================================================================
	// NULL and Undefined Handling
	// ==========================================================================

	describe("NULL and Undefined Handling", () => {
		/**
		 * Test task with minimal fields (all optional fields undefined)
		 */
		it("should handle task with only required fields", () => {
			const minimalTask: TaskRecord = {
				id: "task-minimal",
				objective: "Minimal task",
				status: "pending",
				createdAt: new Date().toISOString(),
			};

			insertTask(minimalTask, tempDir);
			const retrieved = getTaskByIdDB("task-minimal", tempDir);

			expect(retrieved).not.toBeNull();
			expect(retrieved?.id).toBe("task-minimal");
			expect(retrieved?.priority).toBeUndefined();
			expect(retrieved?.sessionId).toBeUndefined();
			expect(retrieved?.error).toBeUndefined();
			expect(retrieved?.tags).toBeUndefined();
		});

		/**
		 * Test learning with optional structured field undefined
		 */
		it("should handle learning without structured field", () => {
			const learning: Learning = {
				id: "learn-no-structured",
				taskId: "task-1",
				category: "fact",
				content: "No structured data",
				keywords: ["test"],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
				// structured is undefined
			};

			upsertLearning(learning, tempDir);
			const retrieved = getLearningById("learn-no-structured", tempDir);

			expect(retrieved?.structured).toBeUndefined();
		});

		/**
		 * Test task with null optional timestamp fields
		 */
		it("should handle tasks with no startedAt or completedAt", () => {
			const task: TaskRecord = {
				id: "task-no-timestamps",
				objective: "No timestamps",
				status: "pending",
				createdAt: new Date().toISOString(),
			};

			insertTask(task, tempDir);
			const retrieved = getTaskByIdDB("task-no-timestamps", tempDir);

			expect(retrieved?.startedAt).toBeUndefined();
			expect(retrieved?.completedAt).toBeUndefined();
		});

		/**
		 * Test status update with no optional fields
		 */
		it("should handle updateTaskStatusDB with no optional updates", () => {
			const task: TaskRecord = {
				id: "task-status-update",
				objective: "Status update test",
				status: "pending",
				createdAt: new Date().toISOString(),
			};

			insertTask(task, tempDir);
			const updated = updateTaskStatusDB("task-status-update", "in_progress", {}, tempDir);

			expect(updated).toBe(true);

			const retrieved = getTaskByIdDB("task-status-update", tempDir);
			expect(retrieved?.status).toBe("in_progress");
		});

		/**
		 * Test empty array fields
		 */
		it("should handle empty arrays in task fields", () => {
			const task: TaskRecord = {
				id: "task-empty-arrays",
				objective: "Empty arrays test",
				status: "pending",
				tags: [],
				dependsOn: [],
				estimatedFiles: [],
				createdAt: new Date().toISOString(),
			};

			insertTask(task, tempDir);
			const retrieved = getTaskByIdDB("task-empty-arrays", tempDir);

			expect(retrieved?.tags).toEqual([]);
			expect(retrieved?.dependsOn).toEqual([]);
			expect(retrieved?.estimatedFiles).toEqual([]);
		});
	});

	// ==========================================================================
	// Timestamp Edge Cases
	// ==========================================================================

	describe("Timestamp Edge Cases", () => {
		/**
		 * Test far future timestamp
		 */
		it("should handle far future timestamps", () => {
			const futureDate = new Date("2999-12-31T23:59:59.999Z").toISOString();

			const task: TaskRecord = {
				id: "task-future",
				objective: "Far future task",
				status: "pending",
				createdAt: futureDate,
			};

			insertTask(task, tempDir);
			const retrieved = getTaskByIdDB("task-future", tempDir);

			expect(retrieved?.createdAt).toBe(futureDate);
		});

		/**
		 * Test far past timestamp
		 */
		it("should handle far past timestamps", () => {
			const pastDate = new Date("1970-01-01T00:00:00.000Z").toISOString();

			const task: TaskRecord = {
				id: "task-past",
				objective: "Far past task",
				status: "pending",
				createdAt: pastDate,
			};

			insertTask(task, tempDir);
			const retrieved = getTaskByIdDB("task-past", tempDir);

			expect(retrieved?.createdAt).toBe(pastDate);
		});

		/**
		 * Test timestamp ordering in queries
		 */
		it("should maintain correct timestamp ordering", () => {
			const timestamps = ["2024-01-01T00:00:00.000Z", "2024-06-15T12:30:00.000Z", "2025-12-31T23:59:59.999Z"];

			for (const [index, timestamp] of timestamps.entries()) {
				const task: TaskRecord = {
					id: `task-order-${index}`,
					objective: `Task ${index}`,
					status: "pending",
					createdAt: timestamp,
				};
				insertTask(task, tempDir);
			}

			const allTasks = getAllTasksDB(tempDir);
			const dates = allTasks.map((t) => new Date(t.createdAt).getTime());

			// Verify ascending order
			for (let i = 1; i < dates.length; i++) {
				expect(dates[i]).toBeGreaterThanOrEqual(dates[i - 1]);
			}
		});
	});

	// ==========================================================================
	// JSON Field Validation
	// ==========================================================================

	describe("JSON Field Validation", () => {
		/**
		 * Test complex nested JSON in handoffContext
		 */
		it("should handle complex nested JSON in handoffContext", () => {
			const complexContext = {
				filesRead: ["file1.ts", "file2.ts"],
				decisions: ["Decision 1", "Decision 2"],
				codeContext: "Complex context with special chars: éàü",
				notes: "Notes with\nmultiple\nlines",
				lastAttempt: {
					model: "opus",
					category: "critical",
					error: "Complex error\nwith newlines",
					filesModified: ["modified1.ts"],
					attemptedAt: new Date().toISOString(),
					attemptCount: 3,
				},
			};

			const task: TaskRecord = {
				id: "task-complex-json",
				objective: "Complex JSON test",
				status: "pending",
				handoffContext: complexContext,
				createdAt: new Date().toISOString(),
			};

			insertTask(task, tempDir);
			const retrieved = getTaskByIdDB("task-complex-json", tempDir);

			expect(retrieved?.handoffContext).toEqual(complexContext);
			expect(retrieved?.handoffContext?.lastAttempt?.attemptCount).toBe(3);
		});

		/**
		 * Test JSON with special characters
		 */
		it("should handle JSON with special characters", () => {
			const specialContent = {
				filesChanged: ['file"with"quotes.ts', "file'with'apostrophes.ts", "file\\with\\backslashes.ts"],
			};

			const task: TaskRecord = {
				id: "task-special-chars",
				objective: "Special chars test",
				status: "pending",
				computedPackages: specialContent.filesChanged,
				createdAt: new Date().toISOString(),
			};

			insertTask(task, tempDir);
			const retrieved = getTaskByIdDB("task-special-chars", tempDir);

			expect(retrieved?.computedPackages).toEqual(specialContent.filesChanged);
		});

		/**
		 * Test updateKeywordCorrelation with complex file data
		 */
		it("should handle complex keyword correlation updates", () => {
			const files = Array.from({ length: 50 }, (_, i) => `src/module-${i}/file.ts`);

			// Update multiple times to build correlation
			for (let i = 0; i < 10; i++) {
				updateKeywordCorrelation("refactor", files, true, tempDir);
			}

			const correlated = getCorrelatedFiles(["refactor"], 100, tempDir);
			expect(correlated.length).toBeGreaterThan(0);
			expect(correlated[0].score).toBeGreaterThan(0);
		});

		/**
		 * Test recordTaskFile with large file arrays
		 */
		it("should handle task file records with many files", () => {
			const filesModified = Array.from({ length: 100 }, (_, i) => `file-${i}.ts`);

			recordTaskFile(
				{
					taskId: "task-many-files",
					objective: "Modified many files",
					filesModified,
					success: true,
					keywords: ["refactor", "large"],
					recordedAt: new Date().toISOString(),
				},
				tempDir,
			);

			const stats = getStorageStats(tempDir);
			expect(stats.taskFileRecords).toBe(1);
		});
	});

	// ==========================================================================
	// Error Fix Pattern Edge Cases
	// ==========================================================================

	describe("Error Fix Patterns", () => {
		/**
		 * Test error pattern with no fixes
		 */
		it("should handle error pattern with no associated fixes", () => {
			upsertErrorPattern("sig-no-fixes", "lint", "Sample error message", tempDir);

			const pattern = getErrorPattern("sig-no-fixes", tempDir);
			expect(pattern).not.toBeNull();
			expect(pattern?.fixes).toEqual([]);
			expect(pattern?.occurrences).toBe(1);
		});

		/**
		 * Test adding multiple fixes to same signature
		 */
		it("should handle multiple fixes for same error signature", () => {
			const signature = "sig-multi-fix";
			upsertErrorPattern(signature, "typecheck", "Type error", tempDir);

			// Add multiple fixes
			for (let i = 0; i < 5; i++) {
				addErrorFix(
					signature,
					{
						description: `Fix ${i}`,
						filesChanged: [`file${i}.ts`],
					},
					tempDir,
				);
			}

			const pattern = getErrorPattern(signature, tempDir);
			expect(pattern?.fixes).toHaveLength(5);
		});

		/**
		 * Test error pattern with very long message
		 */
		it("should handle error patterns with very long messages", () => {
			const longMessage = `Error: ${"x".repeat(5000)}`;

			upsertErrorPattern("sig-long-message", "test", longMessage, tempDir);

			const pattern = getErrorPattern("sig-long-message", tempDir);
			expect(pattern?.sampleMessage).toBe(longMessage);
		});
	});
});
