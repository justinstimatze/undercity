/**
 * Custom Error Classes
 *
 * Domain-specific error types with proper Error subclassing and context properties.
 * All custom error classes in the application extend the base AppError class.
 */

/**
 * Base application error class
 *
 * All custom error classes in the application extend this base class.
 * Uses Object.setPrototypeOf() to ensure instanceof checks work correctly
 * after TypeScript transpilation to ES5.
 *
 * @param message - Error message
 * @param code - Error code for categorization (e.g., 'VALIDATION_ERROR')
 *
 * @example
 * ```typescript
 * throw new AppError('Something went wrong', 'GENERIC_ERROR');
 * ```
 */
export class AppError extends Error {
	constructor(
		message: string,
		public readonly code: string,
	) {
		super(message);
		this.name = "AppError";
		// Critical for instanceof checks in transpiled code
		Object.setPrototypeOf(this, AppError.prototype);
	}
}

/**
 * Validation error for invalid input or state
 *
 * Thrown when user input or internal state fails validation checks.
 * Includes the field that failed validation and optional validation error details.
 *
 * @param message - Error message describing the validation failure
 * @param field - The field or property that failed validation
 * @param validationErrors - Optional array of specific validation error details
 *
 * @example
 * ```typescript
 * if (!email.includes('@')) {
 *   throw new ValidationError('Invalid email format', 'email', ['Must contain @']);
 * }
 * ```
 */
export class ValidationError extends AppError {
	constructor(
		message: string,
		public readonly field: string,
		public readonly validationErrors?: string[],
	) {
		super(message, "VALIDATION_ERROR");
		this.name = "ValidationError";
		Object.setPrototypeOf(this, ValidationError.prototype);
	}
}

/**
 * Invalid input error
 *
 * Thrown when input data is malformed, missing required fields, or fails parsing.
 * Used for input-related failures that are distinct from validation rule violations.
 *
 * @param message - Error message describing the invalid input
 * @param input - The invalid input value (truncated if too long)
 * @param errorCode - Optional specific error code (e.g., 'MISSING_FIELD', 'MALFORMED_JSON')
 *
 * @example
 * ```typescript
 * try {
 *   JSON.parse(userInput);
 * } catch (err) {
 *   throw new InvalidInputError('Failed to parse JSON', userInput, 'MALFORMED_JSON');
 * }
 * ```
 */
export class InvalidInputError extends AppError {
	constructor(
		message: string,
		public readonly input?: unknown,
		errorCode?: string,
	) {
		super(message, errorCode ?? "INVALID_INPUT");
		this.name = "InvalidInputError";
		Object.setPrototypeOf(this, InvalidInputError.prototype);
	}
}

/**
 * User-facing error
 *
 * Thrown for errors that should be displayed to end users with user-friendly messages.
 * These errors indicate user actions that cannot be completed rather than system failures.
 *
 * @param message - User-friendly error message (will be shown to user)
 * @param action - The action the user was attempting (e.g., 'login', 'create_task')
 * @param errorCode - Optional specific error code for categorization
 *
 * @example
 * ```typescript
 * if (!userExists) {
 *   throw new UserError('User not found. Please check the username.', 'login', 'USER_NOT_FOUND');
 * }
 * ```
 */
export class UserError extends AppError {
	constructor(
		message: string,
		public readonly action?: string,
		errorCode?: string,
	) {
		super(message, errorCode ?? "USER_ERROR");
		this.name = "UserError";
		Object.setPrototypeOf(this, UserError.prototype);
	}
}

/**
 * Database operation error
 *
 * Thrown when database operations fail (query errors, connection issues, etc.).
 * Includes the failed query and operation type for debugging.
 *
 * @param message - Error message describing the database failure
 * @param operation - The type of database operation (e.g., 'SELECT', 'INSERT', 'UPDATE')
 * @param query - Optional SQL query or operation details
 *
 * @example
 * ```typescript
 * try {
 *   await db.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
 * } catch (err) {
 *   throw new DatabaseError('Failed to fetch task', 'SELECT', err.message);
 * }
 * ```
 */
export class DatabaseError extends AppError {
	constructor(
		message: string,
		public readonly operation: string,
		public readonly query?: string,
	) {
		super(message, "DATABASE_ERROR");
		this.name = "DatabaseError";
		Object.setPrototypeOf(this, DatabaseError.prototype);
	}
}

/**
 * Timeout error for operations that exceed time limits
 *
 * Thrown when an operation takes longer than the allowed timeout period.
 * Includes the timeout value and operation details.
 *
 * @param message - Error message describing the timeout
 * @param operation - The operation that timed out (e.g., 'fetch', 'git clone')
 * @param timeoutMs - Timeout duration in milliseconds
 *
 * @example
 * ```typescript
 * const controller = new AbortController();
 * setTimeout(() => controller.abort(), 5000);
 * try {
 *   await fetch(url, { signal: controller.signal });
 * } catch (err) {
 *   throw new TimeoutError('API request timed out', 'fetch', 5000);
 * }
 * ```
 */
export class TimeoutError extends AppError {
	constructor(
		message: string,
		public readonly operation: string,
		public readonly timeoutMs: number,
	) {
		super(message, "TIMEOUT_ERROR");
		this.name = "TimeoutError";
		Object.setPrototypeOf(this, TimeoutError.prototype);
	}
}

/**
 * Git worktree operation error
 *
 * Thrown when git worktree operations fail (create, remove, etc.).
 * Includes the git command that failed and optional exit code.
 *
 * @param message - Error message describing the worktree failure
 * @param command - The git command that failed
 * @param exitCode - Optional exit code from the failed command
 *
 * @example
 * ```typescript
 * try {
 *   execGit(['worktree', 'add', path, branch]);
 * } catch (err) {
 *   throw new WorktreeError('Failed to create worktree', 'git worktree add', 1);
 * }
 * ```
 */
export class WorktreeError extends AppError {
	constructor(
		message: string,
		public readonly command: string,
		public readonly exitCode?: number,
	) {
		super(message, "WORKTREE_ERROR");
		this.name = "WorktreeError";
		Object.setPrototypeOf(this, WorktreeError.prototype);
	}
}
