/**
 * Context Summarization Module
 *
 * Provides smart context extraction for agents to reduce token usage.
 * Instead of passing entire plan files to every agent, this module
 * extracts only the relevant sections each agent needs.
 *
 * Context limits by agent type:
 * - Scout: Just the goal (~1K chars)
 * - Planner: Full scout report (~10K chars)
 * - Fabricator: Implementation details only (~5K chars)
 * - Auditor: Review requirements (~3K chars)
 */

import type { AgentType } from "./types.js";

/**
 * Parsed section from a markdown plan
 */
interface PlanSection {
	heading: string;
	level: number;
	content: string;
}

/**
 * Context limits per agent type (in characters)
 */
const CONTEXT_LIMITS: Record<AgentType, number> = {
	scout: 1000,
	planner: 10000,
	fabricator: 5000,
	auditor: 3000,
};

/**
 * Keywords that indicate relevant sections for each agent type
 */
const RELEVANCE_KEYWORDS: Record<AgentType, string[]> = {
	scout: ["goal", "objective", "target", "find", "locate"],
	planner: ["scout", "intel", "findings", "structure", "files", "dependencies"],
	fabricator: [
		"implement",
		"create",
		"modify",
		"add",
		"change",
		"file",
		"code",
		"function",
		"class",
		"module",
		"step",
		"waypoint",
	],
	auditor: ["test", "verify", "check", "review", "requirement", "edge case", "security", "validation"],
};

/**
 * Parse markdown content into sections based on headings
 */
export function parseMarkdownSections(content: string): PlanSection[] {
	const sections: PlanSection[] = [];
	const lines = content.split("\n");

	let currentSection: PlanSection | null = null;
	let currentContent: string[] = [];

	for (const line of lines) {
		// Check for heading (# to ######)
		const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

		if (headingMatch) {
			// Save previous section if exists
			if (currentSection) {
				currentSection.content = currentContent.join("\n").trim();
				sections.push(currentSection);
			}

			// Start new section
			currentSection = {
				heading: headingMatch[2],
				level: headingMatch[1].length,
				content: "",
			};
			currentContent = [];
		} else {
			currentContent.push(line);
		}
	}

	// Don't forget the last section
	if (currentSection) {
		currentSection.content = currentContent.join("\n").trim();
		sections.push(currentSection);
	}

	// If no sections found, treat entire content as one section
	if (sections.length === 0 && content.trim()) {
		sections.push({
			heading: "Content",
			level: 1,
			content: content.trim(),
		});
	}

	return sections;
}

/**
 * Calculate relevance score for a section based on agent type
 */
function calculateRelevanceScore(section: PlanSection, agentType: AgentType): number {
	const keywords = RELEVANCE_KEYWORDS[agentType];
	const textToSearch = `${section.heading} ${section.content}`.toLowerCase();

	let score = 0;

	// Higher level headings are more important
	score += Math.max(0, 4 - section.level);

	// Count keyword matches
	for (const keyword of keywords) {
		if (textToSearch.includes(keyword.toLowerCase())) {
			score += 2;
		}
	}

	// Bonus for implementation-specific sections for fabricator
	if (agentType === "fabricator") {
		if (/files?\s+to\s+(modify|create|change)/i.test(textToSearch) || /implementation/i.test(section.heading)) {
			score += 5;
		}
	}

	// Bonus for test-related sections for auditor
	if (agentType === "auditor") {
		if (/test/i.test(section.heading) || /verification|validation/i.test(section.heading)) {
			score += 5;
		}
	}

	return score;
}

/**
 * Extract relevant sections for an agent type
 */
export function extractRelevantSections(sections: PlanSection[], agentType: AgentType): PlanSection[] {
	// Score each section
	const scoredSections = sections.map((section) => ({
		section,
		score: calculateRelevanceScore(section, agentType),
	}));

	// Sort by score descending
	scoredSections.sort((a, b) => b.score - a.score);

	// Take sections until we hit the limit
	const limit = CONTEXT_LIMITS[agentType];
	const relevantSections: PlanSection[] = [];
	let totalLength = 0;

	for (const { section, score } of scoredSections) {
		// Skip sections with zero relevance (unless we have nothing)
		if (score === 0 && relevantSections.length > 0) {
			continue;
		}

		const sectionLength = section.heading.length + section.content.length + 10; // +10 for formatting

		if (totalLength + sectionLength <= limit) {
			relevantSections.push(section);
			totalLength += sectionLength;
		} else if (relevantSections.length === 0) {
			// Always include at least one section (truncated if needed)
			relevantSections.push(section);
			break;
		}
	}

	return relevantSections;
}

/**
 * Format sections back into readable text
 */
export function formatSections(sections: PlanSection[]): string {
	return sections
		.map((section) => {
			const prefix = "#".repeat(section.level);
			return `${prefix} ${section.heading}\n\n${section.content}`;
		})
		.join("\n\n");
}

/**
 * Smart truncation that preserves meaningful content
 * Falls back to this when parsing fails
 */
export function smartTruncate(content: string, maxLength: number): string {
	if (content.length <= maxLength) {
		return content;
	}

	// Try to truncate at a paragraph boundary
	const truncated = content.substring(0, maxLength);
	const lastParagraph = truncated.lastIndexOf("\n\n");

	if (lastParagraph > maxLength * 0.7) {
		return truncated.substring(0, lastParagraph) + "\n\n[...truncated]";
	}

	// Try to truncate at a sentence boundary
	const lastSentence = truncated.lastIndexOf(". ");
	if (lastSentence > maxLength * 0.8) {
		return truncated.substring(0, lastSentence + 1) + "\n\n[...truncated]";
	}

	// Fall back to word boundary
	const lastSpace = truncated.lastIndexOf(" ");
	if (lastSpace > maxLength * 0.9) {
		return truncated.substring(0, lastSpace) + "...\n\n[...truncated]";
	}

	return truncated + "...\n\n[...truncated]";
}

/**
 * Main function: Summarize context for a specific agent type
 *
 * This is the primary API for the raid orchestrator to use.
 * It extracts only the relevant parts of a plan for each agent type,
 * significantly reducing token usage.
 */
export function summarizeContextForAgent(fullContext: string, agentType: AgentType, goal?: string): string {
	const limit = CONTEXT_LIMITS[agentType];

	// For scout, just return the goal
	if (agentType === "scout") {
		if (goal) {
			return smartTruncate(goal, limit);
		}
		return smartTruncate(fullContext, limit);
	}

	// Try to parse as markdown
	try {
		const sections = parseMarkdownSections(fullContext);

		if (sections.length === 0) {
			// Parsing failed, use smart truncation
			return smartTruncate(fullContext, limit);
		}

		const relevantSections = extractRelevantSections(sections, agentType);
		const formatted = formatSections(relevantSections);

		// Check if formatted content is within limit
		if (formatted.length <= limit) {
			return formatted;
		}

		// Content still too long, apply smart truncation
		return smartTruncate(formatted, limit);
	} catch {
		// Parsing error, fall back to smart truncation
		return smartTruncate(fullContext, limit);
	}
}

/**
 * Extract implementation-focused context for fabricator
 *
 * This specifically extracts:
 * - Files to modify/create
 * - Specific changes needed
 * - Code patterns to follow
 */
export function extractImplementationContext(planContent: string): string {
	const sections = parseMarkdownSections(planContent);

	// Priority headings for implementation
	const priorityPatterns = [
		/implementation/i,
		/files?\s+to/i,
		/changes?/i,
		/steps?/i,
		/waypoints?/i,
		/code/i,
		/modify/i,
		/create/i,
	];

	const implementationSections = sections.filter((section) =>
		priorityPatterns.some((pattern) => pattern.test(section.heading) || pattern.test(section.content)),
	);

	if (implementationSections.length > 0) {
		return formatSections(implementationSections);
	}

	// Fall back to full context with smart summarization
	return summarizeContextForAgent(planContent, "fabricator");
}

/**
 * Extract review-focused context for auditor
 *
 * This specifically extracts:
 * - Test requirements
 * - Edge cases to verify
 * - Security considerations
 * - Expected behavior
 */
export function extractReviewContext(planContent: string, fabricatorOutput: string): string {
	const planSections = parseMarkdownSections(planContent);

	// Priority headings for review
	const reviewPatterns = [
		/test/i,
		/verif/i,
		/valid/i,
		/edge\s+case/i,
		/security/i,
		/requirement/i,
		/expect/i,
		/check/i,
	];

	const reviewSections = planSections.filter((section) =>
		reviewPatterns.some((pattern) => pattern.test(section.heading) || pattern.test(section.content)),
	);

	let result = "";

	if (reviewSections.length > 0) {
		result += "## Review Requirements\n\n";
		result += formatSections(reviewSections);
		result += "\n\n";
	}

	// Add truncated fabricator output
	result += "## Implementation Output\n\n";
	result += smartTruncate(fabricatorOutput, 1500);

	return smartTruncate(result, CONTEXT_LIMITS.auditor);
}

/**
 * Get the context limit for an agent type
 */
export function getContextLimit(agentType: AgentType): number {
	return CONTEXT_LIMITS[agentType];
}
