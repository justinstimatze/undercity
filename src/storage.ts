/**
 * SQLite Storage Layer
 *
 * Provides persistent storage for all learning systems using SQLite.
 * Replaces JSON file persistence with proper ACID transactions and
 * efficient querying.
 *
 * Tables:
 * - learnings: Knowledge base entries
 * - error_patterns: Error-to-fix patterns
 * - error_fixes: Individual fixes (many-to-one with error_patterns)
 * - pending_errors: Errors awaiting resolution
 * - permanent_failures: Failed tasks after max retries
 * - task_file_records: Recent task-file relationships
 * - keyword_correlations: Task keyword to file mappings
 * - co_modifications: Files that change together
 * - decisions: Decision points from agents
 * - decision_resolutions: How decisions were resolved
 * - human_overrides: Human corrections to PM/auto decisions
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { sessionLogger } from "./logger.js";
import type { Learning, LearningCategory } from "./knowledge.js";
import type { DecisionCategory, ConfidenceLevel } from "./decision-tracker.js";

const logger = sessionLogger.child({ module: "storage" });

const DEFAULT_STATE_DIR = ".undercity";
const DB_FILENAME = "undercity.db";
const SCHEMA_VERSION = 1;

// =============================================================================
// Database Instance Management
// =============================================================================

let dbInstance: Database.Database | null = null;

/**
 * Get or create the database connection
 */
export function getDatabase(stateDir: string = DEFAULT_STATE_DIR): Database.Database {
	if (dbInstance) {
		return dbInstance;
	}

	const dbPath = join(stateDir, DB_FILENAME);

	// Ensure directory exists
	if (!existsSync(stateDir)) {
		mkdirSync(stateDir, { recursive: true });
	}

	dbInstance = new Database(dbPath);

	// Enable WAL mode for better concurrent access
	dbInstance.pragma("journal_mode = WAL");
	dbInstance.pragma("busy_timeout = 5000");
	dbInstance.pragma("synchronous = NORMAL");

	// Initialize schema
	initializeSchema(dbInstance);

	logger.info({ path: dbPath }, "SQLite database initialized");

	return dbInstance;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
	if (dbInstance) {
		dbInstance.close();
		dbInstance = null;
		logger.debug("Database connection closed");
	}
}

/**
 * Reset database instance (for testing)
 */
export function resetDatabase(): void {
	closeDatabase();
}

// =============================================================================
// Schema Management
// =============================================================================

function initializeSchema(db: Database.Database): void {
	const version = db.pragma("user_version", { simple: true }) as number;

	if (version >= SCHEMA_VERSION) {
		return;
	}

	logger.info({ currentVersion: version, targetVersion: SCHEMA_VERSION }, "Migrating database schema");

	db.exec(`
		-- Learnings table (knowledge base)
		CREATE TABLE IF NOT EXISTS learnings (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL,
			category TEXT NOT NULL,
			content TEXT NOT NULL,
			keywords TEXT NOT NULL,  -- JSON array
			structured TEXT,  -- JSON object
			confidence REAL NOT NULL DEFAULT 0.5,
			used_count INTEGER NOT NULL DEFAULT 0,
			success_count INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			last_used_at TEXT,
			embedding BLOB  -- For vector search (added in future)
		);

		CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);
		CREATE INDEX IF NOT EXISTS idx_learnings_task_id ON learnings(task_id);
		CREATE INDEX IF NOT EXISTS idx_learnings_confidence ON learnings(confidence DESC);

		-- Error patterns table
		CREATE TABLE IF NOT EXISTS error_patterns (
			signature TEXT PRIMARY KEY,
			category TEXT NOT NULL,
			sample_message TEXT NOT NULL,
			occurrences INTEGER NOT NULL DEFAULT 1,
			fix_successes INTEGER NOT NULL DEFAULT 0,
			first_seen TEXT NOT NULL,
			last_seen TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_error_patterns_category ON error_patterns(category);

		-- Error fixes table (many-to-one with error_patterns)
		CREATE TABLE IF NOT EXISTS error_fixes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			signature TEXT NOT NULL REFERENCES error_patterns(signature),
			description TEXT NOT NULL,
			diff TEXT,
			files_changed TEXT NOT NULL,  -- JSON array
			success_count INTEGER NOT NULL DEFAULT 1,
			failure_count INTEGER NOT NULL DEFAULT 0,
			recorded_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_error_fixes_signature ON error_fixes(signature);

		-- Pending errors awaiting resolution
		CREATE TABLE IF NOT EXISTS pending_errors (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			signature TEXT NOT NULL,
			category TEXT NOT NULL,
			message TEXT NOT NULL,
			task_id TEXT NOT NULL,
			files_before_fix TEXT NOT NULL,  -- JSON array
			recorded_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_pending_errors_task_id ON pending_errors(task_id);

		-- Permanent failures
		CREATE TABLE IF NOT EXISTS permanent_failures (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			signature TEXT NOT NULL,
			category TEXT NOT NULL,
			sample_message TEXT NOT NULL,
			task_objective TEXT NOT NULL,
			model_used TEXT NOT NULL,
			attempts_count INTEGER NOT NULL,
			files_attempted TEXT NOT NULL,  -- JSON array
			detailed_errors TEXT,  -- JSON array
			recorded_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_permanent_failures_category ON permanent_failures(category);
		CREATE INDEX IF NOT EXISTS idx_permanent_failures_signature ON permanent_failures(signature);

		-- Task file records
		CREATE TABLE IF NOT EXISTS task_file_records (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id TEXT NOT NULL,
			objective TEXT NOT NULL,
			files_modified TEXT NOT NULL,  -- JSON array
			success INTEGER NOT NULL,
			keywords TEXT NOT NULL,  -- JSON array
			recorded_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_task_file_records_task_id ON task_file_records(task_id);

		-- Keyword correlations
		CREATE TABLE IF NOT EXISTS keyword_correlations (
			keyword TEXT PRIMARY KEY,
			files TEXT NOT NULL,  -- JSON object: file -> count
			task_count INTEGER NOT NULL DEFAULT 0,
			success_count INTEGER NOT NULL DEFAULT 0,
			last_updated TEXT
		);

		-- Co-modification patterns
		CREATE TABLE IF NOT EXISTS co_modifications (
			file TEXT PRIMARY KEY,
			co_modified TEXT NOT NULL,  -- JSON object: file -> count
			modification_count INTEGER NOT NULL DEFAULT 0,
			last_updated TEXT
		);

		-- Decision points
		CREATE TABLE IF NOT EXISTS decisions (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL,
			question TEXT NOT NULL,
			options TEXT,  -- JSON array
			context TEXT NOT NULL,
			category TEXT NOT NULL,
			keywords TEXT NOT NULL,  -- JSON array
			captured_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_decisions_task_id ON decisions(task_id);
		CREATE INDEX IF NOT EXISTS idx_decisions_category ON decisions(category);

		-- Decision resolutions
		CREATE TABLE IF NOT EXISTS decision_resolutions (
			decision_id TEXT PRIMARY KEY REFERENCES decisions(id),
			resolved_by TEXT NOT NULL,
			decision TEXT NOT NULL,
			reasoning TEXT,
			confidence TEXT,
			resolved_at TEXT NOT NULL,
			outcome TEXT
		);

		-- Human overrides
		CREATE TABLE IF NOT EXISTS human_overrides (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			decision_id TEXT NOT NULL REFERENCES decisions(id),
			original_decision TEXT NOT NULL,
			original_resolver TEXT NOT NULL,
			human_decision TEXT NOT NULL,
			human_reasoning TEXT,
			overridden_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_human_overrides_decision_id ON human_overrides(decision_id);

		-- Schema version
		PRAGMA user_version = ${SCHEMA_VERSION};
	`);
}

// =============================================================================
// Learning Operations
// =============================================================================

/**
 * Insert or update a learning
 */
export function upsertLearning(learning: Learning, stateDir: string = DEFAULT_STATE_DIR): void {
	const db = getDatabase(stateDir);

	const stmt = db.prepare(`
		INSERT INTO learnings (
			id, task_id, category, content, keywords, structured,
			confidence, used_count, success_count, created_at, last_used_at
		) VALUES (
			@id, @taskId, @category, @content, @keywords, @structured,
			@confidence, @usedCount, @successCount, @createdAt, @lastUsedAt
		) ON CONFLICT(id) DO UPDATE SET
			category = excluded.category,
			content = excluded.content,
			keywords = excluded.keywords,
			structured = excluded.structured,
			confidence = excluded.confidence,
			used_count = excluded.used_count,
			success_count = excluded.success_count,
			last_used_at = excluded.last_used_at
	`);

	stmt.run({
		id: learning.id,
		taskId: learning.taskId,
		category: learning.category,
		content: learning.content,
		keywords: JSON.stringify(learning.keywords),
		structured: learning.structured ? JSON.stringify(learning.structured) : null,
		confidence: learning.confidence,
		usedCount: learning.usedCount,
		successCount: learning.successCount,
		createdAt: learning.createdAt,
		lastUsedAt: learning.lastUsedAt || null,
	});
}

/**
 * Get all learnings
 */
export function getAllLearnings(stateDir: string = DEFAULT_STATE_DIR): Learning[] {
	const db = getDatabase(stateDir);
	const rows = db.prepare("SELECT * FROM learnings ORDER BY confidence DESC").all() as LearningRow[];
	return rows.map(rowToLearning);
}

/**
 * Get learnings by category
 */
export function getLearningsByCategory(
	category: LearningCategory,
	stateDir: string = DEFAULT_STATE_DIR,
): Learning[] {
	const db = getDatabase(stateDir);
	const rows = db
		.prepare("SELECT * FROM learnings WHERE category = ? ORDER BY confidence DESC")
		.all(category) as LearningRow[];
	return rows.map(rowToLearning);
}

/**
 * Search learnings by keywords
 */
export function searchLearningsByKeywords(
	keywords: string[],
	limit: number = 10,
	stateDir: string = DEFAULT_STATE_DIR,
): Learning[] {
	const db = getDatabase(stateDir);

	// Build query to match any keyword
	const conditions = keywords.map(() => "keywords LIKE ?").join(" OR ");
	const params = keywords.map((k) => `%"${k}"%`);

	const rows = db
		.prepare(
			`
		SELECT * FROM learnings
		WHERE ${conditions}
		ORDER BY confidence DESC
		LIMIT ?
	`,
		)
		.all(...params, limit) as LearningRow[];

	return rows.map(rowToLearning);
}

/**
 * Update learning usage stats
 */
export function updateLearningUsage(
	learningId: string,
	success: boolean,
	stateDir: string = DEFAULT_STATE_DIR,
): void {
	const db = getDatabase(stateDir);

	const stmt = db.prepare(`
		UPDATE learnings SET
			used_count = used_count + 1,
			success_count = success_count + CASE WHEN ? THEN 1 ELSE 0 END,
			confidence = CASE
				WHEN ? THEN MIN(1.0, confidence + 0.05)
				ELSE MAX(0.1, confidence - 0.02)
			END,
			last_used_at = ?
		WHERE id = ?
	`);

	stmt.run(success ? 1 : 0, success ? 1 : 0, new Date().toISOString(), learningId);
}

/**
 * Get learning by ID
 */
export function getLearningById(id: string, stateDir: string = DEFAULT_STATE_DIR): Learning | null {
	const db = getDatabase(stateDir);
	const row = db.prepare("SELECT * FROM learnings WHERE id = ?").get(id) as LearningRow | undefined;
	return row ? rowToLearning(row) : null;
}

// Row type for database results
interface LearningRow {
	id: string;
	task_id: string;
	category: string;
	content: string;
	keywords: string;
	structured: string | null;
	confidence: number;
	used_count: number;
	success_count: number;
	created_at: string;
	last_used_at: string | null;
	embedding: Buffer | null;
}

function rowToLearning(row: LearningRow): Learning {
	return {
		id: row.id,
		taskId: row.task_id,
		category: row.category as LearningCategory,
		content: row.content,
		keywords: JSON.parse(row.keywords) as string[],
		structured: row.structured ? (JSON.parse(row.structured) as Learning["structured"]) : undefined,
		confidence: row.confidence,
		usedCount: row.used_count,
		successCount: row.success_count,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at || undefined,
	};
}

// =============================================================================
// Error Pattern Operations
// =============================================================================

interface ErrorPatternRow {
	signature: string;
	category: string;
	sample_message: string;
	occurrences: number;
	fix_successes: number;
	first_seen: string;
	last_seen: string;
}

interface ErrorFixRow {
	id: number;
	signature: string;
	description: string;
	diff: string | null;
	files_changed: string;
	success_count: number;
	failure_count: number;
	recorded_at: string;
}

export interface ErrorFix {
	description: string;
	diff?: string;
	filesChanged: string[];
	successCount: number;
	failureCount: number;
	recordedAt: string;
}

export interface ErrorPattern {
	signature: string;
	category: string;
	sampleMessage: string;
	fixes: ErrorFix[];
	occurrences: number;
	fixSuccesses: number;
	firstSeen: string;
	lastSeen: string;
}

/**
 * Record or update an error pattern
 */
export function upsertErrorPattern(
	signature: string,
	category: string,
	message: string,
	stateDir: string = DEFAULT_STATE_DIR,
): void {
	const db = getDatabase(stateDir);
	const now = new Date().toISOString();

	const stmt = db.prepare(`
		INSERT INTO error_patterns (signature, category, sample_message, occurrences, first_seen, last_seen)
		VALUES (?, ?, ?, 1, ?, ?)
		ON CONFLICT(signature) DO UPDATE SET
			occurrences = occurrences + 1,
			last_seen = excluded.last_seen
	`);

	stmt.run(signature, category, message, now, now);
}

/**
 * Add a fix for an error pattern
 */
export function addErrorFix(
	signature: string,
	fix: Omit<ErrorFix, "successCount" | "failureCount" | "recordedAt">,
	stateDir: string = DEFAULT_STATE_DIR,
): void {
	const db = getDatabase(stateDir);

	const stmt = db.prepare(`
		INSERT INTO error_fixes (signature, description, diff, files_changed, success_count, failure_count, recorded_at)
		VALUES (?, ?, ?, ?, 1, 0, ?)
	`);

	stmt.run(signature, fix.description, fix.diff || null, JSON.stringify(fix.filesChanged), new Date().toISOString());
}

/**
 * Get error pattern with fixes
 */
export function getErrorPattern(signature: string, stateDir: string = DEFAULT_STATE_DIR): ErrorPattern | null {
	const db = getDatabase(stateDir);

	const patternRow = db.prepare("SELECT * FROM error_patterns WHERE signature = ?").get(signature) as
		| ErrorPatternRow
		| undefined;

	if (!patternRow) {
		return null;
	}

	const fixRows = db.prepare("SELECT * FROM error_fixes WHERE signature = ? ORDER BY success_count DESC").all(
		signature,
	) as ErrorFixRow[];

	return {
		signature: patternRow.signature,
		category: patternRow.category,
		sampleMessage: patternRow.sample_message,
		occurrences: patternRow.occurrences,
		fixSuccesses: patternRow.fix_successes,
		firstSeen: patternRow.first_seen,
		lastSeen: patternRow.last_seen,
		fixes: fixRows.map((row) => ({
			description: row.description,
			diff: row.diff || undefined,
			filesChanged: JSON.parse(row.files_changed) as string[],
			successCount: row.success_count,
			failureCount: row.failure_count,
			recordedAt: row.recorded_at,
		})),
	};
}

/**
 * Find matching fix for an error
 */
export function findMatchingFixFromDB(
	signature: string,
	stateDir: string = DEFAULT_STATE_DIR,
): ErrorFix | null {
	const db = getDatabase(stateDir);

	const row = db
		.prepare(
			`
		SELECT * FROM error_fixes
		WHERE signature = ?
		ORDER BY success_count DESC, failure_count ASC
		LIMIT 1
	`,
		)
		.get(signature) as ErrorFixRow | undefined;

	if (!row) {
		return null;
	}

	return {
		description: row.description,
		diff: row.diff || undefined,
		filesChanged: JSON.parse(row.files_changed) as string[],
		successCount: row.success_count,
		failureCount: row.failure_count,
		recordedAt: row.recorded_at,
	};
}

// =============================================================================
// Decision Operations
// =============================================================================

export interface DecisionPoint {
	id: string;
	taskId: string;
	question: string;
	options?: string[];
	context: string;
	category: DecisionCategory;
	keywords: string[];
	capturedAt: string;
}

export interface DecisionResolution {
	decisionId: string;
	resolvedBy: "auto" | "pm" | "human";
	decision: string;
	reasoning?: string;
	confidence?: ConfidenceLevel;
	resolvedAt: string;
	outcome?: "success" | "failure" | "pending";
}

interface DecisionRow {
	id: string;
	task_id: string;
	question: string;
	options: string | null;
	context: string;
	category: string;
	keywords: string;
	captured_at: string;
}

interface DecisionResolutionRow {
	decision_id: string;
	resolved_by: string;
	decision: string;
	reasoning: string | null;
	confidence: string | null;
	resolved_at: string;
	outcome: string | null;
}

/**
 * Save a decision point
 */
export function saveDecision(decision: DecisionPoint, stateDir: string = DEFAULT_STATE_DIR): void {
	const db = getDatabase(stateDir);

	const stmt = db.prepare(`
		INSERT INTO decisions (id, task_id, question, options, context, category, keywords, captured_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			question = excluded.question,
			options = excluded.options,
			context = excluded.context,
			category = excluded.category,
			keywords = excluded.keywords
	`);

	stmt.run(
		decision.id,
		decision.taskId,
		decision.question,
		decision.options ? JSON.stringify(decision.options) : null,
		decision.context,
		decision.category,
		JSON.stringify(decision.keywords),
		decision.capturedAt,
	);
}

/**
 * Save a decision resolution
 */
export function saveDecisionResolution(
	resolution: DecisionResolution,
	stateDir: string = DEFAULT_STATE_DIR,
): void {
	const db = getDatabase(stateDir);

	const stmt = db.prepare(`
		INSERT INTO decision_resolutions (decision_id, resolved_by, decision, reasoning, confidence, resolved_at, outcome)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(decision_id) DO UPDATE SET
			resolved_by = excluded.resolved_by,
			decision = excluded.decision,
			reasoning = excluded.reasoning,
			confidence = excluded.confidence,
			resolved_at = excluded.resolved_at,
			outcome = excluded.outcome
	`);

	stmt.run(
		resolution.decisionId,
		resolution.resolvedBy,
		resolution.decision,
		resolution.reasoning || null,
		resolution.confidence || null,
		resolution.resolvedAt,
		resolution.outcome || null,
	);
}

/**
 * Get pending decisions (no resolution)
 */
export function getPendingDecisions(stateDir: string = DEFAULT_STATE_DIR): DecisionPoint[] {
	const db = getDatabase(stateDir);

	const rows = db
		.prepare(
			`
		SELECT d.* FROM decisions d
		LEFT JOIN decision_resolutions r ON d.id = r.decision_id
		WHERE r.decision_id IS NULL
		ORDER BY d.captured_at DESC
	`,
		)
		.all() as DecisionRow[];

	return rows.map((row) => ({
		id: row.id,
		taskId: row.task_id,
		question: row.question,
		options: row.options ? (JSON.parse(row.options) as string[]) : undefined,
		context: row.context,
		category: row.category as DecisionCategory,
		keywords: JSON.parse(row.keywords) as string[],
		capturedAt: row.captured_at,
	}));
}

/**
 * Search resolved decisions by keywords for pattern matching
 */
export function searchResolvedDecisions(
	keywords: string[],
	limit: number = 5,
	stateDir: string = DEFAULT_STATE_DIR,
): Array<DecisionPoint & { resolution: DecisionResolution }> {
	const db = getDatabase(stateDir);

	const conditions = keywords.map(() => "d.keywords LIKE ?").join(" OR ");
	const params = keywords.map((k) => `%"${k}"%`);

	const rows = db
		.prepare(
			`
		SELECT d.*, r.resolved_by, r.decision, r.reasoning, r.confidence, r.resolved_at, r.outcome
		FROM decisions d
		JOIN decision_resolutions r ON d.id = r.decision_id
		WHERE ${conditions}
		ORDER BY r.resolved_at DESC
		LIMIT ?
	`,
		)
		.all(...params, limit) as Array<DecisionRow & DecisionResolutionRow>;

	return rows.map((row) => ({
		id: row.id,
		taskId: row.task_id,
		question: row.question,
		options: row.options ? (JSON.parse(row.options) as string[]) : undefined,
		context: row.context,
		category: row.category as DecisionCategory,
		keywords: JSON.parse(row.keywords) as string[],
		capturedAt: row.captured_at,
		resolution: {
			decisionId: row.decision_id,
			resolvedBy: row.resolved_by as "auto" | "pm" | "human",
			decision: row.decision,
			reasoning: row.reasoning || undefined,
			confidence: (row.confidence as ConfidenceLevel) || undefined,
			resolvedAt: row.resolved_at,
			outcome: (row.outcome as "success" | "failure" | "pending") || undefined,
		},
	}));
}

// =============================================================================
// Task-File Pattern Operations
// =============================================================================

export interface TaskFileRecord {
	taskId: string;
	objective: string;
	filesModified: string[];
	success: boolean;
	keywords: string[];
	recordedAt: string;
}

/**
 * Record a task-file relationship
 */
export function recordTaskFile(record: TaskFileRecord, stateDir: string = DEFAULT_STATE_DIR): void {
	const db = getDatabase(stateDir);

	const stmt = db.prepare(`
		INSERT INTO task_file_records (task_id, objective, files_modified, success, keywords, recorded_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`);

	stmt.run(
		record.taskId,
		record.objective,
		JSON.stringify(record.filesModified),
		record.success ? 1 : 0,
		JSON.stringify(record.keywords),
		record.recordedAt,
	);
}

/**
 * Update keyword correlations
 */
export function updateKeywordCorrelation(
	keyword: string,
	files: string[],
	success: boolean,
	stateDir: string = DEFAULT_STATE_DIR,
): void {
	const db = getDatabase(stateDir);

	// Get existing correlation or create new
	const existing = db.prepare("SELECT * FROM keyword_correlations WHERE keyword = ?").get(keyword) as
		| { keyword: string; files: string; task_count: number; success_count: number }
		| undefined;

	const currentFiles: Record<string, number> = existing ? (JSON.parse(existing.files) as Record<string, number>) : {};

	// Update file counts
	for (const file of files) {
		currentFiles[file] = (currentFiles[file] || 0) + 1;
	}

	const stmt = db.prepare(`
		INSERT INTO keyword_correlations (keyword, files, task_count, success_count, last_updated)
		VALUES (?, ?, 1, ?, ?)
		ON CONFLICT(keyword) DO UPDATE SET
			files = excluded.files,
			task_count = task_count + 1,
			success_count = success_count + CASE WHEN ? THEN 1 ELSE 0 END,
			last_updated = excluded.last_updated
	`);

	const now = new Date().toISOString();
	stmt.run(keyword, JSON.stringify(currentFiles), success ? 1 : 0, now, success ? 1 : 0);
}

/**
 * Get files correlated with keywords
 */
export function getCorrelatedFiles(
	keywords: string[],
	limit: number = 10,
	stateDir: string = DEFAULT_STATE_DIR,
): Array<{ file: string; score: number }> {
	const db = getDatabase(stateDir);

	// Collect file scores across all matching keywords
	const fileScores = new Map<string, number>();

	for (const keyword of keywords) {
		const row = db.prepare("SELECT files, task_count, success_count FROM keyword_correlations WHERE keyword = ?").get(
			keyword,
		) as { files: string; task_count: number; success_count: number } | undefined;

		if (row) {
			const files = JSON.parse(row.files) as Record<string, number>;
			const successRate = row.task_count > 0 ? row.success_count / row.task_count : 0.5;

			for (const [file, count] of Object.entries(files)) {
				const weight = count * (0.5 + 0.5 * successRate);
				fileScores.set(file, (fileScores.get(file) || 0) + weight);
			}
		}
	}

	// Sort by score and return top results
	return Array.from(fileScores.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([file, score]) => ({ file, score }));
}

/**
 * Update co-modification patterns
 */
export function updateCoModification(
	files: string[],
	stateDir: string = DEFAULT_STATE_DIR,
): void {
	if (files.length < 2) return;

	const db = getDatabase(stateDir);
	const now = new Date().toISOString();

	// Update pattern for each file
	for (const file of files) {
		const existing = db.prepare("SELECT * FROM co_modifications WHERE file = ?").get(file) as
			| { file: string; co_modified: string; modification_count: number }
			| undefined;

		const coModified: Record<string, number> = existing
			? (JSON.parse(existing.co_modified) as Record<string, number>)
			: {};

		// Count co-modifications with other files
		for (const otherFile of files) {
			if (otherFile !== file) {
				coModified[otherFile] = (coModified[otherFile] || 0) + 1;
			}
		}

		const stmt = db.prepare(`
			INSERT INTO co_modifications (file, co_modified, modification_count, last_updated)
			VALUES (?, ?, 1, ?)
			ON CONFLICT(file) DO UPDATE SET
				co_modified = excluded.co_modified,
				modification_count = modification_count + 1,
				last_updated = excluded.last_updated
		`);

		stmt.run(file, JSON.stringify(coModified), now);
	}
}

/**
 * Get files that are often modified together with the given file
 */
export function getCoModifiedFiles(
	file: string,
	limit: number = 5,
	stateDir: string = DEFAULT_STATE_DIR,
): Array<{ file: string; count: number }> {
	const db = getDatabase(stateDir);

	const row = db.prepare("SELECT co_modified FROM co_modifications WHERE file = ?").get(file) as
		| { co_modified: string }
		| undefined;

	if (!row) {
		return [];
	}

	const coModified = JSON.parse(row.co_modified) as Record<string, number>;

	return Object.entries(coModified)
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([f, count]) => ({ file: f, count }));
}

// =============================================================================
// Permanent Failure Operations
// =============================================================================

export interface PermanentFailure {
	signature: string;
	category: string;
	sampleMessage: string;
	taskObjective: string;
	modelUsed: string;
	attemptsCount: number;
	filesAttempted: string[];
	detailedErrors?: string[];
	recordedAt: string;
}

/**
 * Record a permanent failure
 */
export function recordPermanentFailureDB(
	failure: PermanentFailure,
	stateDir: string = DEFAULT_STATE_DIR,
): void {
	const db = getDatabase(stateDir);

	const stmt = db.prepare(`
		INSERT INTO permanent_failures (
			signature, category, sample_message, task_objective, model_used,
			attempts_count, files_attempted, detailed_errors, recorded_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	stmt.run(
		failure.signature,
		failure.category,
		failure.sampleMessage,
		failure.taskObjective,
		failure.modelUsed,
		failure.attemptsCount,
		JSON.stringify(failure.filesAttempted),
		failure.detailedErrors ? JSON.stringify(failure.detailedErrors) : null,
		failure.recordedAt,
	);
}

/**
 * Get failure patterns for warnings
 */
export function getFailurePatterns(
	keywords: string[],
	stateDir: string = DEFAULT_STATE_DIR,
): PermanentFailure[] {
	const db = getDatabase(stateDir);

	// Search by keywords in task objective
	const conditions = keywords.map(() => "task_objective LIKE ?").join(" OR ");
	const params = keywords.map((k) => `%${k}%`);

	const rows = db
		.prepare(
			`
		SELECT * FROM permanent_failures
		WHERE ${conditions}
		ORDER BY recorded_at DESC
		LIMIT 5
	`,
		)
		.all(...params) as Array<{
		signature: string;
		category: string;
		sample_message: string;
		task_objective: string;
		model_used: string;
		attempts_count: number;
		files_attempted: string;
		detailed_errors: string | null;
		recorded_at: string;
	}>;

	return rows.map((row) => ({
		signature: row.signature,
		category: row.category,
		sampleMessage: row.sample_message,
		taskObjective: row.task_objective,
		modelUsed: row.model_used,
		attemptsCount: row.attempts_count,
		filesAttempted: JSON.parse(row.files_attempted) as string[],
		detailedErrors: row.detailed_errors ? (JSON.parse(row.detailed_errors) as string[]) : undefined,
		recordedAt: row.recorded_at,
	}));
}

// =============================================================================
// Statistics
// =============================================================================

export interface StorageStats {
	learnings: { total: number; byCategory: Record<string, number> };
	errorPatterns: { total: number; totalFixes: number };
	decisions: { total: number; resolved: number; pending: number };
	taskFileRecords: number;
	permanentFailures: number;
}

/**
 * Get overall storage statistics
 */
export function getStorageStats(stateDir: string = DEFAULT_STATE_DIR): StorageStats {
	const db = getDatabase(stateDir);

	const learningsByCategory = db
		.prepare("SELECT category, COUNT(*) as count FROM learnings GROUP BY category")
		.all() as Array<{ category: string; count: number }>;

	const byCategory: Record<string, number> = {};
	let totalLearnings = 0;
	for (const row of learningsByCategory) {
		byCategory[row.category] = row.count;
		totalLearnings += row.count;
	}

	const errorPatternCount = (db.prepare("SELECT COUNT(*) as count FROM error_patterns").get() as { count: number })
		.count;
	const errorFixCount = (db.prepare("SELECT COUNT(*) as count FROM error_fixes").get() as { count: number }).count;

	const totalDecisions = (db.prepare("SELECT COUNT(*) as count FROM decisions").get() as { count: number }).count;
	const resolvedDecisions = (
		db.prepare("SELECT COUNT(*) as count FROM decision_resolutions").get() as { count: number }
	).count;

	const taskFileRecords = (db.prepare("SELECT COUNT(*) as count FROM task_file_records").get() as { count: number })
		.count;
	const permanentFailures = (db.prepare("SELECT COUNT(*) as count FROM permanent_failures").get() as { count: number })
		.count;

	return {
		learnings: { total: totalLearnings, byCategory },
		errorPatterns: { total: errorPatternCount, totalFixes: errorFixCount },
		decisions: { total: totalDecisions, resolved: resolvedDecisions, pending: totalDecisions - resolvedDecisions },
		taskFileRecords,
		permanentFailures,
	};
}

// =============================================================================
// Migration from JSON Files
// =============================================================================

export interface MigrationResult {
	learnings: number;
	errorPatterns: number;
	errorFixes: number;
	decisions: number;
	taskFileRecords: number;
	errors: string[];
}

/**
 * Migrate existing JSON data to SQLite
 * Safe to run multiple times - uses upserts where possible
 */
export function migrateFromJSON(stateDir: string = DEFAULT_STATE_DIR): MigrationResult {
	const result: MigrationResult = {
		learnings: 0,
		errorPatterns: 0,
		errorFixes: 0,
		decisions: 0,
		taskFileRecords: 0,
		errors: [],
	};

	// Migrate knowledge.json
	try {
		const knowledgePath = join(stateDir, "knowledge.json");
		if (existsSync(knowledgePath)) {
			const { readFileSync } = require("node:fs");
			const content = readFileSync(knowledgePath, "utf-8");
			const kb = JSON.parse(content) as { learnings: Learning[] };

			for (const learning of kb.learnings) {
				try {
					upsertLearning(learning, stateDir);
					result.learnings++;
				} catch (err) {
					result.errors.push(`Failed to migrate learning ${learning.id}: ${String(err)}`);
				}
			}
			logger.info({ count: result.learnings }, "Migrated learnings from knowledge.json");
		}
	} catch (err) {
		result.errors.push(`Failed to read knowledge.json: ${String(err)}`);
	}

	// Migrate error-fix-patterns.json
	try {
		const patternsPath = join(stateDir, "error-fix-patterns.json");
		if (existsSync(patternsPath)) {
			const { readFileSync } = require("node:fs");
			const content = readFileSync(patternsPath, "utf-8");
			const store = JSON.parse(content) as {
				patterns: Record<
					string,
					{
						signature: string;
						category: string;
						sampleMessage: string;
						fixes: Array<{
							description: string;
							diff?: string;
							filesChanged: string[];
							successCount: number;
							failureCount: number;
							recordedAt: string;
						}>;
						occurrences: number;
						fixSuccesses: number;
						firstSeen: string;
						lastSeen: string;
					}
				>;
				failures?: Array<{
					signature: string;
					category: string;
					sampleMessage: string;
					taskObjective: string;
					modelUsed: string;
					attemptsCount: number;
					filesAttempted: string[];
					detailedErrors?: string[];
					recordedAt: string;
				}>;
			};

			const db = getDatabase(stateDir);

			for (const pattern of Object.values(store.patterns)) {
				try {
					// Insert pattern
					db.prepare(
						`
						INSERT INTO error_patterns (signature, category, sample_message, occurrences, fix_successes, first_seen, last_seen)
						VALUES (?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT(signature) DO UPDATE SET
							occurrences = excluded.occurrences,
							fix_successes = excluded.fix_successes,
							last_seen = excluded.last_seen
					`,
					).run(
						pattern.signature,
						pattern.category,
						pattern.sampleMessage,
						pattern.occurrences,
						pattern.fixSuccesses,
						pattern.firstSeen,
						pattern.lastSeen,
					);
					result.errorPatterns++;

					// Insert fixes
					for (const fix of pattern.fixes) {
						db.prepare(
							`
							INSERT INTO error_fixes (signature, description, diff, files_changed, success_count, failure_count, recorded_at)
							VALUES (?, ?, ?, ?, ?, ?, ?)
						`,
						).run(
							pattern.signature,
							fix.description,
							fix.diff || null,
							JSON.stringify(fix.filesChanged),
							fix.successCount,
							fix.failureCount,
							fix.recordedAt,
						);
						result.errorFixes++;
					}
				} catch (err) {
					result.errors.push(`Failed to migrate error pattern ${pattern.signature}: ${String(err)}`);
				}
			}

			// Migrate failures
			if (store.failures) {
				for (const failure of store.failures) {
					try {
						recordPermanentFailureDB(failure, stateDir);
					} catch (err) {
						result.errors.push(`Failed to migrate failure ${failure.signature}: ${String(err)}`);
					}
				}
			}

			logger.info({ patterns: result.errorPatterns, fixes: result.errorFixes }, "Migrated error-fix-patterns.json");
		}
	} catch (err) {
		result.errors.push(`Failed to read error-fix-patterns.json: ${String(err)}`);
	}

	// Migrate decisions.json
	try {
		const decisionsPath = join(stateDir, "decisions.json");
		if (existsSync(decisionsPath)) {
			const { readFileSync } = require("node:fs");
			const content = readFileSync(decisionsPath, "utf-8");
			const store = JSON.parse(content) as {
				pending: DecisionPoint[];
				resolved: Array<DecisionPoint & { resolution: DecisionResolution }>;
			};

			// Migrate pending decisions
			for (const decision of store.pending) {
				try {
					saveDecision(decision, stateDir);
					result.decisions++;
				} catch (err) {
					result.errors.push(`Failed to migrate pending decision ${decision.id}: ${String(err)}`);
				}
			}

			// Migrate resolved decisions
			for (const item of store.resolved) {
				try {
					saveDecision(item, stateDir);
					saveDecisionResolution(item.resolution, stateDir);
					result.decisions++;
				} catch (err) {
					result.errors.push(`Failed to migrate resolved decision ${item.id}: ${String(err)}`);
				}
			}

			logger.info({ count: result.decisions }, "Migrated decisions.json");
		}
	} catch (err) {
		result.errors.push(`Failed to read decisions.json: ${String(err)}`);
	}

	// Migrate task-file-patterns.json
	try {
		const patternsPath = join(stateDir, "task-file-patterns.json");
		if (existsSync(patternsPath)) {
			const { readFileSync } = require("node:fs");
			const content = readFileSync(patternsPath, "utf-8");
			const store = JSON.parse(content) as {
				recentTasks: Array<{
					taskId: string;
					objective: string;
					filesModified: string[];
					success: boolean;
					keywords: string[];
					recordedAt: string;
				}>;
				keywordCorrelations: Record<
					string,
					{
						files: Record<string, number>;
						taskCount: number;
						successCount: number;
						lastUpdated?: string;
					}
				>;
				coModificationPatterns: Record<
					string,
					{
						coModified: Record<string, number>;
						modificationCount: number;
						lastUpdated?: string;
					}
				>;
			};

			const db = getDatabase(stateDir);

			// Migrate recent tasks
			for (const record of store.recentTasks) {
				try {
					recordTaskFile(record, stateDir);
					result.taskFileRecords++;
				} catch (err) {
					result.errors.push(`Failed to migrate task file record ${record.taskId}: ${String(err)}`);
				}
			}

			// Migrate keyword correlations
			for (const [keyword, data] of Object.entries(store.keywordCorrelations)) {
				try {
					db.prepare(
						`
						INSERT INTO keyword_correlations (keyword, files, task_count, success_count, last_updated)
						VALUES (?, ?, ?, ?, ?)
						ON CONFLICT(keyword) DO UPDATE SET
							files = excluded.files,
							task_count = excluded.task_count,
							success_count = excluded.success_count,
							last_updated = excluded.last_updated
					`,
					).run(keyword, JSON.stringify(data.files), data.taskCount, data.successCount, data.lastUpdated || null);
				} catch (err) {
					result.errors.push(`Failed to migrate keyword correlation ${keyword}: ${String(err)}`);
				}
			}

			// Migrate co-modification patterns
			for (const [file, data] of Object.entries(store.coModificationPatterns)) {
				try {
					db.prepare(
						`
						INSERT INTO co_modifications (file, co_modified, modification_count, last_updated)
						VALUES (?, ?, ?, ?)
						ON CONFLICT(file) DO UPDATE SET
							co_modified = excluded.co_modified,
							modification_count = excluded.modification_count,
							last_updated = excluded.last_updated
					`,
					).run(file, JSON.stringify(data.coModified), data.modificationCount, data.lastUpdated || null);
				} catch (err) {
					result.errors.push(`Failed to migrate co-modification pattern ${file}: ${String(err)}`);
				}
			}

			logger.info({ count: result.taskFileRecords }, "Migrated task-file-patterns.json");
		}
	} catch (err) {
		result.errors.push(`Failed to read task-file-patterns.json: ${String(err)}`);
	}

	return result;
}

/**
 * Check if migration is needed (JSON files exist but SQLite is empty)
 */
export function needsMigration(stateDir: string = DEFAULT_STATE_DIR): boolean {
	const stats = getStorageStats(stateDir);

	// If SQLite has data, no migration needed
	if (stats.learnings.total > 0 || stats.errorPatterns.total > 0 || stats.decisions.total > 0) {
		return false;
	}

	// Check if JSON files exist with data
	const jsonFiles = ["knowledge.json", "error-fix-patterns.json", "decisions.json", "task-file-patterns.json"];

	for (const file of jsonFiles) {
		const path = join(stateDir, file);
		if (existsSync(path)) {
			return true;
		}
	}

	return false;
}

/**
 * Auto-migrate if needed (call during initialization)
 */
export function autoMigrateIfNeeded(stateDir: string = DEFAULT_STATE_DIR): MigrationResult | null {
	if (!needsMigration(stateDir)) {
		return null;
	}

	logger.info("Detected JSON files without SQLite data, starting migration");
	const result = migrateFromJSON(stateDir);

	if (result.errors.length > 0) {
		logger.warn({ errors: result.errors }, "Migration completed with some errors");
	} else {
		logger.info(result, "Migration completed successfully");
	}

	return result;
}
