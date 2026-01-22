/**
 * URL Validator
 *
 * Validates URLs from web research results for security.
 * Detects suspicious TLDs, known malware domains, and logs
 * external URLs for audit trail.
 *
 * | Check | Action |
 * |-------|--------|
 * | Suspicious TLDs | Warn |
 * | Known malware domains | Block |
 * | Non-HTTPS | Warn |
 * | IP address URLs | Warn |
 */

import { sessionLogger } from "./logger.js";

/**
 * Result of URL validation
 */
export interface URLValidationResult {
	/** Whether the URL is safe to use */
	isSafe: boolean;
	/** Whether the URL passed all checks (no warnings) */
	isClean: boolean;
	/** Reasons for blocking (if not safe) */
	blockReasons: string[];
	/** Warnings (URL is safe but suspicious) */
	warnings: string[];
	/** Parsed URL details (if valid URL) */
	parsed?: {
		protocol: string;
		hostname: string;
		pathname: string;
		tld: string;
	};
}

/**
 * TLDs that warrant extra scrutiny for code/package sources
 * These aren't inherently malicious but are frequently used in phishing/malware
 */
const SUSPICIOUS_TLDS = new Set([
	// Frequently abused
	"tk",
	"ml",
	"ga",
	"cf",
	"gq", // Freenom domains
	"xyz",
	"top",
	"work",
	"click",
	"link",
	"buzz",
	"surf",
	"site",
	"online",
	"live",
	"fun",
	"icu",
	"monster",
	// Regional TLDs sometimes abused
	"cc",
	"ws",
	"to",
	"pw",
	"su",
]);

/**
 * TLDs that should trigger warnings when used for code sources
 * (not inherently dangerous, but unusual for legitimate package sources)
 */
const CODE_SOURCE_SUSPICIOUS_TLDS = new Set([
	"ru",
	"cn",
	"ir",
	"kp", // Country codes often filtered in corporate environments
	"onion", // Tor hidden services
	"bit", // Namecoin
	"bazar", // OpenNIC
]);

/**
 * Known malware distribution domains (blocklist)
 * This is a small sample - in production, this would be loaded from an external source
 */
const MALWARE_DOMAINS = new Set([
	// Placeholder entries - real implementation would use threat intelligence feeds
	"malware-distribution.example",
	"phishing-site.example",
	"evil-downloads.example",
]);

/**
 * Known legitimate domains that should never be blocked
 */
const TRUSTED_DOMAINS = new Set([
	// Package registries
	"npmjs.com",
	"www.npmjs.com",
	"registry.npmjs.org",
	"pypi.org",
	"pypi.python.org",
	"crates.io",
	"rubygems.org",
	"packagist.org",
	"nuget.org",
	"pub.dev",
	"hex.pm",
	"cran.r-project.org",

	// Code hosting
	"github.com",
	"raw.githubusercontent.com",
	"gitlab.com",
	"bitbucket.org",
	"codeberg.org",
	"sourceforge.net",
	"sr.ht",

	// Documentation
	"docs.python.org",
	"nodejs.org",
	"developer.mozilla.org",
	"mdn.io",
	"devdocs.io",
	"typescriptlang.org",
	"reactjs.org",
	"vuejs.org",
	"angular.io",

	// CDNs commonly used for packages
	"cdn.jsdelivr.net",
	"unpkg.com",
	"esm.sh",
	"deno.land",
	"jsr.io",

	// Cloud providers
	"amazonaws.com",
	"azure.com",
	"googleapis.com",
	"cloudflare.com",

	// Major tech companies
	"microsoft.com",
	"google.com",
	"apple.com",
	"anthropic.com",
	"openai.com",
]);

/**
 * Extract TLD from hostname
 */
function extractTLD(hostname: string): string {
	const parts = hostname.split(".");
	if (parts.length < 2) return hostname;

	// Handle common 2-part TLDs
	const twoPartTLDs = ["co.uk", "com.au", "org.uk", "ac.uk", "gov.uk", "co.jp", "co.kr", "com.br"];
	const lastTwo = parts.slice(-2).join(".");
	if (twoPartTLDs.includes(lastTwo) && parts.length > 2) {
		return lastTwo;
	}

	return parts[parts.length - 1];
}

/**
 * Check if hostname is an IP address
 */
function isIPAddress(hostname: string): boolean {
	// IPv4
	const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
	if (ipv4Regex.test(hostname)) {
		return true;
	}

	// IPv6 (simplified check)
	if (hostname.includes(":") && !hostname.includes(".")) {
		return true;
	}

	return false;
}

/**
 * Check if hostname or any of its parents is in a domain set
 */
function matchesDomainSet(hostname: string, domainSet: Set<string>): boolean {
	// Direct match
	if (domainSet.has(hostname)) {
		return true;
	}

	// Check parent domains
	const parts = hostname.split(".");
	for (let i = 1; i < parts.length; i++) {
		const parent = parts.slice(i).join(".");
		if (domainSet.has(parent)) {
			return true;
		}
	}

	return false;
}

/**
 * Validate a URL for security concerns
 *
 * @param url - URL string to validate
 * @param context - Context for validation (e.g., "code-source", "documentation")
 * @returns Validation result with safety status and details
 */
export function validateURL(
	url: string,
	context: "code-source" | "documentation" | "general" = "general",
): URLValidationResult {
	const result: URLValidationResult = {
		isSafe: true,
		isClean: true,
		blockReasons: [],
		warnings: [],
	};

	// Try to parse the URL
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		result.isSafe = false;
		result.isClean = false;
		result.blockReasons.push("Invalid URL format");
		return result;
	}

	const hostname = parsed.hostname.toLowerCase();
	const tld = extractTLD(hostname);

	result.parsed = {
		protocol: parsed.protocol,
		hostname,
		pathname: parsed.pathname,
		tld,
	};

	// Check if it's a trusted domain (skip further checks)
	if (matchesDomainSet(hostname, TRUSTED_DOMAINS)) {
		// Only warn about HTTP for trusted domains
		if (parsed.protocol !== "https:") {
			result.warnings.push("URL uses HTTP instead of HTTPS");
			result.isClean = false;
		}
		return result;
	}

	// Check known malware domains (block)
	if (matchesDomainSet(hostname, MALWARE_DOMAINS)) {
		result.isSafe = false;
		result.isClean = false;
		result.blockReasons.push("URL matches known malware domain");
		sessionLogger.warn({ url, hostname }, "Blocked URL: matches known malware domain");
		return result;
	}

	// Check for IP address URLs (warn)
	if (isIPAddress(hostname)) {
		result.warnings.push("URL uses IP address instead of domain name");
		result.isClean = false;
		sessionLogger.debug({ url, hostname }, "URL warning: uses IP address");
	}

	// Check protocol (warn for non-HTTPS)
	if (parsed.protocol !== "https:") {
		result.warnings.push("URL uses HTTP instead of HTTPS");
		result.isClean = false;
	}

	// Check suspicious TLDs
	if (SUSPICIOUS_TLDS.has(tld)) {
		result.warnings.push(`URL uses suspicious TLD: .${tld}`);
		result.isClean = false;
		sessionLogger.debug({ url, tld }, "URL warning: suspicious TLD");
	}

	// Additional checks for code source context
	if (context === "code-source") {
		if (CODE_SOURCE_SUSPICIOUS_TLDS.has(tld)) {
			result.warnings.push(`URL TLD (.${tld}) is unusual for code sources`);
			result.isClean = false;
			sessionLogger.debug({ url, tld }, "URL warning: unusual TLD for code source");
		}

		// Check for suspicious file extensions in path
		const suspiciousExtensions = [".exe", ".msi", ".bat", ".ps1", ".sh", ".dmg", ".pkg"];
		const pathname = parsed.pathname.toLowerCase();
		for (const ext of suspiciousExtensions) {
			if (pathname.endsWith(ext)) {
				result.warnings.push(`URL points to executable file (${ext})`);
				result.isClean = false;
				break;
			}
		}
	}

	return result;
}

/**
 * Validate multiple URLs and return combined results
 *
 * @param urls - Array of URLs to validate
 * @param context - Context for validation
 * @returns Array of validation results
 */
export function validateURLs(
	urls: string[],
	context: "code-source" | "documentation" | "general" = "general",
): Array<{
	url: string;
	result: URLValidationResult;
}> {
	return urls.map((url) => ({
		url,
		result: validateURL(url, context),
	}));
}

/**
 * Filter URLs, returning only safe ones
 *
 * @param urls - Array of URLs to filter
 * @param context - Context for validation
 * @returns Filtered array of safe URLs
 */
export function filterSafeURLs(
	urls: string[],
	context: "code-source" | "documentation" | "general" = "general",
): string[] {
	return urls.filter((url) => validateURL(url, context).isSafe);
}

/**
 * Extract and validate URLs from text content
 *
 * @param content - Text content that may contain URLs
 * @param context - Context for validation
 * @returns Array of validated URL results
 */
export function extractAndValidateURLs(
	content: string,
	context: "code-source" | "documentation" | "general" = "general",
): Array<{
	url: string;
	result: URLValidationResult;
}> {
	// Extract URLs from content
	const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
	const urls = content.match(urlRegex) || [];

	// Remove duplicates
	const uniqueUrls = [...new Set(urls)];

	return validateURLs(uniqueUrls, context);
}

/**
 * Log URLs for audit trail
 *
 * @param urls - URLs to log
 * @param source - Source of the URLs (e.g., "pm-research")
 * @param action - Action being taken (e.g., "processing", "blocked")
 */
export function logURLsForAudit(urls: string[], source: string, action: string): void {
	if (urls.length === 0) return;

	sessionLogger.info({ source, action, urlCount: urls.length, urls: urls.slice(0, 10) }, `URL audit: ${action}`);
}

/**
 * Quick check if a URL is safe
 *
 * @param url - URL to check
 * @returns true if URL is safe
 */
export function isURLSafe(url: string): boolean {
	return validateURL(url).isSafe;
}

/**
 * Quick check if a URL is clean (safe with no warnings)
 *
 * @param url - URL to check
 * @returns true if URL is clean
 */
export function isURLClean(url: string): boolean {
	return validateURL(url).isClean;
}
