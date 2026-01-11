import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["src/__tests__/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "json-summary"],
			include: ["src/**/*.ts"],
			exclude: [
				"src/__tests__/**",
				"src/index.ts",
				"src/cli.ts",
				"src/commands/**",
			],
			// Thresholds commented out - enable when ready to enforce
			// thresholds: {
			// 	lines: 70,
			// 	functions: 70,
			// 	branches: 70,
			// 	statements: 70,
			// },
		},
	},
});
