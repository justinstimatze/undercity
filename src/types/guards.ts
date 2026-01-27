/**
 * Type Guard Utilities
 *
 * Centralized type guard functions for runtime type checking.
 * Each guard performs null/undefined checks first, then validates the specific type
 * using proper runtime checks rather than weak typeof comparisons.
 *
 * All guards use TypeScript type predicates (value is Type) for proper type narrowing.
 *
 * @example
 * ```ts
 * import { isString, isObject } from "./types/guards.js";
 *
 * function processValue(value: unknown) {
 *   if (isString(value)) {
 *     // TypeScript knows value is string here
 *     console.log(value.toLowerCase());
 *   }
 *
 *   if (isObject(value)) {
 *     // TypeScript knows value is Record<string, unknown> here
 *     console.log(Object.keys(value));
 *   }
 * }
 * ```
 */

/**
 * Check if value is a string
 *
 * @param value - Value to check
 * @returns True if value is a string
 * @example
 * ```ts
 * isString("hello") // true
 * isString(null) // false
 * isString(undefined) // false
 * isString(123) // false
 * ```
 */
export function isString(value: unknown): value is string {
	return typeof value === "string";
}

/**
 * Check if value is a number (excluding NaN)
 *
 * @param value - Value to check
 * @returns True if value is a number and not NaN
 * @example
 * ```ts
 * isNumber(42) // true
 * isNumber(3.14) // true
 * isNumber(NaN) // false
 * isNumber(null) // false
 * isNumber("123") // false
 * ```
 */
export function isNumber(value: unknown): value is number {
	return typeof value === "number" && !Number.isNaN(value);
}

/**
 * Check if value is a boolean
 *
 * @param value - Value to check
 * @returns True if value is a boolean
 * @example
 * ```ts
 * isBoolean(true) // true
 * isBoolean(false) // true
 * isBoolean(null) // false
 * isBoolean(1) // false
 * isBoolean("true") // false
 * ```
 */
export function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

/**
 * Check if value is null
 *
 * @param value - Value to check
 * @returns True if value is null
 * @example
 * ```ts
 * isNull(null) // true
 * isNull(undefined) // false
 * isNull(0) // false
 * isNull("") // false
 * ```
 */
export function isNull(value: unknown): value is null {
	return value === null;
}

/**
 * Check if value is undefined
 *
 * @param value - Value to check
 * @returns True if value is undefined
 * @example
 * ```ts
 * isUndefined(undefined) // true
 * isUndefined(null) // false
 * isUndefined(0) // false
 * isUndefined("") // false
 * ```
 */
export function isUndefined(value: unknown): value is undefined {
	return value === undefined;
}

/**
 * Check if value is an array
 *
 * @param value - Value to check
 * @returns True if value is an array
 * @example
 * ```ts
 * isArray([]) // true
 * isArray([1, 2, 3]) // true
 * isArray(null) // false
 * isArray({}) // false
 * isArray("string") // false
 * ```
 */
export function isArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

/**
 * Check if value is a function
 *
 * @param value - Value to check
 * @returns True if value is a function
 * @example
 * ```ts
 * isFunction(() => {}) // true
 * isFunction(function() {}) // true
 * isFunction(null) // false
 * isFunction({}) // false
 * ```
 */
export function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === "function";
}

/**
 * Check if value is a non-null object (excluding arrays)
 *
 * This is a proper object check that excludes:
 * - null (typeof null === "object" in JavaScript)
 * - arrays (arrays are objects in JavaScript)
 * - functions (in some contexts)
 *
 * @param value - Value to check
 * @returns True if value is a non-null object
 * @example
 * ```ts
 * isObject({}) // true
 * isObject({ key: "value" }) // true
 * isObject(null) // false
 * isObject([]) // false
 * isObject("string") // false
 * isObject(42) // false
 * ```
 */
export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check if value is a Record (non-null object with string keys)
 *
 * Alias for isObject for semantic clarity when checking for key-value pairs.
 *
 * @param value - Value to check
 * @returns True if value is a Record<string, unknown>
 * @example
 * ```ts
 * isRecord({}) // true
 * isRecord({ key: "value" }) // true
 * isRecord(null) // false
 * isRecord([]) // false
 * ```
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return isObject(value);
}

/**
 * Check if value is non-null and non-undefined
 *
 * Useful for filtering out null/undefined while preserving other falsy values like 0, false, "".
 *
 * @param value - Value to check
 * @returns True if value is not null or undefined
 * @example
 * ```ts
 * isNonNullable(42) // true
 * isNonNullable("") // true
 * isNonNullable(0) // true
 * isNonNullable(false) // true
 * isNonNullable(null) // false
 * isNonNullable(undefined) // false
 * ```
 */
export function isNonNullable<T>(value: T): value is NonNullable<T> {
	return value !== null && value !== undefined;
}

/**
 * Check if value is defined (not undefined)
 *
 * Note: This returns true for null. Use isNonNullable to exclude both null and undefined.
 *
 * @param value - Value to check
 * @returns True if value is not undefined
 * @example
 * ```ts
 * isDefined(42) // true
 * isDefined(null) // true
 * isDefined(0) // true
 * isDefined(false) // true
 * isDefined(undefined) // false
 * ```
 */
export function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}
