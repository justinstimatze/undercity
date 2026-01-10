/**
 * Plan Parser Module
 *
 * Parses plan files into discrete waypoints upfront instead of re-reading the whole
 * plan each iteration. Supports markdown-style plan files with sections and waypoints.
 */

export interface ParsedTask {
	id: string;
	content: string;
	section?: string;
	sectionPriority?: number;
	lineNumber: number;
	completed: boolean;
}

export interface ParsedPlan {
	filePath: string;
	title?: string;
	waypoints: ParsedTask[];
	sections: PlanSection[];
	rawContent: string;
	parsedAt: Date;
}

export interface PlanSection {
	name: string;
	priority: number;
	startLine: number;
	endLine: number;
}

// Priority keywords that appear in section headers
const PRIORITY_KEYWORDS: Record<string, number> = {
	critical: 1,
	urgent: 2,
	high: 3,
	medium: 4,
	low: 5,
	future: 6,
	completed: 99, // Skip completed sections
	done: 99,
};

/**
 * Generate a unique waypoint ID
 */
function generateTaskId(lineNumber: number): string {
	const timestamp = Date.now().toString(36);
	return `waypoint-${timestamp}-L${lineNumber}`;
}

/**
 * Extract priority from a section header
 */
function extractSectionPriority(sectionName: string): number {
	const lowerName = sectionName.toLowerCase();
	for (const [keyword, priority] of Object.entries(PRIORITY_KEYWORDS)) {
		if (lowerName.includes(keyword)) {
			return priority;
		}
	}
	return 4; // Default to medium priority
}

/**
 * Check if a line is a section header
 * Supports:
 * - Markdown headers: # Section, ## Section
 * - Decorated headers: # === Section ===, # ============
 */
function isSectionHeader(line: string): { isHeader: boolean; name?: string } {
	const trimmed = line.trim();

	// Markdown style headers: # Title or ## Title
	if (/^#{1,3}\s+[^#=]/.test(trimmed)) {
		const name = trimmed.replace(/^#+\s*/, "").trim();
		return { isHeader: true, name };
	}

	// Decorated section headers: # === SECTION NAME ===
	// or lines that are just decorators before a section name
	if (/^#\s*=+\s*[A-Z]/.test(trimmed)) {
		const name = trimmed
			.replace(/^#\s*=*\s*/, "")
			.replace(/\s*=*\s*$/, "")
			.trim();
		return { isHeader: true, name };
	}

	// Pure decorator line (like # =============) - skip but mark as potential section boundary
	if (/^#\s*=+\s*$/.test(trimmed)) {
		return { isHeader: false };
	}

	return { isHeader: false };
}

/**
 * Check if a line is a waypoint (not a comment, not empty, not a header)
 */
function isTaskLine(line: string): boolean {
	const trimmed = line.trim();

	// Empty lines are not waypoints
	if (!trimmed) return false;

	// Lines starting with # are comments or headers, not waypoints
	if (trimmed.startsWith("#")) return false;

	// Lines that are just decorators or markers
	if (/^[-=_*]+$/.test(trimmed)) return false;

	// Markdown list items are waypoints
	if (/^[-*+]\s+/.test(trimmed)) return true;

	// Numbered items are waypoints
	if (/^\d+[.)]\s+/.test(trimmed)) return true;

	// Checkbox items (markdown todo) are waypoints
	if (/^[-*]\s*\[[ x]\]\s+/i.test(trimmed)) return true;

	// Plain text lines that aren't obviously metadata
	// Must have at least 10 characters to be considered a waypoint
	if (trimmed.length >= 10 && /[a-zA-Z]/.test(trimmed)) return true;

	return false;
}

/**
 * Clean waypoint content - remove list markers, checkboxes, etc.
 */
function cleanTaskContent(line: string): { content: string; completed: boolean } {
	let content = line.trim();
	let completed = false;

	// Remove checkbox markers and detect completion
	const checkboxMatch = content.match(/^[-*]\s*\[([ x])\]\s+/i);
	if (checkboxMatch) {
		completed = checkboxMatch[1].toLowerCase() === "x";
		content = content.replace(/^[-*]\s*\[[ x]\]\s+/i, "");
	}

	// Remove list markers (-, *, +)
	content = content.replace(/^[-*+]\s+/, "");

	// Remove numbered list markers (1. or 1))
	content = content.replace(/^\d+[.)]\s+/, "");

	// Check for [DONE] or [COMPLETE] markers
	if (/^\[(?:DONE|COMPLETE|COMPLETED)\]/i.test(content)) {
		completed = true;
		content = content.replace(/^\[(?:DONE|COMPLETE|COMPLETED)\]\s*/i, "");
	}

	return { content: content.trim(), completed };
}

/**
 * Parse a plan file into discrete waypoints
 */
export function parsePlanFile(content: string, filePath: string = "unknown"): ParsedPlan {
	const lines = content.split("\n");
	const waypoints: ParsedTask[] = [];
	const sections: PlanSection[] = [];

	let currentSection: { name: string; priority: number; startLine: number } | null = null;
	let planTitle: string | undefined;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNumber = i + 1; // 1-indexed for human readability

		// Check for section header
		const headerCheck = isSectionHeader(line);
		if (headerCheck.isHeader && headerCheck.name) {
			// Close previous section
			if (currentSection) {
				sections.push({
					...currentSection,
					endLine: lineNumber - 1,
				});
			}

			// First header could be the plan title
			if (!planTitle && sections.length === 0 && !currentSection) {
				planTitle = headerCheck.name;
			}

			const priority = extractSectionPriority(headerCheck.name);
			currentSection = {
				name: headerCheck.name,
				priority,
				startLine: lineNumber,
			};
			continue;
		}

		// Check for waypoint line
		if (isTaskLine(line)) {
			const { content: taskContent, completed } = cleanTaskContent(line);

			// Skip waypoints in "completed" sections
			const inCompletedSection = currentSection && currentSection.priority >= 99;

			if (!inCompletedSection && taskContent) {
				waypoints.push({
					id: generateTaskId(lineNumber),
					content: taskContent,
					section: currentSection?.name,
					sectionPriority: currentSection?.priority,
					lineNumber,
					completed,
				});
			}
		}
	}

	// Close final section
	if (currentSection) {
		sections.push({
			...currentSection,
			endLine: lines.length,
		});
	}

	return {
		filePath,
		title: planTitle,
		waypoints,
		sections,
		rawContent: content,
		parsedAt: new Date(),
	};
}

/**
 * Get pending (non-completed) waypoints from a parsed plan
 */
export function getPendingTasks(plan: ParsedPlan): ParsedTask[] {
	return plan.waypoints.filter((waypoint) => !waypoint.completed);
}

/**
 * Get waypoints sorted by priority (section priority, then line number)
 */
export function getTasksByPriority(plan: ParsedPlan): ParsedTask[] {
	return [...plan.waypoints].sort((a, b) => {
		// First sort by section priority
		const priorityA = a.sectionPriority ?? 4;
		const priorityB = b.sectionPriority ?? 4;
		if (priorityA !== priorityB) {
			return priorityA - priorityB;
		}
		// Then by line number (earlier in file = earlier in execution)
		return a.lineNumber - b.lineNumber;
	});
}

/**
 * Get the next waypoint to execute from a parsed plan
 */
export function getNextTask(plan: ParsedPlan): ParsedTask | undefined {
	const pendingByPriority = getTasksByPriority(plan).filter((t) => !t.completed);
	return pendingByPriority[0];
}

/**
 * Mark a waypoint as completed by ID
 */
export function markTaskCompleted(plan: ParsedPlan, waypointId: string): ParsedPlan {
	return {
		...plan,
		waypoints: plan.waypoints.map((waypoint) =>
			waypoint.id === waypointId ? { ...waypoint, completed: true } : waypoint,
		),
	};
}

/**
 * Get plan progress summary
 */
export function getPlanProgress(plan: ParsedPlan): {
	total: number;
	completed: number;
	pending: number;
	percentComplete: number;
	bySections: Array<{ section: string; total: number; completed: number }>;
} {
	const total = plan.waypoints.length;
	const completed = plan.waypoints.filter((t) => t.completed).length;
	const pending = total - completed;

	// Group by section
	const sectionMap = new Map<string, { total: number; completed: number }>();
	for (const waypoint of plan.waypoints) {
		const section = waypoint.section || "Uncategorized";
		const current = sectionMap.get(section) || { total: 0, completed: 0 };
		current.total++;
		if (waypoint.completed) current.completed++;
		sectionMap.set(section, current);
	}

	const bySections = Array.from(sectionMap.entries()).map(([section, stats]) => ({
		section,
		...stats,
	}));

	return {
		total,
		completed,
		pending,
		percentComplete: total > 0 ? Math.round((completed / total) * 100) : 0,
		bySections,
	};
}

/**
 * Generate a focused context for an agent based on current waypoint
 * Instead of passing the whole plan, we pass:
 * - The current waypoint
 * - Recent completed waypoints (for context)
 * - Upcoming waypoints in same section (for awareness)
 */
export function generateTaskContext(plan: ParsedPlan, currentTaskId: string): string {
	const currentTask = plan.waypoints.find((t) => t.id === currentTaskId);
	if (!currentTask) {
		return "No current waypoint found.";
	}

	const progress = getPlanProgress(plan);
	const sectionTasks = plan.waypoints.filter((t) => t.section === currentTask.section);
	const completedInSection = sectionTasks.filter((t) => t.completed).map((t) => t.content);
	const upcomingInSection = sectionTasks.filter((t) => !t.completed && t.id !== currentTaskId).map((t) => t.content);

	let context = `## Current Waypoint\n${currentTask.content}\n\n`;
	context += `## Progress\n${progress.completed}/${progress.total} waypoints complete (${progress.percentComplete}%)\n\n`;

	if (currentTask.section) {
		context += `## Section: ${currentTask.section}\n`;

		if (completedInSection.length > 0) {
			context += `\nCompleted in this section:\n`;
			for (const waypoint of completedInSection.slice(-3)) {
				// Last 3 completed
				context += `- [x] ${waypoint}\n`;
			}
		}

		if (upcomingInSection.length > 0) {
			context += `\nUpcoming in this section:\n`;
			for (const waypoint of upcomingInSection.slice(0, 3)) {
				// Next 3 upcoming
				context += `- [ ] ${waypoint}\n`;
			}
		}
	}

	return context;
}

/**
 * Parse plan and convert to quest board format (for import-plan command)
 */
export function planToQuests(plan: ParsedPlan): Array<{ objective: string; priority: number; section?: string }> {
	const tasksByPriority = getTasksByPriority(plan);

	return tasksByPriority
		.filter((waypoint) => !waypoint.completed)
		.map((waypoint, index) => ({
			objective: waypoint.content,
			priority: index, // Preserve order from priority sort
			section: waypoint.section,
		}));
}

/**
 * Parse intel.txt file and extract new quests (those not in "Extracted" or "Abandoned" sections)
 *
 * This function focuses only on active quests from "Available" section,
 * ignoring completed work in "Extracted" and "Abandoned" sections.
 */
export function parseIntelFile(
	content: string,
	filePath: string = "intel.txt",
): Array<{ objective: string; priority: number; section?: string }> {
	const plan = parsePlanFile(content, filePath);

	// Filter out quests from "Extracted" and "Abandoned" sections
	const availableWaypoints = plan.waypoints.filter((waypoint) => {
		const section = waypoint.section?.toLowerCase() || "";
		const content = waypoint.content.trim();

		// Skip sections like "Extracted", "Abandoned", and "Archive"
		const skippedSections = ["extracted", "abandoned", "archive"];
		const isSkippedSection = skippedSections.some((s) => section.includes(s));

		// Skip HTML comments and their content
		const isHtmlComment = content.startsWith("<!--") && content.endsWith("-->");

		return !isSkippedSection && !isHtmlComment && !waypoint.completed;
	});

	// Sort by section priority, then by line number to maintain order
	const sortedWaypoints = availableWaypoints.sort((a, b) => {
		const priorityA = a.sectionPriority ?? 4;
		const priorityB = b.sectionPriority ?? 4;
		if (priorityA !== priorityB) {
			return priorityA - priorityB;
		}
		return a.lineNumber - b.lineNumber;
	});

	return sortedWaypoints.map((waypoint, index) => ({
		objective: waypoint.content,
		priority: index, // Preserve order from priority sort
		section: waypoint.section,
	}));
}
