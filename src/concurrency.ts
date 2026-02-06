/**
 * Concurrency Utilities
 *
 * Provides a semaphore-based concurrency limiter for batched async operations.
 * Prevents unbounded Promise.all() from overwhelming system resources.
 *
 * Used by:
 * - RAG engine batch indexing
 * - PM batch refinement
 */

/**
 * Run async tasks with a concurrency limit.
 *
 * Unlike Promise.all(), this ensures at most `limit` tasks run simultaneously.
 * Tasks are started in order and results are returned in the same order as input.
 *
 * @param tasks - Array of async task functions to execute
 * @param limit - Maximum number of concurrent tasks (default: 5)
 * @returns Results in the same order as input tasks
 */
export async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number = 5): Promise<T[]> {
	if (tasks.length === 0) return [];
	if (limit < 1) limit = 1;

	const results: T[] = new Array(tasks.length);
	let nextIndex = 0;

	async function runNext(): Promise<void> {
		while (nextIndex < tasks.length) {
			const currentIndex = nextIndex++;
			results[currentIndex] = await tasks[currentIndex]();
		}
	}

	// Start `limit` workers, each processing tasks sequentially
	const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
	await Promise.all(workers);

	return results;
}
