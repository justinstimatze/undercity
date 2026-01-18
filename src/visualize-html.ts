/**
 * Visualization HTML Generation
 *
 * Generates static HTML with Mermaid DAG and CSS timeline.
 */

import { formatDuration, formatTokens, type VisualizationSession, type VisualizationTask } from "./visualize.js";

/**
 * Status colors for visualization
 */
const STATUS_COLORS = {
	complete: "#4ade80", // green
	failed: "#f87171", // red
	escalated: "#fbbf24", // yellow
	in_progress: "#60a5fa", // blue
	pending: "#9ca3af", // gray
};

/**
 * Model colors for timeline
 */
const MODEL_COLORS = {
	haiku: "#86efac", // light green
	sonnet: "#93c5fd", // light blue
	opus: "#c4b5fd", // light purple
	unknown: "#d1d5db", // gray
};

/**
 * Escape text for Mermaid
 */
function escapeMermaid(text: string): string {
	return text
		.replace(/"/g, "'")
		.replace(/[[\](){}]/g, "")
		.replace(/[<>]/g, "")
		.slice(0, 50);
}

/**
 * Escape text for HTML
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/**
 * Generate Mermaid DAG from session data
 */
export function generateMermaidDAG(session: VisualizationSession): string {
	const lines: string[] = ["flowchart TB"];

	// Add style definitions
	lines.push("    %% Status styles");
	lines.push(`    classDef complete fill:${STATUS_COLORS.complete},stroke:#22c55e,color:#000`);
	lines.push(`    classDef failed fill:${STATUS_COLORS.failed},stroke:#ef4444,color:#000`);
	lines.push(`    classDef escalated fill:${STATUS_COLORS.escalated},stroke:#f59e0b,color:#000`);
	lines.push(`    classDef inprogress fill:${STATUS_COLORS.in_progress},stroke:#3b82f6,color:#000`);
	lines.push(`    classDef pending fill:${STATUS_COLORS.pending},stroke:#6b7280,color:#000`);
	lines.push("");

	// Build task map for parent lookup
	const taskMap = new Map<string, VisualizationTask>();
	for (const task of session.tasks) {
		taskMap.set(task.id, task);
	}

	// Track which tasks have been rendered
	const rendered = new Set<string>();

	// First pass: render all nodes
	for (const task of session.tasks) {
		const shortId = task.id.slice(-8);
		const label = escapeMermaid(task.objective);
		const isMeta = task.objective.startsWith("[meta:");
		const isParent = task.subtaskIds && task.subtaskIds.length > 0;

		// Choose node shape based on task type
		let nodeShape: string;
		if (isParent) {
			// Stadium shape for decomposed parent
			nodeShape = `${shortId}([["${label}"]])`;
		} else if (isMeta) {
			// Hexagon for meta tasks
			nodeShape = `${shortId}{{"${label}"}}`;
		} else {
			// Rectangle for regular tasks
			nodeShape = `${shortId}["${label}"]`;
		}

		lines.push(`    ${nodeShape}`);

		// Apply status class
		const statusClass =
			task.status === "in_progress" ? "inprogress" : task.status === "escalated" ? "escalated" : task.status;
		lines.push(`    class ${shortId} ${statusClass}`);

		rendered.add(task.id);
	}

	lines.push("");

	// Second pass: render edges for parent-child relationships
	for (const task of session.tasks) {
		if (task.parentId && taskMap.has(task.parentId)) {
			const parentShortId = task.parentId.slice(-8);
			const childShortId = task.id.slice(-8);
			lines.push(`    ${parentShortId} --> ${childShortId}`);
		}
	}

	return lines.join("\n");
}

/**
 * Lane assignment for timeline (parallel tracks)
 */
interface TimelineLane {
	endTime: number;
	tasks: VisualizationTask[];
}

/**
 * Assign tasks to non-overlapping lanes
 */
function assignLanes(tasks: VisualizationTask[]): Map<string, number> {
	const lanes: TimelineLane[] = [];
	const taskLanes = new Map<string, number>();

	// Sort by start time
	const sorted = [...tasks].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

	for (const task of sorted) {
		const startTime = task.startedAt.getTime();
		const endTime = task.completedAt?.getTime() ?? startTime + task.durationSecs * 1000;

		// Find first available lane
		let assignedLane = -1;
		for (let i = 0; i < lanes.length; i++) {
			if (lanes[i].endTime <= startTime) {
				assignedLane = i;
				break;
			}
		}

		// Create new lane if needed
		if (assignedLane === -1) {
			assignedLane = lanes.length;
			lanes.push({ endTime: 0, tasks: [] });
		}

		// Assign task to lane
		lanes[assignedLane].endTime = endTime;
		lanes[assignedLane].tasks.push(task);
		taskLanes.set(task.id, assignedLane);
	}

	return taskLanes;
}

/**
 * Generate timeline HTML (CSS-based horizontal bars)
 */
export function generateTimeline(session: VisualizationSession): string {
	if (session.tasks.length === 0) {
		return '<div class="timeline-empty">No tasks in this session</div>';
	}

	const taskLanes = assignLanes(session.tasks);
	const laneCount = Math.max(...taskLanes.values()) + 1;

	// Calculate time bounds
	const minTime = Math.min(...session.tasks.map((t) => t.startedAt.getTime()));
	const maxTime = Math.max(
		...session.tasks.map((t) => t.completedAt?.getTime() ?? t.startedAt.getTime() + t.durationSecs * 1000),
	);
	const totalDuration = maxTime - minTime;

	if (totalDuration === 0) {
		return '<div class="timeline-empty">No duration data available</div>';
	}

	const lines: string[] = [];
	lines.push('<div class="timeline-container">');

	// Lane labels
	lines.push('<div class="timeline-lanes">');
	for (let i = 0; i < laneCount; i++) {
		lines.push(`<div class="lane-label">Lane ${i + 1}</div>`);
	}
	lines.push("</div>");

	// Timeline tracks
	lines.push('<div class="timeline-tracks">');

	for (let lane = 0; lane < laneCount; lane++) {
		lines.push('<div class="timeline-lane">');

		const laneTasks = session.tasks.filter((t) => taskLanes.get(t.id) === lane);
		for (const task of laneTasks) {
			const startOffset = ((task.startedAt.getTime() - minTime) / totalDuration) * 100;
			const endTime = task.completedAt?.getTime() ?? task.startedAt.getTime() + task.durationSecs * 1000;
			const width = Math.max(((endTime - task.startedAt.getTime()) / totalDuration) * 100, 0.5);

			const color = STATUS_COLORS[task.status] || STATUS_COLORS.pending;
			const modelColor = MODEL_COLORS[task.model as keyof typeof MODEL_COLORS] || MODEL_COLORS.unknown;
			const shortId = task.id.slice(-8);
			const tooltip = escapeHtml(
				`${task.objective}\n${task.model} | ${formatDuration(task.durationSecs)} | ${formatTokens(task.tokens)} tokens`,
			);

			lines.push(
				`<div class="task-bar" style="left:${startOffset}%;width:${width}%;background:${color};border-left:3px solid ${modelColor}" title="${tooltip}" data-task-id="${shortId}">`,
			);
			lines.push(`<span class="task-label">${escapeHtml(task.objective.slice(0, 20))}</span>`);
			lines.push("</div>");
		}

		lines.push("</div>");
	}

	lines.push("</div>");

	// Time axis
	const intervals = 5;
	lines.push('<div class="timeline-axis">');
	for (let i = 0; i <= intervals; i++) {
		const time = minTime + (totalDuration * i) / intervals;
		const date = new Date(time);
		const label = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
		lines.push(`<span class="axis-label" style="left:${(i / intervals) * 100}%">${label}</span>`);
	}
	lines.push("</div>");

	lines.push("</div>");

	return lines.join("\n");
}

/**
 * Generate stats table HTML
 */
function generateStatsTable(session: VisualizationSession): string {
	const { stats } = session;
	const successRate = stats.total > 0 ? ((stats.successful / stats.total) * 100).toFixed(1) : "0";

	const lines: string[] = [];
	lines.push('<div class="stats-grid">');

	// Summary stats
	lines.push('<div class="stat-card">');
	lines.push(`<div class="stat-value">${stats.total}</div>`);
	lines.push('<div class="stat-label">Total Tasks</div>');
	lines.push("</div>");

	lines.push('<div class="stat-card success">');
	lines.push(`<div class="stat-value">${stats.successful}</div>`);
	lines.push('<div class="stat-label">Successful</div>');
	lines.push("</div>");

	lines.push('<div class="stat-card error">');
	lines.push(`<div class="stat-value">${stats.failed}</div>`);
	lines.push('<div class="stat-label">Failed</div>');
	lines.push("</div>");

	lines.push('<div class="stat-card">');
	lines.push(`<div class="stat-value">${stats.merged}</div>`);
	lines.push('<div class="stat-label">Merged</div>');
	lines.push("</div>");

	lines.push('<div class="stat-card">');
	lines.push(`<div class="stat-value">${successRate}%</div>`);
	lines.push('<div class="stat-label">Success Rate</div>');
	lines.push("</div>");

	lines.push('<div class="stat-card">');
	lines.push(`<div class="stat-value">${formatTokens(stats.totalTokens)}</div>`);
	lines.push('<div class="stat-label">Total Tokens</div>');
	lines.push("</div>");

	lines.push('<div class="stat-card">');
	lines.push(`<div class="stat-value">${session.durationMins}m</div>`);
	lines.push('<div class="stat-label">Duration</div>');
	lines.push("</div>");

	lines.push('<div class="stat-card">');
	lines.push(`<div class="stat-value">${session.parallelism}</div>`);
	lines.push('<div class="stat-label">Parallelism</div>');
	lines.push("</div>");

	lines.push("</div>");

	// Model distribution
	lines.push('<div class="model-distribution">');
	lines.push("<h3>Model Distribution</h3>");
	lines.push('<div class="model-bars">');
	for (const [model, count] of Object.entries(stats.modelDistribution)) {
		const pct = stats.total > 0 ? (count / stats.total) * 100 : 0;
		const color = MODEL_COLORS[model as keyof typeof MODEL_COLORS] || MODEL_COLORS.unknown;
		lines.push(`<div class="model-bar" style="width:${pct}%;background:${color}">`);
		lines.push(`<span>${model}: ${count} (${pct.toFixed(0)}%)</span>`);
		lines.push("</div>");
	}
	lines.push("</div>");
	lines.push("</div>");

	return lines.join("\n");
}

/**
 * Generate task details table HTML
 */
function generateTaskTable(session: VisualizationSession): string {
	const lines: string[] = [];
	lines.push('<table class="task-table">');
	lines.push("<thead><tr>");
	lines.push(
		"<th>ID</th><th>Objective</th><th>Status</th><th>Model</th><th>Duration</th><th>Tokens</th><th>Attempts</th>",
	);
	lines.push("</tr></thead>");
	lines.push("<tbody>");

	for (const task of session.tasks) {
		const shortId = task.id.slice(-8);
		const statusClass = task.status.replace("_", "-");
		lines.push("<tr>");
		lines.push(`<td class="task-id">${shortId}</td>`);
		lines.push(`<td class="task-objective">${escapeHtml(task.objective)}</td>`);
		lines.push(`<td class="status-${statusClass}">${task.status}</td>`);
		lines.push(`<td>${task.model}</td>`);
		lines.push(`<td>${formatDuration(task.durationSecs)}</td>`);
		lines.push(`<td>${formatTokens(task.tokens)}</td>`);
		lines.push(`<td>${task.attempts}</td>`);
		lines.push("</tr>");

		// Show error if failed
		if (task.error) {
			lines.push(`<tr class="error-row"><td colspan="7" class="error-message">${escapeHtml(task.error)}</td></tr>`);
		}

		// Show escalations if any
		if (task.escalations && task.escalations.length > 0) {
			lines.push(
				`<tr class="escalation-row"><td colspan="7" class="escalation-info">Escalations: ${task.escalations.join(", ")}</td></tr>`,
			);
		}
	}

	lines.push("</tbody></table>");
	return lines.join("\n");
}

/**
 * Generate full visualization HTML
 */
export function generateVisualizationHTML(session: VisualizationSession): string {
	const mermaidDag = generateMermaidDAG(session);
	const timeline = generateTimeline(session);
	const statsTable = generateStatsTable(session);
	const taskTable = generateTaskTable(session);

	const startedAt = session.startedAt.toLocaleString();
	const endedAt = session.endedAt ? session.endedAt.toLocaleString() : "In progress";

	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Grind Session: ${escapeHtml(session.batchId)}</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
    <style>
        :root {
            --bg-primary: #0d1117;
            --bg-secondary: #161b22;
            --bg-tertiary: #21262d;
            --text-primary: #e6edf3;
            --text-secondary: #8b949e;
            --border-color: #30363d;
            --accent-green: #4ade80;
            --accent-red: #f87171;
            --accent-yellow: #fbbf24;
            --accent-blue: #60a5fa;
        }

        * {
            box-sizing: border-box;
        }

        body {
            font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
            background: var(--bg-primary);
            color: var(--text-primary);
            margin: 0;
            padding: 20px;
            line-height: 1.5;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
        }

        header {
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 20px;
            margin-bottom: 30px;
        }

        h1 {
            font-size: 1.5rem;
            margin: 0 0 10px 0;
            color: var(--text-primary);
        }

        h2 {
            font-size: 1.2rem;
            color: var(--text-secondary);
            margin: 30px 0 15px 0;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 10px;
        }

        h3 {
            font-size: 1rem;
            color: var(--text-secondary);
            margin: 15px 0 10px 0;
        }

        .session-meta {
            color: var(--text-secondary);
            font-size: 0.85rem;
        }

        .session-meta span {
            margin-right: 20px;
        }

        /* Stats Grid */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }

        .stat-card {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 15px;
            text-align: center;
        }

        .stat-card.success {
            border-color: var(--accent-green);
        }

        .stat-card.error {
            border-color: var(--accent-red);
        }

        .stat-value {
            font-size: 1.5rem;
            font-weight: bold;
            color: var(--text-primary);
        }

        .stat-label {
            font-size: 0.75rem;
            color: var(--text-secondary);
            text-transform: uppercase;
            margin-top: 5px;
        }

        /* Model Distribution */
        .model-distribution {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 15px;
            margin-bottom: 20px;
        }

        .model-bars {
            display: flex;
            flex-direction: column;
            gap: 5px;
        }

        .model-bar {
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 0.85rem;
            min-width: fit-content;
        }

        /* DAG Section */
        .dag-section {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            overflow-x: auto;
        }

        .mermaid {
            text-align: center;
        }

        /* Timeline */
        .timeline-container {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            overflow-x: auto;
        }

        .timeline-lanes {
            display: flex;
            flex-direction: column;
            gap: 5px;
            width: 60px;
            flex-shrink: 0;
        }

        .lane-label {
            height: 35px;
            display: flex;
            align-items: center;
            font-size: 0.75rem;
            color: var(--text-secondary);
        }

        .timeline-tracks {
            flex: 1;
            min-width: 600px;
        }

        .timeline-lane {
            position: relative;
            height: 35px;
            margin-bottom: 5px;
            background: var(--bg-tertiary);
            border-radius: 4px;
        }

        .task-bar {
            position: absolute;
            top: 2px;
            height: 31px;
            border-radius: 4px;
            display: flex;
            align-items: center;
            padding: 0 8px;
            overflow: hidden;
            cursor: pointer;
            transition: opacity 0.2s;
        }

        .task-bar:hover {
            opacity: 0.8;
        }

        .task-label {
            font-size: 0.7rem;
            color: #000;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .timeline-axis {
            position: relative;
            height: 25px;
            margin-top: 10px;
            border-top: 1px solid var(--border-color);
        }

        .axis-label {
            position: absolute;
            font-size: 0.7rem;
            color: var(--text-secondary);
            transform: translateX(-50%);
            top: 5px;
        }

        .timeline-empty {
            padding: 40px;
            text-align: center;
            color: var(--text-secondary);
        }

        /* Task Table */
        .task-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.85rem;
        }

        .task-table th,
        .task-table td {
            padding: 10px;
            text-align: left;
            border-bottom: 1px solid var(--border-color);
        }

        .task-table th {
            background: var(--bg-secondary);
            color: var(--text-secondary);
            font-weight: 500;
            text-transform: uppercase;
            font-size: 0.75rem;
        }

        .task-table tr:hover {
            background: var(--bg-secondary);
        }

        .task-id {
            font-family: monospace;
            color: var(--accent-blue);
        }

        .task-objective {
            max-width: 400px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .status-complete { color: var(--accent-green); }
        .status-failed { color: var(--accent-red); }
        .status-escalated { color: var(--accent-yellow); }
        .status-in-progress { color: var(--accent-blue); }

        .error-row td,
        .escalation-row td {
            padding: 5px 10px 10px 30px;
            border-bottom: 1px solid var(--border-color);
        }

        .error-message {
            color: var(--accent-red);
            font-size: 0.8rem;
        }

        .escalation-info {
            color: var(--accent-yellow);
            font-size: 0.8rem;
        }

        /* Legend */
        .legend {
            display: flex;
            gap: 20px;
            flex-wrap: wrap;
            margin-bottom: 15px;
            font-size: 0.8rem;
        }

        .legend-item {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .legend-color {
            width: 14px;
            height: 14px;
            border-radius: 3px;
        }

        /* Collapsible sections */
        .collapsible {
            cursor: pointer;
            user-select: none;
        }

        .collapsible::before {
            content: '\\25BC';
            display: inline-block;
            margin-right: 8px;
            transition: transform 0.2s;
        }

        .collapsible.collapsed::before {
            transform: rotate(-90deg);
        }

        .section-content {
            overflow: hidden;
            transition: max-height 0.3s ease-out;
        }

        .section-content.collapsed {
            max-height: 0 !important;
        }

        footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid var(--border-color);
            color: var(--text-secondary);
            font-size: 0.8rem;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Grind Session: ${escapeHtml(session.batchId)}</h1>
            <div class="session-meta">
                <span>Started: ${startedAt}</span>
                <span>Ended: ${endedAt}</span>
                <span>Duration: ${session.durationMins}m</span>
            </div>
        </header>

        <section>
            <h2 class="collapsible">Statistics</h2>
            <div class="section-content">
                ${statsTable}
            </div>
        </section>

        <section>
            <h2 class="collapsible">Task DAG</h2>
            <div class="section-content">
                <div class="legend">
                    <div class="legend-item"><div class="legend-color" style="background:${STATUS_COLORS.complete}"></div> Complete</div>
                    <div class="legend-item"><div class="legend-color" style="background:${STATUS_COLORS.failed}"></div> Failed</div>
                    <div class="legend-item"><div class="legend-color" style="background:${STATUS_COLORS.escalated}"></div> Escalated</div>
                    <div class="legend-item"><div class="legend-color" style="background:${STATUS_COLORS.in_progress}"></div> In Progress</div>
                </div>
                <div class="dag-section">
                    <pre class="mermaid">
${mermaidDag}
                    </pre>
                </div>
            </div>
        </section>

        <section>
            <h2 class="collapsible">Timeline</h2>
            <div class="section-content">
                <div class="legend">
                    <div class="legend-item"><div class="legend-color" style="background:${MODEL_COLORS.haiku}"></div> Haiku</div>
                    <div class="legend-item"><div class="legend-color" style="background:${MODEL_COLORS.sonnet}"></div> Sonnet</div>
                    <div class="legend-item"><div class="legend-color" style="background:${MODEL_COLORS.opus}"></div> Opus</div>
                </div>
                ${timeline}
            </div>
        </section>

        <section>
            <h2 class="collapsible">Task Details</h2>
            <div class="section-content">
                ${taskTable}
            </div>
        </section>

        <footer>
            Generated by undercity visualize at ${new Date().toLocaleString()}
        </footer>
    </div>

    <script>
        // Initialize Mermaid
        mermaid.initialize({
            startOnLoad: true,
            theme: 'dark',
            themeVariables: {
                darkMode: true,
                background: '#0d1117',
                primaryColor: '#21262d',
                primaryTextColor: '#e6edf3',
                primaryBorderColor: '#30363d',
                lineColor: '#8b949e',
                secondaryColor: '#161b22',
                tertiaryColor: '#0d1117'
            },
            flowchart: {
                curve: 'basis',
                padding: 20
            }
        });

        // Collapsible sections
        document.querySelectorAll('.collapsible').forEach(header => {
            header.addEventListener('click', () => {
                header.classList.toggle('collapsed');
                const content = header.nextElementSibling;
                if (content.classList.contains('collapsed')) {
                    content.classList.remove('collapsed');
                    content.style.maxHeight = content.scrollHeight + 'px';
                } else {
                    content.style.maxHeight = content.scrollHeight + 'px';
                    content.offsetHeight; // Force reflow
                    content.classList.add('collapsed');
                }
            });

            // Set initial max-height
            const content = header.nextElementSibling;
            content.style.maxHeight = content.scrollHeight + 'px';
        });
    </script>
</body>
</html>`;
}
