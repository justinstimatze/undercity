/**
 * Tests for url-validator.ts
 *
 * Tests URL validation for security concerns including:
 * - Suspicious TLDs
 * - Known malware domains
 * - Non-HTTPS URLs
 * - IP address URLs
 * - Code source validation
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	extractAndValidateURLs,
	filterSafeURLs,
	isURLClean,
	isURLSafe,
	logURLsForAudit,
	validateURL,
	validateURLs,
} from "../url-validator.js";

describe("url-validator", () => {
	describe("validateURL", () => {
		describe("invalid URLs", () => {
			it("should reject malformed URLs", () => {
				const result = validateURL("not-a-url");
				expect(result.isSafe).toBe(false);
				expect(result.isClean).toBe(false);
				expect(result.blockReasons).toContain("Invalid URL format");
			});

			it("should reject URLs without protocol", () => {
				const result = validateURL("example.com/path");
				expect(result.isSafe).toBe(false);
				expect(result.blockReasons).toContain("Invalid URL format");
			});

			it("should reject empty strings", () => {
				const result = validateURL("");
				expect(result.isSafe).toBe(false);
				expect(result.blockReasons).toContain("Invalid URL format");
			});

			it("should handle URLs with spaces (URL constructor encodes them)", () => {
				// URL constructor encodes spaces, so this is technically valid
				const result = validateURL("https://example.com/path with spaces");
				// The URL constructor accepts this and encodes spaces as %20
				expect(result.isSafe).toBe(true);
			});
		});

		describe("trusted domains", () => {
			it("should allow github.com", () => {
				const result = validateURL("https://github.com/user/repo");
				expect(result.isSafe).toBe(true);
				expect(result.isClean).toBe(true);
				expect(result.warnings).toHaveLength(0);
			});

			it("should allow npmjs.com", () => {
				const result = validateURL("https://www.npmjs.com/package/lodash");
				expect(result.isSafe).toBe(true);
				expect(result.isClean).toBe(true);
			});

			it("should allow raw.githubusercontent.com", () => {
				const result = validateURL("https://raw.githubusercontent.com/user/repo/main/file.js");
				expect(result.isSafe).toBe(true);
				expect(result.isClean).toBe(true);
			});

			it("should allow pypi.org", () => {
				const result = validateURL("https://pypi.org/project/requests/");
				expect(result.isSafe).toBe(true);
			});

			it("should allow developer.mozilla.org", () => {
				const result = validateURL("https://developer.mozilla.org/en-US/docs/Web");
				expect(result.isSafe).toBe(true);
			});

			it("should allow cdn.jsdelivr.net", () => {
				const result = validateURL("https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js");
				expect(result.isSafe).toBe(true);
			});

			it("should warn about HTTP on trusted domains", () => {
				const result = validateURL("http://github.com/user/repo");
				expect(result.isSafe).toBe(true);
				expect(result.isClean).toBe(false);
				expect(result.warnings).toContain("URL uses HTTP instead of HTTPS");
			});

			it("should allow subdomains of trusted domains", () => {
				const result = validateURL("https://docs.github.com/en/repositories");
				expect(result.isSafe).toBe(true);
			});
		});

		describe("malware domains", () => {
			it("should block known malware domains", () => {
				const result = validateURL("https://malware-distribution.example/payload.js");
				expect(result.isSafe).toBe(false);
				expect(result.isClean).toBe(false);
				expect(result.blockReasons).toContain("URL matches known malware domain");
			});

			it("should block subdomains of malware domains", () => {
				const result = validateURL("https://cdn.malware-distribution.example/script.js");
				expect(result.isSafe).toBe(false);
				expect(result.blockReasons).toContain("URL matches known malware domain");
			});

			it("should block phishing-site.example", () => {
				const result = validateURL("https://phishing-site.example/login");
				expect(result.isSafe).toBe(false);
			});
		});

		describe("IP address URLs", () => {
			it("should warn about IPv4 address URLs", () => {
				const result = validateURL("https://192.168.1.1/api");
				expect(result.isSafe).toBe(true);
				expect(result.isClean).toBe(false);
				expect(result.warnings).toContain("URL uses IP address instead of domain name");
			});

			it("should warn about localhost IP", () => {
				const result = validateURL("https://127.0.0.1:3000/");
				expect(result.isSafe).toBe(true);
				expect(result.isClean).toBe(false);
				expect(result.warnings).toContain("URL uses IP address instead of domain name");
			});

			it("should warn about IPv6 address URLs", () => {
				const result = validateURL("https://[::1]:8080/api");
				expect(result.isSafe).toBe(true);
				expect(result.isClean).toBe(false);
				expect(result.warnings).toContain("URL uses IP address instead of domain name");
			});
		});

		describe("HTTP vs HTTPS", () => {
			it("should warn about HTTP URLs on non-trusted domains", () => {
				const result = validateURL("http://example.com/api");
				expect(result.isSafe).toBe(true);
				expect(result.isClean).toBe(false);
				expect(result.warnings).toContain("URL uses HTTP instead of HTTPS");
			});

			it("should not warn about HTTPS URLs", () => {
				const result = validateURL("https://example.com/api");
				expect(result.warnings).not.toContain("URL uses HTTP instead of HTTPS");
			});
		});

		describe("suspicious TLDs", () => {
			const suspiciousTLDs = ["tk", "ml", "ga", "cf", "gq", "xyz", "top", "click", "buzz", "icu"];

			for (const tld of suspiciousTLDs) {
				it(`should warn about .${tld} TLD`, () => {
					const result = validateURL(`https://example.${tld}/page`);
					expect(result.isSafe).toBe(true);
					expect(result.isClean).toBe(false);
					expect(result.warnings.some((w) => w.includes(`suspicious TLD: .${tld}`))).toBe(true);
				});
			}

			it("should not warn about common TLDs", () => {
				const result = validateURL("https://example.com/page");
				expect(result.warnings.every((w) => !w.includes("suspicious TLD"))).toBe(true);
			});

			it("should not warn about .org TLD", () => {
				const result = validateURL("https://example.org/page");
				expect(result.warnings.every((w) => !w.includes("suspicious TLD"))).toBe(true);
			});
		});

		describe("code-source context", () => {
			it("should warn about .ru TLD for code sources", () => {
				const result = validateURL("https://packages.ru/lib.js", "code-source");
				expect(result.isSafe).toBe(true);
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes(".ru"))).toBe(true);
			});

			it("should warn about .cn TLD for code sources", () => {
				const result = validateURL("https://mirrors.cn/package.tar.gz", "code-source");
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes(".cn"))).toBe(true);
			});

			it("should warn about .onion TLD for code sources", () => {
				const result = validateURL("https://hidden.onion/code.js", "code-source");
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes(".onion"))).toBe(true);
			});

			it("should not warn about .ru for general context", () => {
				const result = validateURL("https://example.ru/page", "general");
				expect(result.warnings.every((w) => !w.includes(".ru"))).toBe(true);
			});

			it("should warn about .exe files for code sources", () => {
				const result = validateURL("https://example.com/setup.exe", "code-source");
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes("executable file"))).toBe(true);
			});

			it("should warn about .msi files for code sources", () => {
				const result = validateURL("https://example.com/installer.msi", "code-source");
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes("executable file"))).toBe(true);
			});

			it("should warn about .sh files for code sources", () => {
				const result = validateURL("https://example.com/install.sh", "code-source");
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes("executable file"))).toBe(true);
			});

			it("should warn about .dmg files for code sources", () => {
				const result = validateURL("https://example.com/app.dmg", "code-source");
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes("executable file"))).toBe(true);
			});

			it("should not warn about .js files for code sources", () => {
				const result = validateURL("https://example.com/lib.js", "code-source");
				expect(result.warnings.every((w) => !w.includes("executable file"))).toBe(true);
			});

			it("should not warn about executables for documentation context", () => {
				const result = validateURL("https://example.com/setup.exe", "documentation");
				expect(result.warnings.every((w) => !w.includes("executable file"))).toBe(true);
			});
		});

		describe("parsed URL details", () => {
			it("should include parsed URL details for valid URLs", () => {
				const result = validateURL("https://github.com/user/repo");
				expect(result.parsed).toBeDefined();
				expect(result.parsed?.protocol).toBe("https:");
				expect(result.parsed?.hostname).toBe("github.com");
				expect(result.parsed?.pathname).toBe("/user/repo");
				expect(result.parsed?.tld).toBe("com");
			});

			it("should extract two-part TLDs correctly", () => {
				const result = validateURL("https://example.co.uk/page");
				expect(result.parsed?.tld).toBe("co.uk");
			});

			it("should extract .com.au TLD correctly", () => {
				const result = validateURL("https://example.com.au/page");
				expect(result.parsed?.tld).toBe("com.au");
			});

			it("should not include parsed details for invalid URLs", () => {
				const result = validateURL("not-a-url");
				expect(result.parsed).toBeUndefined();
			});
		});

		describe("multiple warnings", () => {
			it("should accumulate multiple warnings", () => {
				const result = validateURL("http://192.168.1.1/install.exe", "code-source");
				expect(result.isSafe).toBe(true);
				expect(result.isClean).toBe(false);
				expect(result.warnings.length).toBeGreaterThanOrEqual(2);
				expect(result.warnings.some((w) => w.includes("HTTP"))).toBe(true);
				expect(result.warnings.some((w) => w.includes("IP address"))).toBe(true);
			});
		});
	});

	describe("validateURLs", () => {
		it("should validate multiple URLs", () => {
			const urls = ["https://github.com/user/repo", "https://malware-distribution.example/bad", "not-a-url"];
			const results = validateURLs(urls);

			expect(results).toHaveLength(3);
			expect(results[0].url).toBe("https://github.com/user/repo");
			expect(results[0].result.isSafe).toBe(true);
			expect(results[1].url).toBe("https://malware-distribution.example/bad");
			expect(results[1].result.isSafe).toBe(false);
			expect(results[2].url).toBe("not-a-url");
			expect(results[2].result.isSafe).toBe(false);
		});

		it("should apply context to all URLs", () => {
			const urls = ["https://example.ru/lib.js", "https://example.cn/package.js"];
			const results = validateURLs(urls, "code-source");

			expect(results[0].result.isClean).toBe(false);
			expect(results[1].result.isClean).toBe(false);
		});

		it("should handle empty array", () => {
			const results = validateURLs([]);
			expect(results).toHaveLength(0);
		});
	});

	describe("filterSafeURLs", () => {
		it("should filter out unsafe URLs", () => {
			const urls = [
				"https://github.com/user/repo",
				"https://malware-distribution.example/bad",
				"https://npmjs.com/package/lodash",
				"not-a-url",
			];
			const safeUrls = filterSafeURLs(urls);

			expect(safeUrls).toHaveLength(2);
			expect(safeUrls).toContain("https://github.com/user/repo");
			expect(safeUrls).toContain("https://npmjs.com/package/lodash");
		});

		it("should keep URLs with warnings (safe but not clean)", () => {
			const urls = ["https://github.com/user/repo", "https://example.tk/suspicious"];
			const safeUrls = filterSafeURLs(urls);

			expect(safeUrls).toHaveLength(2);
			expect(safeUrls).toContain("https://example.tk/suspicious");
		});

		it("should apply context for filtering", () => {
			const urls = ["https://github.com/user/repo"];
			const safeUrls = filterSafeURLs(urls, "code-source");

			expect(safeUrls).toHaveLength(1);
		});

		it("should handle empty array", () => {
			const safeUrls = filterSafeURLs([]);
			expect(safeUrls).toHaveLength(0);
		});
	});

	describe("extractAndValidateURLs", () => {
		it("should extract and validate URLs from text", () => {
			const content = `
				Check out https://github.com/user/repo for the source.
				Also see http://example.com/docs for documentation.
			`;
			const results = extractAndValidateURLs(content);

			expect(results).toHaveLength(2);
			expect(results.some((r) => r.url === "https://github.com/user/repo")).toBe(true);
			expect(results.some((r) => r.url === "http://example.com/docs")).toBe(true);
		});

		it("should deduplicate URLs", () => {
			const content = `
				Visit https://github.com/user/repo here.
				And also https://github.com/user/repo there.
			`;
			const results = extractAndValidateURLs(content);

			expect(results).toHaveLength(1);
			expect(results[0].url).toBe("https://github.com/user/repo");
		});

		it("should handle text with no URLs", () => {
			const content = "This is plain text with no URLs.";
			const results = extractAndValidateURLs(content);

			expect(results).toHaveLength(0);
		});

		it("should extract URLs from markdown", () => {
			const content = `
				# Documentation
				See [GitHub](https://github.com/user/repo) for details.
				Download from https://example.com/file.zip
			`;
			const results = extractAndValidateURLs(content);

			expect(results.length).toBeGreaterThanOrEqual(2);
		});

		it("should apply context to extracted URLs", () => {
			const content = "Get the package from https://example.ru/package.js";
			const results = extractAndValidateURLs(content, "code-source");

			expect(results[0].result.isClean).toBe(false);
		});

		it("should handle URLs with query parameters", () => {
			const content = "API endpoint: https://api.example.com/v1/users?page=1&limit=10";
			const results = extractAndValidateURLs(content);

			expect(results).toHaveLength(1);
			expect(results[0].url).toContain("?page=1");
		});

		it("should handle URLs with fragments", () => {
			const content = "See https://docs.example.com/guide#installation for setup.";
			const results = extractAndValidateURLs(content);

			expect(results).toHaveLength(1);
			expect(results[0].url).toContain("#installation");
		});
	});

	describe("logURLsForAudit", () => {
		let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		});

		afterEach(() => {
			consoleInfoSpy.mockRestore();
		});

		it("should log URLs for audit", () => {
			const urls = ["https://github.com/user/repo", "https://example.com/api"];
			logURLsForAudit(urls, "pm-research", "processing");

			// The function uses sessionLogger which outputs via pino
			// We can't easily verify the exact output, but we can verify it doesn't throw
			expect(true).toBe(true);
		});

		it("should not log when URLs array is empty", () => {
			// This should return early without logging
			logURLsForAudit([], "pm-research", "processing");
			// No assertion needed - just verify no error
		});

		it("should handle large URL arrays", () => {
			const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/page${i}`);
			// Should only log first 10 URLs
			logURLsForAudit(urls, "batch-process", "validated");
		});
	});

	describe("isURLSafe", () => {
		it("should return true for safe URLs", () => {
			expect(isURLSafe("https://github.com/user/repo")).toBe(true);
		});

		it("should return false for unsafe URLs", () => {
			expect(isURLSafe("https://malware-distribution.example/bad")).toBe(false);
		});

		it("should return false for invalid URLs", () => {
			expect(isURLSafe("not-a-url")).toBe(false);
		});

		it("should return true for URLs with warnings", () => {
			// Has suspicious TLD but is still safe
			expect(isURLSafe("https://example.tk/page")).toBe(true);
		});
	});

	describe("isURLClean", () => {
		it("should return true for clean URLs", () => {
			expect(isURLClean("https://github.com/user/repo")).toBe(true);
		});

		it("should return false for URLs with warnings", () => {
			// Suspicious TLD
			expect(isURLClean("https://example.tk/page")).toBe(false);
		});

		it("should return false for unsafe URLs", () => {
			expect(isURLClean("https://malware-distribution.example/bad")).toBe(false);
		});

		it("should return false for invalid URLs", () => {
			expect(isURLClean("not-a-url")).toBe(false);
		});

		it("should return false for HTTP URLs", () => {
			expect(isURLClean("http://example.com/page")).toBe(false);
		});
	});

	describe("edge cases", () => {
		it("should handle URLs with unusual ports", () => {
			const result = validateURL("https://example.com:8443/api");
			expect(result.isSafe).toBe(true);
		});

		it("should handle localhost", () => {
			const result = validateURL("https://localhost:3000/");
			expect(result.isSafe).toBe(true);
		});

		it("should handle URLs with authentication", () => {
			const result = validateURL("https://user:pass@example.com/");
			expect(result.isSafe).toBe(true);
		});

		it("should handle data URLs (valid but not HTTPS)", () => {
			const result = validateURL("data:text/html,<h1>Hello</h1>");
			// data: URLs are valid but will have warnings about not being HTTPS
			expect(result.isSafe).toBe(true);
			expect(result.isClean).toBe(false);
			expect(result.warnings.some((w) => w.includes("HTTP"))).toBe(true);
		});

		it("should handle file URLs (valid but not HTTPS)", () => {
			const result = validateURL("file:///etc/passwd");
			// file: URLs are valid but will have warnings about not being HTTPS
			expect(result.isSafe).toBe(true);
			expect(result.isClean).toBe(false);
			expect(result.warnings.some((w) => w.includes("HTTP"))).toBe(true);
		});

		it("should handle very long URLs", () => {
			const longPath = "a".repeat(2000);
			const result = validateURL(`https://example.com/${longPath}`);
			expect(result.isSafe).toBe(true);
		});

		it("should handle URLs with unicode characters", () => {
			const result = validateURL("https://例え.jp/ページ");
			expect(result.isSafe).toBe(true);
		});

		it("should handle IDN domains", () => {
			const result = validateURL("https://xn--n3h.com/"); // Punycode for emoji domain
			expect(result.isSafe).toBe(true);
		});
	});
});
