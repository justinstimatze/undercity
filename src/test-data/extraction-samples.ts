/**
 * Extraction Test Samples
 *
 * Representative test cases with ground truth labels for benchmarking
 * pattern-matching vs model-based extraction approaches.
 *
 * Each sample includes:
 * - id: Unique identifier
 * - input: Raw text to extract from
 * - groundTruth: Expected extractions with labels
 * - category: Type of content (error, log, user input, etc.)
 */

/**
 * Types of extractions we're testing
 */
export type ExtractionType =
	| "file_path"
	| "error_code"
	| "line_number"
	| "variable_name"
	| "function_name"
	| "type_name"
	| "module_name"
	| "error_message"
	| "command"
	| "url"
	| "version";

/**
 * A single expected extraction with its label
 */
export interface GroundTruthItem {
	/** Type of extraction */
	type: ExtractionType;
	/** Extracted value */
	value: string;
	/** Start position in input text (optional, for span validation) */
	startPos?: number;
	/** End position in input text (optional) */
	endPos?: number;
}

/**
 * A complete test sample for extraction benchmarking
 */
export interface ExtractionSample {
	/** Unique identifier for this sample */
	id: string;
	/** Category of the input text */
	category: "error_message" | "log_output" | "user_input" | "code_snippet" | "git_output" | "security_alert";
	/** The raw input text to extract from */
	input: string;
	/** Ground truth extractions expected from this input */
	groundTruth: GroundTruthItem[];
	/** Brief description of what this sample tests */
	description: string;
}

/**
 * Complete test dataset with 15 diverse samples covering various extraction scenarios.
 * Each sample has been manually labeled with ground truth for precision/recall calculation.
 *
 * @example
 * ```typescript
 * import { EXTRACTION_SAMPLES } from "./extraction-samples.js";
 *
 * for (const sample of EXTRACTION_SAMPLES) {
 *   const extracted = runExtraction(sample.input);
 *   const metrics = calculateMetrics(extracted, sample.groundTruth);
 *   console.log(`Sample ${sample.id}: F1=${metrics.f1}`);
 * }
 * ```
 */
export const EXTRACTION_SAMPLES: ExtractionSample[] = [
	{
		id: "ts-error-001",
		category: "error_message",
		description: "TypeScript type error with file path and line number",
		input:
			"src/components/Button.tsx(42,15): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
		groundTruth: [
			{ type: "file_path", value: "src/components/Button.tsx" },
			{ type: "line_number", value: "42" },
			{ type: "error_code", value: "TS2345" },
			{ type: "type_name", value: "string" },
			{ type: "type_name", value: "number" },
		],
	},
	{
		id: "eslint-error-001",
		category: "error_message",
		description: "ESLint error with rule name",
		input:
			"Error: /home/user/project/src/utils.ts:127:5 - 'unused-variable' is defined but never used. (@typescript-eslint/no-unused-vars)",
		groundTruth: [
			{ type: "file_path", value: "/home/user/project/src/utils.ts" },
			{ type: "line_number", value: "127" },
			{ type: "variable_name", value: "unused-variable" },
			{ type: "error_code", value: "@typescript-eslint/no-unused-vars" },
		],
	},
	{
		id: "module-error-001",
		category: "error_message",
		description: "Module not found error with import path",
		input: "Error: Cannot find module './services/UserService' from 'src/controllers/AuthController.ts'",
		groundTruth: [
			{ type: "module_name", value: "./services/UserService" },
			{ type: "file_path", value: "src/controllers/AuthController.ts" },
		],
	},
	{
		id: "git-conflict-001",
		category: "git_output",
		description: "Git merge conflict output",
		input:
			"CONFLICT (content): Merge conflict in src/api/endpoints.ts\nAutomatic merge failed; fix conflicts and then commit the result.",
		groundTruth: [{ type: "file_path", value: "src/api/endpoints.ts" }],
	},
	{
		id: "test-failure-001",
		category: "log_output",
		description: "Vitest test failure with assertion",
		input:
			"FAIL src/__tests__/utils.test.ts > validateEmail > should reject invalid email\nAssertionError: expected true to be false\n    at Object.<anonymous> (src/__tests__/utils.test.ts:45:29)",
		groundTruth: [
			{ type: "file_path", value: "src/__tests__/utils.test.ts" },
			{ type: "function_name", value: "validateEmail" },
			{ type: "line_number", value: "45" },
		],
	},
	{
		id: "npm-error-001",
		category: "error_message",
		description: "npm dependency resolution error",
		input:
			'npm ERR! Could not resolve dependency: peer react@"^17.0.0" from styled-components@5.3.0\nnpm ERR! node_modules/styled-components',
		groundTruth: [
			{ type: "module_name", value: "styled-components" },
			{ type: "version", value: "5.3.0" },
			{ type: "module_name", value: "react" },
			{ type: "version", value: "^17.0.0" },
		],
	},
	{
		id: "stack-trace-001",
		category: "error_message",
		description: "Node.js stack trace with multiple file references",
		input: `TypeError: Cannot read property 'id' of undefined
    at getUserById (/app/src/services/user.ts:34:18)
    at async AuthController.login (/app/src/controllers/auth.ts:78:22)
    at async /app/node_modules/express/lib/router/index.js:284:9`,
		groundTruth: [
			{ type: "function_name", value: "getUserById" },
			{ type: "file_path", value: "/app/src/services/user.ts" },
			{ type: "line_number", value: "34" },
			{ type: "function_name", value: "AuthController.login" },
			{ type: "file_path", value: "/app/src/controllers/auth.ts" },
			{ type: "line_number", value: "78" },
		],
	},
	{
		id: "security-001",
		category: "security_alert",
		description: "Security vulnerability alert",
		input:
			"HIGH: Prototype Pollution in lodash@4.17.15 - Upgrade to lodash@4.17.21 or later. See https://nvd.nist.gov/vuln/detail/CVE-2020-8203",
		groundTruth: [
			{ type: "module_name", value: "lodash" },
			{ type: "version", value: "4.17.15" },
			{ type: "version", value: "4.17.21" },
			{ type: "url", value: "https://nvd.nist.gov/vuln/detail/CVE-2020-8203" },
			{ type: "error_code", value: "CVE-2020-8203" },
		],
	},
	{
		id: "user-input-001",
		category: "user_input",
		description: "User describing an error they encountered",
		input:
			"I'm getting an error in my React app. The file is located at components/Dashboard.jsx line 156. It says something about useState not being defined.",
		groundTruth: [
			{ type: "file_path", value: "components/Dashboard.jsx" },
			{ type: "line_number", value: "156" },
			{ type: "function_name", value: "useState" },
		],
	},
	{
		id: "build-error-001",
		category: "error_message",
		description: "Webpack build error",
		input:
			"ERROR in ./src/index.tsx 15:0-42\nModule not found: Error: Can't resolve '@mui/material/Button' in '/Users/dev/project/src'\n\nTS2307: Cannot find module '@mui/material/Button' or its corresponding type declarations.",
		groundTruth: [
			{ type: "file_path", value: "./src/index.tsx" },
			{ type: "line_number", value: "15" },
			{ type: "module_name", value: "@mui/material/Button" },
			{ type: "error_code", value: "TS2307" },
		],
	},
	{
		id: "code-snippet-001",
		category: "code_snippet",
		description: "Code snippet with function and type definitions",
		input: `function processUser(user: UserType): Promise<Result<UserDTO>> {
  const validated = validateInput(user.email);
  return userService.transform(validated);
}`,
		groundTruth: [
			{ type: "function_name", value: "processUser" },
			{ type: "type_name", value: "UserType" },
			{ type: "type_name", value: "Promise" },
			{ type: "type_name", value: "Result" },
			{ type: "type_name", value: "UserDTO" },
			{ type: "function_name", value: "validateInput" },
			{ type: "function_name", value: "userService.transform" },
		],
	},
	{
		id: "command-001",
		category: "log_output",
		description: "Command execution with paths and flags",
		input: "Running: pnpm exec vitest --config ./vitest.config.ts --coverage --reporter=verbose src/__tests__/",
		groundTruth: [
			{ type: "command", value: "pnpm exec vitest" },
			{ type: "file_path", value: "./vitest.config.ts" },
			{ type: "file_path", value: "src/__tests__/" },
		],
	},
	{
		id: "multi-error-001",
		category: "error_message",
		description: "Multiple errors in single output",
		input: `src/api.ts:23:5 - error TS2339: Property 'foo' does not exist on type 'Bar'.
src/api.ts:45:12 - error TS2551: Property 'baz' does not exist on type 'Qux'. Did you mean 'bar'?
src/utils.ts:67:8 - error TS7006: Parameter 'x' implicitly has an 'any' type.`,
		groundTruth: [
			{ type: "file_path", value: "src/api.ts" },
			{ type: "line_number", value: "23" },
			{ type: "error_code", value: "TS2339" },
			{ type: "type_name", value: "Bar" },
			{ type: "line_number", value: "45" },
			{ type: "error_code", value: "TS2551" },
			{ type: "type_name", value: "Qux" },
			{ type: "file_path", value: "src/utils.ts" },
			{ type: "line_number", value: "67" },
			{ type: "error_code", value: "TS7006" },
		],
	},
	{
		id: "docker-error-001",
		category: "error_message",
		description: "Docker build error with image reference",
		input:
			'ERROR [app 3/5] RUN npm install --production: npm ERR! code ENOENT\nnpm ERR! syscall open\nnpm ERR! path /app/package.json\nERROR: process "/bin/sh -c npm install --production" did not complete successfully: exit code: 1',
		groundTruth: [
			{ type: "file_path", value: "/app/package.json" },
			{ type: "command", value: "npm install --production" },
			{ type: "error_code", value: "ENOENT" },
		],
	},
	{
		id: "git-log-001",
		category: "git_output",
		description: "Git log with commit references",
		input:
			"commit a1b2c3d4e5f6 (HEAD -> feature/auth, origin/main)\nAuthor: developer@example.com\nDate: Mon Jan 20 2025 14:30:00 GMT\n\n    Fix authentication bug in src/auth/login.ts",
		groundTruth: [
			{ type: "file_path", value: "src/auth/login.ts" },
			{ type: "url", value: "developer@example.com" },
		],
	},
];

/**
 * Get samples filtered by category
 *
 * @param category - The category to filter by
 * @returns Array of samples matching the category
 *
 * @example
 * ```typescript
 * const errorSamples = getSamplesByCategory("error_message");
 * console.log(`Found ${errorSamples.length} error message samples`);
 * ```
 */
export function getSamplesByCategory(category: ExtractionSample["category"]): ExtractionSample[] {
	return EXTRACTION_SAMPLES.filter((sample) => sample.category === category);
}

/**
 * Get total count of expected extractions across all samples
 *
 * @returns Total number of ground truth items
 *
 * @example
 * ```typescript
 * const totalExtractions = getTotalExpectedExtractions();
 * console.log(`Dataset contains ${totalExtractions} labeled extractions`);
 * ```
 */
export function getTotalExpectedExtractions(): number {
	return EXTRACTION_SAMPLES.reduce((sum, sample) => sum + sample.groundTruth.length, 0);
}

/**
 * Get breakdown of extraction types in the dataset
 *
 * @returns Map of extraction type to count
 *
 * @example
 * ```typescript
 * const breakdown = getExtractionTypeBreakdown();
 * console.log(`File paths: ${breakdown.get("file_path")}`);
 * ```
 */
export function getExtractionTypeBreakdown(): Map<ExtractionType, number> {
	const breakdown = new Map<ExtractionType, number>();

	for (const sample of EXTRACTION_SAMPLES) {
		for (const item of sample.groundTruth) {
			const current = breakdown.get(item.type) ?? 0;
			breakdown.set(item.type, current + 1);
		}
	}

	return breakdown;
}
