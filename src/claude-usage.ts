/**
 * Claude Usage Fetcher
 *
 * SKETCHY WORKAROUND ALERT:
 * This module scrapes claude.ai/settings/usage to get Claude Max plan limits.
 * We have to do this because:
 * 1. The Anthropic SDK doesn't expose rate limit info from responses
 * 2. There's no API endpoint to query account usage
 * 3. Claude Code shows usage in its status bar but doesn't expose it programmatically
 *
 * This is fragile and will break if Anthropic changes their page structure.
 * Anthropic should add a /v1/usage endpoint to the API or expose rate limit
 * headers in the SDK response objects.
 *
 * SECURITY NOTES:
 * - Browser session data is stored locally in .undercity/browser-data/
 * - Session cookies are persisted (treat this directory as sensitive)
 * - No credentials are stored in plain text - auth is via browser cookies
 * - The headless browser only accesses claude.ai/settings/usage
 * - Consider adding .undercity/browser-data/ to .gitignore (it already should be)
 *
 * Uses Playwright to fetch Claude Max usage from claude.ai/settings/usage.
 * Maintains a persistent browser context so you only need to log in once.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, chromium } from "playwright";

export interface ClaudeUsage {
	fiveHourPercent: number;
	weeklyPercent: number;
	fetchedAt: string;
	success: boolean;
	error?: string;
	needsLogin?: boolean;
	cached?: boolean;
	/** Extra usage enabled (pay-per-use beyond plan limits) */
	extraUsageEnabled?: boolean;
	/** Extra usage spend if enabled (e.g., "$5.23") */
	extraUsageSpend?: string;
}

const USAGE_URL = "https://claude.ai/settings/usage";
const BROWSER_DATA_DIR = ".undercity/browser-data";
const USAGE_CACHE_FILE = ".undercity/usage-cache.json";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get cached usage data if still valid
 */
function getCachedUsage(): ClaudeUsage | null {
	const cachePath = join(process.cwd(), USAGE_CACHE_FILE);
	if (!existsSync(cachePath)) {
		return null;
	}

	try {
		const content = readFileSync(cachePath, "utf-8");
		const cached = JSON.parse(content) as ClaudeUsage;

		// Check if cache is still valid
		const fetchedAt = new Date(cached.fetchedAt).getTime();
		const age = Date.now() - fetchedAt;
		if (age < CACHE_TTL_MS && cached.success) {
			return { ...cached, cached: true };
		}
	} catch {
		// Cache corrupted or unreadable
	}

	return null;
}

/**
 * Save usage data to cache
 */
function cacheUsage(usage: ClaudeUsage): void {
	const cachePath = join(process.cwd(), USAGE_CACHE_FILE);
	const dir = join(process.cwd(), ".undercity");

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	try {
		writeFileSync(cachePath, JSON.stringify(usage, null, 2));
	} catch {
		// Cache write failure is non-critical
	}
}

/**
 * Get the browser data directory path
 */
function getBrowserDataPath(): string {
	const dataDir = join(process.cwd(), BROWSER_DATA_DIR);
	if (!existsSync(dataDir)) {
		mkdirSync(dataDir, { recursive: true });
	}
	return dataDir;
}

/**
 * Fetch Claude Max usage from claude.ai
 *
 * Uses a persistent browser context so login persists across calls.
 * If not logged in, returns needsLogin: true and you should call
 * fetchClaudeUsageInteractive() to open a visible browser for login.
 *
 * Results are cached for 5 minutes to avoid hammering claude.ai with Playwright.
 * Use forceRefresh=true to bypass cache.
 */
export async function fetchClaudeUsage(forceRefresh = false): Promise<ClaudeUsage> {
	// Check cache first (unless forced refresh)
	if (!forceRefresh) {
		const cached = getCachedUsage();
		if (cached) {
			return cached;
		}
	}

	const browserDataPath = getBrowserDataPath();

	let context: BrowserContext | null = null;

	try {
		// Launch with persistent context (new headless mode - less detectable)
		context = await chromium.launchPersistentContext(browserDataPath, {
			headless: true,
			channel: "chromium",
			args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage", "--no-sandbox"],
			// Mimic real browser
			userAgent:
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		});

		const page = await context.newPage();

		// Navigate to usage page
		await page.goto(USAGE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
		// Give the page a moment to render dynamic content
		await page.waitForTimeout(3000);

		// Check if we're on the login page
		const url = page.url();
		if (url.includes("/login") || url.includes("/signin")) {
			await context.close();
			return {
				fiveHourPercent: 0,
				weeklyPercent: 0,
				fetchedAt: new Date().toISOString(),
				success: false,
				needsLogin: true,
				error: "Not logged in - run 'undercity usage --login' to authenticate",
			};
		}

		// Wait for usage data to load
		await page
			.waitForSelector('[data-testid="usage-meter"], .usage-meter, [class*="usage"]', {
				timeout: 10000,
			})
			.catch(() => {
				// Selector might vary, continue to try extraction
			});

		// Extract usage percentages from the page text
		const pageText = (await page.evaluate("document.body.innerText")) as string;

		// Look for usage patterns in the page
		// Format: "Current session ... X% used" and "Weekly limits ... X% used"
		// Or: "X% used" after "Current session" / "Weekly"

		let fiveHour: number | null = null;
		let weekly: number | null = null;

		// Try to find "Current session" followed by "X% used"
		const sessionMatch = pageText.match(/Current session[\s\S]*?(\d+)%\s*used/i);
		if (sessionMatch) {
			fiveHour = parseFloat(sessionMatch[1]);
		}

		// Try to find "Weekly limits" or "All models" followed by "X% used"
		const weeklyMatch = pageText.match(/(?:Weekly limits|All models)[\s\S]*?(\d+)%\s*used/i);
		if (weeklyMatch) {
			weekly = parseFloat(weeklyMatch[1]);
		}

		// Fallback: look for any "X% used" patterns
		if (fiveHour === null || weekly === null) {
			const allMatches = [...pageText.matchAll(/(\d+)%\s*used/gi)];
			if (allMatches.length >= 1 && fiveHour === null) {
				fiveHour = parseFloat(allMatches[0][1]);
			}
			if (allMatches.length >= 2 && weekly === null) {
				weekly = parseFloat(allMatches[1][1]);
			}
		}

		// Check for extra usage (pay-per-use beyond plan limits)
		// Look for patterns like "Extra usage", "Additional usage", or dollar amounts in usage context
		let extraUsageEnabled = false;
		let extraUsageSpend: string | undefined;

		const extraUsageMatch = pageText.match(/(?:extra|additional)\s*usage/i);
		if (extraUsageMatch) {
			extraUsageEnabled = true;
			// Try to find a dollar amount near extra usage mention
			const spendMatch = pageText.match(/(?:extra|additional)\s*usage[\s\S]*?\$(\d+(?:\.\d{2})?)/i);
			if (spendMatch) {
				extraUsageSpend = `$${spendMatch[1]}`;
			}
		}

		const usage = { fiveHour, weekly, extraUsageEnabled, extraUsageSpend };

		await context.close();

		if (usage.fiveHour === null && usage.weekly === null) {
			return {
				fiveHourPercent: 0,
				weeklyPercent: 0,
				fetchedAt: new Date().toISOString(),
				success: false,
				error: "Could not extract usage data from page. Page structure may have changed.",
			};
		}

		const result: ClaudeUsage = {
			fiveHourPercent: usage.fiveHour ?? 0,
			weeklyPercent: usage.weekly ?? 0,
			fetchedAt: new Date().toISOString(),
			success: true,
			extraUsageEnabled: usage.extraUsageEnabled || undefined,
			extraUsageSpend: usage.extraUsageSpend,
		};

		// Cache successful result for 5 minutes
		cacheUsage(result);

		return result;
	} catch (error) {
		if (context) {
			await context.close().catch(() => {});
		}

		return {
			fiveHourPercent: 0,
			weeklyPercent: 0,
			fetchedAt: new Date().toISOString(),
			success: false,
			error: `Failed to fetch usage: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Open an interactive browser for logging into Claude
 *
 * Opens a visible browser window so the user can log in.
 * The session is saved to the persistent context for future headless calls.
 *
 * This is designed to be user-friendly:
 * - Auto-detects when login is complete
 * - Polls for usage page to load
 * - Has a reasonable timeout
 * - Provides clear feedback
 */
export async function loginToClaude(): Promise<{ success: boolean; error?: string }> {
	const browserDataPath = getBrowserDataPath();
	let context: BrowserContext | null = null;

	console.log("\n┌─────────────────────────────────────────────────┐");
	console.log("│         Claude Max Login Setup                  │");
	console.log("├─────────────────────────────────────────────────┤");
	console.log("│  A browser window will open.                    │");
	console.log("│  Please log in to your Claude account.          │");
	console.log("│                                                 │");
	console.log("│  Once logged in, navigate to:                   │");
	console.log("│  Settings → Usage                               │");
	console.log("│                                                 │");
	console.log("│  The browser will auto-close when ready.        │");
	console.log("│  (Or close it manually when done)               │");
	console.log("└─────────────────────────────────────────────────┘\n");

	try {
		// Launch visible browser with persistent context
		context = await chromium.launchPersistentContext(browserDataPath, {
			headless: false,
			args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
			userAgent:
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		});

		const page = await context.newPage();

		// Navigate to usage page (will redirect to login if needed)
		console.log("Opening claude.ai/settings/usage...");
		await page.goto(USAGE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

		// Poll for successful login - check every 2 seconds for up to 5 minutes
		const maxWaitMs = 5 * 60 * 1000;
		const pollIntervalMs = 2000;
		const startTime = Date.now();
		let loggedIn = false;

		console.log("Waiting for login...");

		while (Date.now() - startTime < maxWaitMs) {
			try {
				const pageText = (await page.evaluate("document.body.innerText")) as string;
				const url = page.url();

				// Check if we're on the usage page with actual usage data
				if (url.includes("/settings/usage") && pageText.includes("% used")) {
					loggedIn = true;
					console.log("✓ Login detected! Saving session...");
					break;
				}

				// Check if browser was closed by user
				if (page.isClosed()) {
					break;
				}
			} catch {
				// Page might be navigating, that's ok
			}

			await new Promise((r) => setTimeout(r, pollIntervalMs));
		}

		// Give a moment for any final cookies/state to be saved
		if (loggedIn) {
			await new Promise((r) => setTimeout(r, 1000));
		}

		await context.close();

		if (loggedIn) {
			console.log("✓ Session saved! Future calls will use this login.\n");
			return { success: true };
		} else {
			console.log("⚠ Login not detected. You can try again with 'undercity usage --login'\n");
			return { success: false, error: "Login not detected within timeout" };
		}
	} catch (error) {
		if (context) {
			await context.close().catch(() => {});
		}

		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error(`✗ Login failed: ${errorMsg}\n`);
		return { success: false, error: errorMsg };
	}
}

/**
 * Clear the saved browser session
 *
 * Use this if:
 * - You want to log in with a different account
 * - The session has become stale/corrupted
 * - You're troubleshooting login issues
 */
export async function clearBrowserSession(): Promise<void> {
	const { rm } = await import("node:fs/promises");
	const browserDataPath = getBrowserDataPath();

	try {
		if (!existsSync(browserDataPath)) {
			console.log("No browser session to clear.");
			return;
		}

		await rm(browserDataPath, { recursive: true, force: true });
		console.log("✓ Browser session cleared.");
		console.log("  Run 'undercity usage --login' to set up a new session.");
	} catch (error) {
		console.error("✗ Failed to clear browser session:", error);
	}
}

/**
 * Check if a browser session exists
 */
export function hasExistingSession(): boolean {
	const browserDataPath = join(process.cwd(), BROWSER_DATA_DIR);
	return existsSync(browserDataPath);
}
