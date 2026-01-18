/**
 * HTTP API Server
 *
 * Provides a REST API for controlling and querying undercity.
 * Designed for easy integration with Claude Code via curl.
 *
 * SECURITY:
 *   - Binds to 127.0.0.1 ONLY (localhost) - not accessible from network
 *   - No authentication (relies on localhost restriction)
 *   - Body size limited to 64KB to prevent memory exhaustion
 *   - Input validation on all endpoints
 *
 * Endpoints:
 *   GET  /status   - Current session status, agents, daemon state
 *   GET  /tasks    - Task board
 *   POST /tasks    - Add a task { objective: string, priority?: number }
 *   GET  /metrics  - Metrics summary
 *   POST /pause    - Pause grind loop
 *   POST /resume   - Resume grind loop
 *   POST /drain    - Finish current tasks, start no more
 *   POST /stop     - Stop the daemon
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { serverLogger } from "./logger.js";
import { Persistence } from "./persistence.js";
import { addGoal, getAllItems, getBacklogSummary } from "./task.js";

const DEFAULT_PORT = 7331;
const LOCALHOST = "127.0.0.1"; // SECURITY: Only bind to localhost
const STATE_DIR = ".undercity";
const DAEMON_STATE_FILE = "daemon.json";
const MAX_BODY_SIZE = 64 * 1024; // 64KB max body size
const MAX_OBJECTIVE_LENGTH = 2000; // Reasonable limit for task objectives

export interface DaemonState {
	pid: number;
	port: number;
	startedAt: string;
	paused: boolean;
	grindActive: boolean;
	draining: boolean;
}

export interface ServerConfig {
	port?: number;
	stateDir?: string;
	onPause?: () => void;
	onResume?: () => void;
	onStop?: () => void;
	onDrain?: () => void;
}

/**
 * Read daemon state from disk
 */
export function getDaemonState(stateDir: string = STATE_DIR): DaemonState | null {
	const path = join(stateDir, DAEMON_STATE_FILE);
	if (!existsSync(path)) {
		return null;
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

/**
 * Write daemon state to disk
 */
export function saveDaemonState(state: DaemonState, stateDir: string = STATE_DIR): void {
	const path = join(stateDir, DAEMON_STATE_FILE);
	writeFileSync(path, JSON.stringify(state, null, 2));
}

/**
 * Clear daemon state (on shutdown)
 */
export function clearDaemonState(stateDir: string = STATE_DIR): void {
	const path = join(stateDir, DAEMON_STATE_FILE);
	if (existsSync(path)) {
		try {
			const { unlinkSync } = require("node:fs");
			unlinkSync(path);
		} catch {
			// Ignore cleanup errors
		}
	}
}

/**
 * Check if daemon is running
 */
export function isDaemonRunning(stateDir: string = STATE_DIR): boolean {
	const state = getDaemonState(stateDir);
	if (!state) return false;

	// Check if process is still alive
	try {
		process.kill(state.pid, 0);
		return true;
	} catch {
		// Process not running, clean up stale state
		clearDaemonState(stateDir);
		return false;
	}
}

/**
 * HTTP API Server for undercity daemon
 */
export class UndercityServer {
	private server: Server | null = null;
	private port: number;
	private stateDir: string;
	private paused = false;
	private grindActive = false;
	private draining = false;
	private persistence: Persistence;
	private onPause?: () => void;
	private onResume?: () => void;
	private onStop?: () => void;
	private onDrain?: () => void;

	constructor(config: ServerConfig = {}) {
		this.port = config.port ?? DEFAULT_PORT;
		this.stateDir = config.stateDir ?? STATE_DIR;
		this.persistence = new Persistence(this.stateDir);
		this.onPause = config.onPause;
		this.onResume = config.onResume;
		this.onStop = config.onStop;
		this.onDrain = config.onDrain;
	}

	/**
	 * Start the HTTP server
	 */
	async start(): Promise<void> {
		if (isDaemonRunning(this.stateDir)) {
			const state = getDaemonState(this.stateDir);
			throw new Error(`Daemon already running on port ${state?.port} (PID ${state?.pid})`);
		}

		return new Promise((resolve, reject) => {
			this.server = createServer((req, res) => this.handleRequest(req, res));

			this.server.on("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE") {
					reject(new Error(`Port ${this.port} is already in use`));
				} else {
					reject(err);
				}
			});

			// SECURITY: Bind to localhost only - not accessible from network
			this.server.listen(this.port, LOCALHOST, () => {
				// Save daemon state
				saveDaemonState(
					{
						pid: process.pid,
						port: this.port,
						startedAt: new Date().toISOString(),
						paused: this.paused,
						grindActive: this.grindActive,
						draining: this.draining,
					},
					this.stateDir,
				);

				serverLogger.info({ port: this.port }, "Undercity daemon started");
				resolve();
			});
		});
	}

	/**
	 * Stop the HTTP server
	 */
	async stop(): Promise<void> {
		return new Promise((resolve) => {
			clearDaemonState(this.stateDir);
			if (this.server) {
				this.server.close(() => {
					serverLogger.info("Undercity daemon stopped");
					resolve();
				});
			} else {
				resolve();
			}
		});
	}

	/**
	 * Set grind active state (called by grind loop)
	 */
	setGrindActive(active: boolean): void {
		this.grindActive = active;
		this.updateDaemonState();
	}

	/**
	 * Check if paused
	 */
	isPaused(): boolean {
		return this.paused;
	}

	private updateDaemonState(): void {
		const state = getDaemonState(this.stateDir);
		if (state) {
			state.paused = this.paused;
			state.grindActive = this.grindActive;
			state.draining = this.draining;
			saveDaemonState(state, this.stateDir);
		}
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = req.url ?? "/";
		const method = req.method ?? "GET";

		// CORS headers for local development
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");

		if (method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		try {
			const route = `${method} ${url.split("?")[0]}`;

			switch (route) {
				case "GET /":
				case "GET /status":
					return this.handleStatus(res);
				case "GET /tasks":
					return this.handleGetTasks(res);
				case "POST /tasks":
					return this.handleAddTask(req, res);
				case "GET /metrics":
					return this.handleMetrics(res);
				case "POST /pause":
					return this.handlePause(res);
				case "POST /resume":
					return this.handleResume(res);
				case "POST /stop":
					return this.handleStop(res);
				case "POST /drain":
					return this.handleDrain(res);
				default:
					return this.sendJson(res, 404, { error: "Not found", availableEndpoints: ENDPOINTS });
			}
		} catch (err) {
			serverLogger.error({ err, url, method }, "Request error");
			// Don't expose stack traces or internal error details to clients
			const message = err instanceof Error ? err.message : "Internal server error";
			return this.sendJson(res, 500, { error: message });
		}
	}

	private sendJson(res: ServerResponse, status: number, data: unknown): void {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(data, null, 2));
	}

	private handleStatus(res: ServerResponse): void {
		const recovery = this.persistence.getSessionRecovery();
		const inventory = this.persistence.getInventory();
		const summary = getBacklogSummary();

		this.sendJson(res, 200, {
			daemon: {
				pid: process.pid,
				port: this.port,
				uptime: process.uptime(),
				paused: this.paused,
				grindActive: this.grindActive,
			},
			session: recovery.sessionId
				? {
						id: recovery.sessionId,
						status: recovery.status,
						goal: recovery.goal,
						checkpoint: recovery.checkpoint,
					}
				: null,
			agents: inventory.agents.map((a) => ({
				id: a.id,
				type: a.type,
				status: a.status,
				step: a.step?.id,
			})),
			tasks: summary,
		});
	}

	private handleGetTasks(res: ServerResponse): void {
		const items = getAllItems();
		const summary = getBacklogSummary();

		this.sendJson(res, 200, {
			summary,
			tasks: items.map((t) => ({
				id: t.id,
				objective: t.objective,
				status: t.status,
				priority: t.priority,
				tags: t.tags,
			})),
		});
	}

	private async handleAddTask(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await this.readBody(req);

		if (!body.objective || typeof body.objective !== "string") {
			return this.sendJson(res, 400, { error: "Missing required field: objective" });
		}

		// SECURITY: Validate objective length
		if (body.objective.length > MAX_OBJECTIVE_LENGTH) {
			return this.sendJson(res, 400, {
				error: `Objective too long (max ${MAX_OBJECTIVE_LENGTH} characters)`,
			});
		}

		const priority = typeof body.priority === "number" ? body.priority : undefined;
		const task = addGoal(body.objective, priority);
		serverLogger.info({ taskId: task.id, objective: task.objective }, "Task added via API");

		this.sendJson(res, 201, { success: true, task: { id: task.id, objective: task.objective } });
	}

	private async handleMetrics(res: ServerResponse): Promise<void> {
		const { getMetricsSummary } = await import("./metrics.js");
		const summary = await getMetricsSummary();

		// Get task board summary for additional context
		const taskSummary = getBacklogSummary();

		this.sendJson(res, 200, {
			tasks: {
				total: summary.totalTasks,
				successRate: summary.totalTasks > 0 ? `${(summary.successRate * 100).toFixed(1)}%` : "N/A",
				averageTokens: summary.avgTokens > 0 ? Math.round(summary.avgTokens) : "N/A",
				averageDuration: summary.avgTimeTakenMs > 0 ? `${Math.round(summary.avgTimeTakenMs / 1000)}s` : "N/A",
				escalationRate: summary.escalationRate > 0 ? `${(summary.escalationRate * 100).toFixed(1)}%` : "N/A",
			},
			models: summary.modelDistribution,
			board: {
				pending: taskSummary.pending,
				inProgress: taskSummary.inProgress,
				complete: taskSummary.complete,
				failed: taskSummary.failed,
			},
		});
	}

	private handlePause(res: ServerResponse): void {
		this.paused = true;
		this.updateDaemonState();
		this.onPause?.();
		serverLogger.info("Grind paused via API");
		this.sendJson(res, 200, { success: true, paused: true });
	}

	private handleResume(res: ServerResponse): void {
		this.paused = false;
		this.updateDaemonState();
		this.onResume?.();
		serverLogger.info("Grind resumed via API");
		this.sendJson(res, 200, { success: true, paused: false });
	}

	private handleStop(res: ServerResponse): void {
		this.sendJson(res, 200, { success: true, message: "Shutting down" });
		this.onStop?.();
		setTimeout(() => {
			this.stop().then(() => process.exit(0));
		}, 100);
	}

	private handleDrain(res: ServerResponse): void {
		this.draining = true;
		this.updateDaemonState();
		this.onDrain?.();
		serverLogger.info("Drain initiated via API - finishing current tasks, starting no more");
		this.sendJson(res, 200, { success: true, draining: true, message: "Finishing current tasks, starting no more" });
	}

	private readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			let data = "";
			let size = 0;

			req.on("data", (chunk: Buffer | string) => {
				size += chunk.length;
				// SECURITY: Reject bodies larger than MAX_BODY_SIZE
				if (size > MAX_BODY_SIZE) {
					req.destroy();
					reject(new Error(`Body too large (max ${MAX_BODY_SIZE} bytes)`));
					return;
				}
				data += chunk;
			});

			req.on("end", () => {
				try {
					resolve(data ? JSON.parse(data) : {});
				} catch {
					reject(new Error("Invalid JSON body"));
				}
			});

			req.on("error", reject);
		});
	}
}

const ENDPOINTS = {
	"GET /status": "Current daemon status, session, agents, task summary",
	"GET /tasks": "Full task board",
	"POST /tasks": "Add task { objective: string, priority?: number }",
	"GET /metrics": "Metrics summary",
	"POST /pause": "Pause grind loop",
	"POST /resume": "Resume grind loop",
	"POST /drain": "Finish current tasks, start no more",
	"POST /stop": "Stop daemon",
};

/**
 * Simple client for querying the daemon
 */
export async function queryDaemon(
	endpoint: string,
	method: "GET" | "POST" = "GET",
	body?: Record<string, unknown>,
): Promise<unknown> {
	const state = getDaemonState();
	if (!state) {
		throw new Error("Daemon not running");
	}

	const http = await import("node:http");

	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: "localhost",
				port: state.port,
				path: endpoint,
				method,
				headers: body ? { "Content-Type": "application/json" } : {},
			},
			(res) => {
				let data = "";
				res.on("data", (chunk) => {
					data += chunk;
				});
				res.on("end", () => {
					try {
						resolve(JSON.parse(data));
					} catch {
						resolve(data);
					}
				});
			},
		);

		req.on("error", reject);
		if (body) {
			req.write(JSON.stringify(body));
		}
		req.end();
	});
}
