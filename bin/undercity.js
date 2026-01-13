#!/usr/bin/env node
/**
 * Undercity CLI Entry Point
 *
 * This file bootstraps the TypeScript CLI using tsx or the compiled output.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Try to import the compiled version first, fall back to tsx for development
const distPath = join(__dirname, "..", "dist", "cli.js");
const srcPath = join(__dirname, "..", "src", "cli.ts");

if (existsSync(distPath)) {
	// Use compiled version
	await import(distPath);
} else if (existsSync(srcPath)) {
	// Development: use tsx to run TypeScript directly
	const { spawn } = await import("node:child_process");
	const tsx = spawn("tsx", [srcPath, ...process.argv.slice(2)], {
		stdio: "inherit",
	});
	tsx.on("exit", (code) => process.exit(code || 0));
} else {
	console.error("Error: Could not find undercity CLI. Run 'pnpm build' first.");
	process.exit(1);
}
