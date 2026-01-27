/**
 * Comprehensive Test Utilities and Mock Factories
 *
 * Provides type-safe mock factories, helper functions, and utilities for testing.
 * This module centralizes test data generation and reduces duplication across test files.
 */

import type { UndercityRc } from "../../config.js";
import type { HandoffContext, LastAttemptContext, Task } from "../../task.js";
import type {
	MetaTaskRecommendation,
	ModelChoice,
	ResearchConclusion,
	TaskCheckpoint,
	TicketContent,
	TokenUsage,
	TriageIssue,
} from "../../types.js";

// ============================================================================
// Mock File System Utilities
// ============================================================================

/**
 * Mock fs state for testing without real file system operations
 */
export interface MockFsState {
	/** Files stored as path -> content map */
	files: Map<string, string>;
	/** Directories stored as a set of paths */
	directories: Set<string>;
}

/**
 * Create a fresh mock fs state
 *
 * @returns Empty mock file system state
 * @example
 * const fsState = createMockFsState();
 * fsState.files.set('/test/file.txt', 'content');
 */
export function createMockFsState(): MockFsState {
	return {
		files: new Map<string, string>(),
		directories: new Set<string>(),
	};
}

/**
 * Create mock fs functions that operate on the given state
 *
 * @param state - The mock file system state
 * @returns Mock fs module with existsSync, readFileSync, writeFileSync, mkdirSync
 * @example
 * const state = createMockFsState();
 * const mockFs = createMockFs(state);
 * vi.mock('node:fs', () => mockFs);
 */
export function createMockFs(state: MockFsState) {
	return {
		existsSync: (path: string): boolean => {
			return state.files.has(path) || state.directories.has(path);
		},

		readFileSync: (path: string, _encoding: string): string => {
			const content = state.files.get(path);
			if (content === undefined) {
				throw new Error(`ENOENT: no such file or directory, open '${path}'`);
			}
			return content;
		},

		writeFileSync: (path: string, data: string): void => {
			state.files.set(path, data);
		},

		mkdirSync: (path: string, _options?: { recursive?: boolean }): void => {
			state.directories.add(path);
		},

		unlinkSync: (path: string): void => {
			state.files.delete(path);
		},

		readdirSync: (path: string): string[] => {
			const entries: string[] = [];
			const prefix = path.endsWith("/") ? path : `${path}/`;

			// Add matching files
			for (const filePath of state.files.keys()) {
				if (filePath.startsWith(prefix)) {
					const relative = filePath.substring(prefix.length);
					const firstSegment = relative.split("/")[0];
					if (firstSegment && !entries.includes(firstSegment)) {
						entries.push(firstSegment);
					}
				}
			}

			// Add matching directories
			for (const dirPath of state.directories) {
				if (dirPath.startsWith(prefix)) {
					const relative = dirPath.substring(prefix.length);
					const firstSegment = relative.split("/")[0];
					if (firstSegment && !entries.includes(firstSegment)) {
						entries.push(firstSegment);
					}
				}
			}

			return entries;
		},
	};
}

/**
 * Reset mock storage state for isolation between tests
 *
 * @param state - The mock file system state to reset
 * @example
 * afterEach(() => {
 *   resetMockStorage(fsState);
 * });
 */
export function resetMockStorage(state: MockFsState): void {
	state.files.clear();
	state.directories.clear();
}

/**
 * Get mock storage statistics for debugging
 *
 * @param state - The mock file system state
 * @returns Object with file count and directory count
 * @example
 * const stats = getMockStorage(fsState);
 * console.log(`Files: ${stats.fileCount}, Dirs: ${stats.dirCount}`);
 */
export function getMockStorage(state: MockFsState): { fileCount: number; dirCount: number } {
	return {
		fileCount: state.files.size,
		dirCount: state.directories.size,
	};
}

// ============================================================================
// Task Mock Factories
// ============================================================================

/**
 * Create a mock Task with type-safe overrides
 *
 * @param overrides - Partial Task properties to override defaults
 * @returns Complete Task object with sensible defaults
 * @example
 * const task = createMockTask({
 *   objective: 'Add feature X',
 *   status: 'in_progress',
 *   priority: 5
 * });
 */
export function createMockTask(overrides: Partial<Task> = {}): Task {
	const defaultTask: Task = {
		id: "task-test-123",
		objective: "Test task objective",
		status: "pending",
		priority: 3,
		createdAt: new Date("2024-01-01T00:00:00.000Z"),
		startedAt: undefined,
		completedAt: undefined,
		sessionId: undefined,
		error: undefined,
		resolution: undefined,
		duplicateOfCommit: undefined,
		packageHints: undefined,
		dependsOn: undefined,
		relatedTo: undefined,
		conflicts: undefined,
		estimatedFiles: undefined,
		tags: undefined,
		computedPackages: undefined,
		riskScore: undefined,
		parentId: undefined,
		subtaskIds: undefined,
		isDecomposed: undefined,
		decompositionDepth: undefined,
		handoffContext: undefined,
		lastAttempt: undefined,
		researchConclusion: undefined,
		ticket: undefined,
		triageIssues: undefined,
		triageUpdatedAt: undefined,
	};

	return {
		...defaultTask,
		...overrides,
	};
}

/**
 * Create a mock TicketContent with type-safe overrides
 *
 * @param overrides - Partial TicketContent properties to override defaults
 * @returns Complete TicketContent object
 * @example
 * const ticket = createMockTicket({
 *   description: 'Full description of task',
 *   acceptanceCriteria: ['Criterion 1', 'Criterion 2']
 * });
 */
export function createMockTicket(overrides: Partial<TicketContent> = {}): TicketContent {
	return {
		description: "Test task description with full context",
		acceptanceCriteria: ["Task completes successfully", "All tests pass"],
		testPlan: "Run test suite and verify output",
		implementationNotes: "Follow existing patterns in the codebase",
		source: "user",
		researchFindings: undefined,
		rationale: "This task is needed to improve system functionality",
		...overrides,
	};
}

/**
 * Create a mock HandoffContext with type-safe overrides
 *
 * @param overrides - Partial HandoffContext properties to override defaults
 * @returns Complete HandoffContext object
 * @example
 * const handoff = createMockHandoffContext({
 *   filesRead: ['src/main.ts', 'src/utils.ts'],
 *   decisions: ['Use strategy pattern', 'Add validation layer']
 * });
 */
export function createMockHandoffContext(overrides: Partial<HandoffContext> = {}): HandoffContext {
	return {
		filesRead: [],
		decisions: [],
		codeContext: undefined,
		notes: undefined,
		lastAttempt: undefined,
		isRetry: false,
		humanGuidance: undefined,
		previousError: undefined,
		previousAttempts: 0,
		...overrides,
	};
}

/**
 * Create a mock LastAttemptContext with type-safe overrides
 *
 * @param overrides - Partial LastAttemptContext properties to override defaults
 * @returns Complete LastAttemptContext object
 * @example
 * const lastAttempt = createMockLastAttempt({
 *   category: 'typecheck',
 *   error: 'Type error in src/main.ts'
 * });
 */
export function createMockLastAttempt(overrides: Partial<LastAttemptContext> = {}): LastAttemptContext {
	return {
		model: "sonnet",
		category: "typecheck",
		error: "Mock error from last attempt",
		filesModified: [],
		attemptedAt: new Date("2024-01-01T00:00:00.000Z"),
		attemptCount: 1,
		...overrides,
	};
}

/**
 * Create a mock TaskCheckpoint with type-safe overrides
 *
 * @param overrides - Partial TaskCheckpoint properties to override defaults
 * @returns Complete TaskCheckpoint object
 * @example
 * const checkpoint = createMockCheckpoint({
 *   phase: 'executing',
 *   attempts: 2
 * });
 */
export function createMockCheckpoint(overrides: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
	return {
		phase: "starting",
		model: "sonnet",
		attempts: 1,
		savedAt: new Date("2024-01-01T00:00:00.000Z"),
		lastVerification: undefined,
		...overrides,
	};
}

/**
 * Create a mock ResearchConclusion with type-safe overrides
 *
 * @param overrides - Partial ResearchConclusion properties to override defaults
 * @returns Complete ResearchConclusion object
 * @example
 * const conclusion = createMockResearchConclusion({
 *   outcome: 'implement',
 *   proposalsGenerated: 3
 * });
 */
export function createMockResearchConclusion(overrides: Partial<ResearchConclusion> = {}): ResearchConclusion {
	return {
		outcome: "implement",
		rationale: "Research indicates this approach is viable",
		noveltyScore: 0.7,
		proposalsGenerated: 2,
		linkedDecisionId: undefined,
		linkedTaskIds: undefined,
		concludedAt: new Date("2024-01-01T00:00:00.000Z").toISOString(),
		...overrides,
	};
}

/**
 * Create a mock TriageIssue with type-safe overrides
 *
 * @param overrides - Partial TriageIssue properties to override defaults
 * @returns Complete TriageIssue object
 * @example
 * const issue = createMockTriageIssue({
 *   type: 'duplicate',
 *   relatedTaskIds: ['task-123', 'task-456']
 * });
 */
export function createMockTriageIssue(overrides: Partial<TriageIssue> = {}): TriageIssue {
	return {
		type: "vague",
		reason: "Task objective lacks specificity",
		action: "review",
		relatedTaskIds: undefined,
		detectedAt: new Date("2024-01-01T00:00:00.000Z"),
		...overrides,
	};
}

// ============================================================================
// Config Mock Factories
// ============================================================================

/**
 * Create a mock UndercityRc config with type-safe overrides
 *
 * @param overrides - Partial UndercityRc properties to override defaults
 * @returns Complete UndercityRc object
 * @example
 * const config = createMockConfig({
 *   verbose: true,
 *   model: 'opus'
 * });
 */
export function createMockConfig(overrides: Partial<UndercityRc> = {}): UndercityRc {
	return {
		stream: false,
		verbose: false,
		model: "sonnet",
		worker: "sonnet",
		autoCommit: true,
		typecheck: true,
		local: true,
		review: false,
		multiLens: false,
		supervised: false,
		parallel: 1,
		push: false,
		maxAttempts: 7,
		maxRetriesPerTier: 3,
		maxReviewPassesPerTier: 2,
		maxOpusReviewPasses: 6,
		...overrides,
	};
}

// ============================================================================
// Token Usage Mock Factories
// ============================================================================

/**
 * Create a mock TokenUsage with type-safe overrides
 *
 * @param overrides - Partial TokenUsage properties to override defaults
 * @returns Complete TokenUsage object
 * @example
 * const usage = createMockTokenUsage({
 *   inputTokens: 1000,
 *   outputTokens: 500
 * });
 */
export function createMockTokenUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
	const inputTokens = overrides.inputTokens ?? 1000;
	const outputTokens = overrides.outputTokens ?? 500;
	const totalTokens = overrides.totalTokens ?? inputTokens + outputTokens;
	const model = overrides.model ?? "sonnet";
	const multiplier = model === "opus" ? 5 : 1;
	const sonnetEquivalentTokens = overrides.sonnetEquivalentTokens ?? totalTokens * multiplier;

	return {
		inputTokens,
		outputTokens,
		totalTokens,
		model,
		timestamp: new Date("2024-01-01T00:00:00.000Z"),
		sonnetEquivalentTokens,
		...overrides,
	};
}

// ============================================================================
// Meta-Task Mock Factories
// ============================================================================

/**
 * Create a mock MetaTaskRecommendation with type-safe overrides
 *
 * @param overrides - Partial MetaTaskRecommendation properties to override defaults
 * @returns Complete MetaTaskRecommendation object
 * @example
 * const recommendation = createMockRecommendation({
 *   action: 'remove',
 *   reason: 'Task is duplicate',
 *   confidence: 0.9
 * });
 */
export function createMockRecommendation(overrides: Partial<MetaTaskRecommendation> = {}): MetaTaskRecommendation {
	return {
		action: "update",
		taskId: "task-test-123",
		relatedTaskIds: undefined,
		reason: "Recommendation reason",
		confidence: 0.8,
		newTask: undefined,
		updates: undefined,
		...overrides,
	};
}

// ============================================================================
// Test Sample Helpers with Ground Truth
// ============================================================================

/**
 * Test sample with ground truth labels for extraction benchmarks
 */
export interface TestSample {
	/** Unique identifier for the sample */
	id: string;
	/** Category of test sample */
	category: "simple" | "complex" | "edge_case" | "malformed";
	/** Input data for extraction */
	input: string;
	/** Expected/correct output (ground truth) */
	expectedOutput: unknown;
	/** Description of what this sample tests */
	description: string;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Create a test sample with ground truth labels
 *
 * @param overrides - Partial TestSample properties to override defaults
 * @returns Complete TestSample object
 * @example
 * const sample = createTestSample({
 *   category: 'complex',
 *   input: 'complex input data',
 *   expectedOutput: { key: 'value' }
 * });
 */
export function createTestSample(overrides: Partial<TestSample> = {}): TestSample {
	return {
		id: "sample-1",
		category: "simple",
		input: "test input",
		expectedOutput: { result: "expected" },
		description: "Test sample description",
		metadata: undefined,
		...overrides,
	};
}

/**
 * Get test samples filtered by category
 *
 * @param samples - Array of test samples
 * @param category - Category to filter by
 * @returns Filtered array of samples
 * @example
 * const complexSamples = getSamplesByCategory(allSamples, 'complex');
 */
export function getSamplesByCategory(samples: TestSample[], category: TestSample["category"]): TestSample[] {
	return samples.filter((sample) => sample.category === category);
}

/**
 * Get breakdown of samples by category
 *
 * @param samples - Array of test samples
 * @returns Object with counts per category
 * @example
 * const breakdown = getExtractionTypeBreakdown(samples);
 * console.log(`Simple: ${breakdown.simple}, Complex: ${breakdown.complex}`);
 */
export function getExtractionTypeBreakdown(samples: TestSample[]): Record<TestSample["category"], number> {
	const breakdown: Record<TestSample["category"], number> = {
		simple: 0,
		complex: 0,
		edge_case: 0,
		malformed: 0,
	};

	for (const sample of samples) {
		breakdown[sample.category]++;
	}

	return breakdown;
}

/**
 * Calculate precision and recall metrics from test results
 *
 * @param results - Array of test results with actual and expected outputs
 * @returns Object with precision, recall, and f1 score
 * @example
 * const metrics = calculatePrecisionRecall(testResults);
 * console.log(`Precision: ${metrics.precision.toFixed(2)}`);
 */
export function calculatePrecisionRecall(results: Array<{ expected: unknown; actual: unknown; isCorrect: boolean }>): {
	precision: number;
	recall: number;
	f1Score: number;
	totalSamples: number;
	correctSamples: number;
} {
	const totalSamples = results.length;
	const correctSamples = results.filter((r) => r.isCorrect).length;

	// For simplicity, treating this as binary classification
	// In a real scenario, you'd calculate true positives, false positives, etc.
	const precision = totalSamples > 0 ? correctSamples / totalSamples : 0;
	const recall = precision; // Simplified for this mock
	const f1Score = precision > 0 || recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

	return {
		precision,
		recall,
		f1Score,
		totalSamples,
		correctSamples,
	};
}

// ============================================================================
// Mock API Response Helpers
// ============================================================================

/**
 * Mock API response for model-based extraction
 */
export interface MockApiResponse<T = unknown> {
	success: boolean;
	data?: T;
	error?: string;
	tokensUsed?: number;
	model?: ModelChoice;
}

/**
 * Create a successful mock API response
 *
 * @param data - Response data
 * @param tokensUsed - Optional token count
 * @param model - Optional model used
 * @returns Mock API response object
 * @example
 * const response = createMockApiSuccess({ result: 'extracted data' }, 150, 'sonnet');
 */
export function createMockApiSuccess<T>(data: T, tokensUsed = 100, model: ModelChoice = "sonnet"): MockApiResponse<T> {
	return {
		success: true,
		data,
		tokensUsed,
		model,
	};
}

/**
 * Create a failed mock API response
 *
 * @param error - Error message
 * @param model - Optional model used
 * @returns Mock API response object
 * @example
 * const response = createMockApiError('Rate limit exceeded', 'opus');
 */
export function createMockApiError(error: string, model: ModelChoice = "sonnet"): MockApiResponse {
	return {
		success: false,
		error,
		model,
	};
}

// ============================================================================
// Type Guards and Validators
// ============================================================================

/**
 * Type guard to check if a value is a valid Task
 *
 * @param value - Value to check
 * @returns True if value is a Task
 * @example
 * if (isTask(obj)) {
 *   console.log(obj.objective);
 * }
 */
export function isTask(value: unknown): value is Task {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;
	return (
		typeof obj.id === "string" &&
		typeof obj.objective === "string" &&
		typeof obj.status === "string" &&
		obj.createdAt instanceof Date
	);
}

/**
 * Type guard to check if a value is a valid TicketContent
 *
 * @param value - Value to check
 * @returns True if value is a TicketContent
 * @example
 * if (isTicketContent(obj)) {
 *   console.log(obj.description);
 * }
 */
export function isTicketContent(value: unknown): value is TicketContent {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;
	// TicketContent has all optional fields, so we just check structure
	return obj.description === undefined || typeof obj.description === "string";
}

/**
 * Type guard to check if a value is a valid TokenUsage
 *
 * @param value - Value to check
 * @returns True if value is a TokenUsage
 * @example
 * if (isTokenUsage(obj)) {
 *   console.log(obj.totalTokens);
 * }
 */
export function isTokenUsage(value: unknown): value is TokenUsage {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const obj = value as Record<string, unknown>;
	return (
		typeof obj.inputTokens === "number" &&
		typeof obj.outputTokens === "number" &&
		typeof obj.totalTokens === "number" &&
		typeof obj.sonnetEquivalentTokens === "number"
	);
}

// ============================================================================
// Date Mocking Helpers
// ============================================================================

/**
 * Create a controlled date for consistent testing
 *
 * @param isoString - Optional ISO date string, defaults to fixed date
 * @returns Date object
 * @example
 * const fixedDate = createMockDate('2024-06-15T10:00:00.000Z');
 */
export function createMockDate(isoString = "2024-01-01T00:00:00.000Z"): Date {
	return new Date(isoString);
}

/**
 * Advance a mock date by specified milliseconds
 *
 * @param date - Date to advance
 * @param ms - Milliseconds to add
 * @returns New date object
 * @example
 * const later = advanceMockDate(now, 60000); // 1 minute later
 */
export function advanceMockDate(date: Date, ms: number): Date {
	return new Date(date.getTime() + ms);
}
