/**
 * Ticket Loader
 *
 * Loads rich ticket content from YAML, JSON, or Markdown files.
 * Validates ticket structure using Zod schemas.
 *
 * Supported formats:
 * - YAML (.yaml, .yml): Pure YAML ticket definition
 * - JSON (.json): Pure JSON ticket definition
 * - Markdown (.md): YAML frontmatter + markdown body (like Claude Code plans)
 */

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { TicketContent } from "./types.js";

/**
 * Schema for ticket source values
 */
const TicketSourceSchema = z.enum(["pm", "user", "research", "codebase_gap", "pattern_analysis"]);

/**
 * Schema for a ticket file
 * Includes the objective (required) plus all optional TicketContent fields
 */
export const TicketFileSchema = z.object({
	// Required: the task objective
	objective: z.string().min(1, "Objective is required"),

	// Optional: rich ticket content
	description: z.string().optional(),
	acceptanceCriteria: z.array(z.string()).optional(),
	testPlan: z.string().optional(),
	implementationNotes: z.string().optional(),
	source: TicketSourceSchema.optional(),
	researchFindings: z.array(z.string()).optional(),
	rationale: z.string().optional(),

	// Optional: task metadata
	suggestedPriority: z.number().optional(),
	tags: z.array(z.string()).optional(),
	dependsOn: z.array(z.string()).optional(),
	relatedTo: z.array(z.string()).optional(),
});

export type TicketFile = z.infer<typeof TicketFileSchema>;

/**
 * Result of loading a ticket file
 */
export interface LoadTicketResult {
	/** The task objective */
	objective: string;
	/** Priority (if specified) */
	priority?: number;
	/** Tags (if specified) */
	tags?: string[];
	/** Task IDs this task depends on (blocking) */
	dependsOn?: string[];
	/** Task IDs this task is related to (non-blocking) */
	relatedTo?: string[];
	/** Rich ticket content */
	ticket: TicketContent;
}

/**
 * Result of parsing markdown frontmatter
 */
interface FrontmatterResult {
	/** Parsed frontmatter data */
	frontmatter: Record<string, unknown>;
	/** Markdown body after frontmatter */
	body: string;
}

/**
 * Parse YAML frontmatter from markdown content
 * Frontmatter is delimited by --- at the start of the file
 *
 * Example:
 * ---
 * objective: My task
 * tags: [a, b]
 * ---
 *
 * # Markdown content here
 */
function parseMarkdownFrontmatter(content: string): FrontmatterResult | null {
	// Must start with ---
	if (!content.startsWith("---")) {
		return null;
	}

	// Find the closing ---
	const endMatch = content.slice(3).match(/\n---\r?\n/);
	if (!endMatch || endMatch.index === undefined) {
		return null;
	}

	const frontmatterEnd = endMatch.index + 3; // +3 for initial ---
	const yamlContent = content.slice(4, frontmatterEnd); // Skip opening ---\n
	const body = content.slice(frontmatterEnd + endMatch[0].length);

	try {
		// Normalize line endings (strip \r for Windows-style CRLF)
		const normalizedYaml = yamlContent.replace(/\r/g, "");
		const frontmatter = YAML.parse(normalizedYaml) as Record<string, unknown>;
		return { frontmatter, body: body.trim() };
	} catch {
		return null;
	}
}

/**
 * Extract title from markdown content (first # heading)
 */
function extractMarkdownTitle(content: string): string | null {
	const match = content.match(/^#\s+(.+)$/m);
	return match ? match[1].trim() : null;
}

/**
 * Load and parse a ticket from a YAML, JSON, or Markdown file
 *
 * For markdown files:
 * - Frontmatter contains ticket metadata (objective, tags, acceptanceCriteria, etc.)
 * - Markdown body becomes the description (unless description is in frontmatter)
 * - First # heading can be used as objective if not in frontmatter
 *
 * @param filePath Path to the ticket file (.yaml, .yml, .json, or .md)
 * @returns Parsed ticket data
 * @throws Error if file doesn't exist, can't be parsed, or fails validation
 */
export function loadTicketFromFile(filePath: string): LoadTicketResult {
	// Check file exists
	if (!existsSync(filePath)) {
		throw new Error(`Ticket file not found: ${filePath}`);
	}

	// Read file content
	const content = readFileSync(filePath, "utf-8");

	// Parse based on extension
	const ext = extname(filePath).toLowerCase();
	let parsed: unknown;

	try {
		if (ext === ".yaml" || ext === ".yml") {
			parsed = YAML.parse(content);
		} else if (ext === ".json") {
			parsed = JSON.parse(content);
		} else if (ext === ".md") {
			parsed = parseMarkdownTicket(content);
		} else {
			throw new Error(`Unsupported file extension: ${ext}. Use .yaml, .yml, .json, or .md`);
		}
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Failed to parse ${ext} file: ${error.message}`);
		}
		throw error;
	}

	// Validate with Zod
	const result = TicketFileSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
		throw new Error(`Invalid ticket file:\n${issues}`);
	}

	const data = result.data;

	// Extract TicketContent (everything except objective, suggestedPriority, tags, dependsOn, relatedTo)
	const ticket: TicketContent = {};

	if (data.description) ticket.description = data.description;
	if (data.acceptanceCriteria) ticket.acceptanceCriteria = data.acceptanceCriteria;
	if (data.testPlan) ticket.testPlan = data.testPlan;
	if (data.implementationNotes) ticket.implementationNotes = data.implementationNotes;
	if (data.source) ticket.source = data.source;
	if (data.researchFindings) ticket.researchFindings = data.researchFindings;
	if (data.rationale) ticket.rationale = data.rationale;

	return {
		objective: data.objective,
		priority: data.suggestedPriority,
		tags: data.tags,
		dependsOn: data.dependsOn,
		relatedTo: data.relatedTo,
		ticket,
	};
}

/**
 * Parse a markdown file into ticket data
 *
 * Format:
 * ---
 * objective: Task title (or use first # heading)
 * suggestedPriority: 500
 * tags: [tag1, tag2]
 * acceptanceCriteria:
 *   - Criterion 1
 *   - Criterion 2
 * testPlan: How to verify
 * implementationNotes: Implementation hints
 * rationale: Why this matters
 * source: user
 * dependsOn: [task-id-1]
 * relatedTo: [task-id-2]
 * ---
 *
 * # Optional Title (used as objective if not in frontmatter)
 *
 * Markdown body becomes the description (unless description is in frontmatter).
 */
function parseMarkdownTicket(content: string): Record<string, unknown> {
	const parsed = parseMarkdownFrontmatter(content);

	if (!parsed) {
		// No frontmatter - try to extract objective from first heading
		const title = extractMarkdownTitle(content);
		if (!title) {
			throw new Error("Markdown ticket must have YAML frontmatter or a # heading for the objective");
		}
		return {
			objective: title,
			description: content.replace(/^#\s+.+\n+/, "").trim() || undefined,
		};
	}

	const { frontmatter, body } = parsed;
	const result: Record<string, unknown> = { ...frontmatter };

	// If no objective in frontmatter, try to get from first heading in body
	if (!result.objective) {
		const title = extractMarkdownTitle(body);
		if (title) {
			result.objective = title;
		}
	}

	// If no description in frontmatter, use the markdown body
	if (!result.description && body) {
		// Remove the title heading if we used it as the objective
		let description = body;
		if (result.objective && body.startsWith(`# ${result.objective}`)) {
			description = body.replace(/^#\s+.+\n+/, "").trim();
		}
		if (description) {
			result.description = description;
		}
	}

	return result;
}

/**
 * Check if a file path looks like a ticket file
 */
export function isTicketFile(filePath: string): boolean {
	const ext = extname(filePath).toLowerCase();
	return ext === ".yaml" || ext === ".yml" || ext === ".json" || ext === ".md";
}
