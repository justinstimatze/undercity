#!/usr/bin/env node
/**
 * Verification CLI - Single source of truth for code verification
 *
 * Used by:
 * - Pre-commit hook (.husky/pre-commit)
 * - Worker verification (worker.ts)
 * - Manual runs (pnpm verify)
 */

import { verifyWork } from "./verification.js";

async function main() {
	const result = await verifyWork({ runTypecheck: true, runTests: true, workingDirectory: process.cwd() });

	// Print feedback
	console.log(result.feedback);

	// Exit with appropriate code
	if (!result.passed) {
		console.error("\nVerification failed. Fix issues before committing.");
		process.exit(1);
	}

	console.log("\nVerification passed.");
	process.exit(0);
}

main().catch((error) => {
	console.error("Verification error:", error);
	process.exit(1);
});
