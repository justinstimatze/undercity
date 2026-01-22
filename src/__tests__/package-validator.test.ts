/**
 * Tests for package-validator.ts
 *
 * Tests package extraction and validation from task objectives.
 */

import { describe, expect, it } from "vitest";
import {
	arePackagesSafe,
	extractPackageInstalls,
	getPackageWarnings,
	getTrustedPackages,
	validatePackageLocal,
	validatePackagesInObjective,
} from "../package-validator.js";

describe("package-validator", () => {
	describe("extractPackageInstalls", () => {
		describe("npm patterns", () => {
			it("should extract basic npm install", () => {
				const result = extractPackageInstalls("npm install lodash");
				expect(result).toHaveLength(1);
				expect(result[0]).toEqual({
					manager: "npm",
					packageName: "lodash",
					version: undefined,
				});
			});

			it("should extract npm install with version", () => {
				const result = extractPackageInstalls("npm install lodash@4.17.21");
				expect(result).toHaveLength(1);
				expect(result[0].packageName).toBe("lodash");
				expect(result[0].version).toBe("4.17.21");
			});

			it("should extract npm i shorthand", () => {
				const result = extractPackageInstalls("npm i express");
				expect(result).toHaveLength(1);
				expect(result[0].packageName).toBe("express");
			});

			it("should extract npm install -g", () => {
				const result = extractPackageInstalls("npm install -g typescript");
				expect(result).toHaveLength(1);
				expect(result[0].packageName).toBe("typescript");
			});

			it("should extract npm install -D", () => {
				const result = extractPackageInstalls("npm install -D vitest");
				expect(result).toHaveLength(1);
				expect(result[0].packageName).toBe("vitest");
			});

			it("should extract scoped packages", () => {
				const result = extractPackageInstalls("npm install @types/node");
				expect(result).toHaveLength(1);
				expect(result[0].packageName).toBe("@types/node");
			});

			it("should extract npx commands", () => {
				const result = extractPackageInstalls("npx add create-react-app");
				expect(result).toHaveLength(1);
				expect(result[0].manager).toBe("npm");
			});
		});

		describe("yarn patterns", () => {
			it("should extract yarn add", () => {
				const result = extractPackageInstalls("yarn add react");
				expect(result).toHaveLength(1);
				expect(result[0].manager).toBe("yarn");
				expect(result[0].packageName).toBe("react");
			});

			it("should extract yarn add with version", () => {
				const result = extractPackageInstalls("yarn add react@18.2.0");
				expect(result).toHaveLength(1);
				expect(result[0].version).toBe("18.2.0");
			});
		});

		describe("pnpm patterns", () => {
			it("should extract pnpm add", () => {
				const result = extractPackageInstalls("pnpm add vue");
				expect(result).toHaveLength(1);
				expect(result[0].manager).toBe("pnpm");
				expect(result[0].packageName).toBe("vue");
			});

			it("should extract pnpm install", () => {
				const result = extractPackageInstalls("pnpm install svelte");
				expect(result).toHaveLength(1);
				expect(result[0].packageName).toBe("svelte");
			});
		});

		describe("pip patterns", () => {
			it("should extract pip install", () => {
				const result = extractPackageInstalls("pip install requests");
				expect(result).toHaveLength(1);
				expect(result[0].manager).toBe("pip");
				expect(result[0].packageName).toBe("requests");
			});

			it("should extract pip3 install", () => {
				const result = extractPackageInstalls("pip3 install flask");
				expect(result).toHaveLength(1);
				expect(result[0].manager).toBe("pip");
				expect(result[0].packageName).toBe("flask");
			});

			it("should extract pip install with version", () => {
				const result = extractPackageInstalls("pip install django==4.2");
				expect(result).toHaveLength(1);
				expect(result[0].version).toBe("4.2");
			});

			it("should extract pip install with flags", () => {
				const result = extractPackageInstalls("pip install -U numpy");
				expect(result).toHaveLength(1);
				expect(result[0].packageName).toBe("numpy");
			});
		});

		describe("multiple packages", () => {
			it("should extract multiple packages from text", () => {
				const text = "First npm install lodash then pip install requests";
				const result = extractPackageInstalls(text);
				expect(result).toHaveLength(2);
				expect(result[0].packageName).toBe("lodash");
				expect(result[1].packageName).toBe("requests");
			});
		});

		describe("no packages", () => {
			it("should return empty array for text without packages", () => {
				const result = extractPackageInstalls("Add error handling to api.ts");
				expect(result).toHaveLength(0);
			});
		});
	});

	describe("validatePackageLocal", () => {
		describe("trusted packages", () => {
			it("should pass trusted npm packages", () => {
				const result = validatePackageLocal("lodash", "npm");
				expect(result.isSafe).toBe(true);
				expect(result.isClean).toBe(true);
				expect(result.warnings).toHaveLength(0);
			});

			it("should pass trusted pip packages", () => {
				const result = validatePackageLocal("requests", "pip");
				expect(result.isSafe).toBe(true);
				expect(result.isClean).toBe(true);
			});

			it("should pass well-known scoped packages", () => {
				const result = validatePackageLocal("@types/node", "npm");
				expect(result.isSafe).toBe(true);
				expect(result.isClean).toBe(true);
			});
		});

		describe("typosquatting detection", () => {
			it("should warn about packages very similar to popular ones", () => {
				const result = validatePackageLocal("lodahs", "npm"); // 1 char swap
				expect(result.isSafe).toBe(true);
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes("similar"))).toBe(true);
			});

			it("should warn about -js suffix pattern", () => {
				const result = validatePackageLocal("react-js", "npm");
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes("-js"))).toBe(true);
			});

			it("should warn about js- prefix pattern", () => {
				const result = validatePackageLocal("js-lodash", "npm");
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes("js-"))).toBe(true);
			});

			it("should warn about node- prefix pattern", () => {
				const result = validatePackageLocal("node-request", "npm");
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes("node-"))).toBe(true);
			});
		});

		describe("suspicious patterns", () => {
			it("should warn about very short package names", () => {
				const result = validatePackageLocal("ab", "npm");
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes("short"))).toBe(true);
			});

			it("should warn about very long package names", () => {
				const longName = "a".repeat(60);
				const result = validatePackageLocal(longName, "npm");
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes("long"))).toBe(true);
			});

			it("should warn about names starting with numbers", () => {
				const result = validatePackageLocal("123package", "npm");
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes("number"))).toBe(true);
			});

			it("should warn about double dashes", () => {
				const result = validatePackageLocal("my--package", "npm");
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes("double"))).toBe(true);
			});

			it("should warn about double underscores", () => {
				const result = validatePackageLocal("my__package", "npm");
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes("double"))).toBe(true);
			});

			it("should warn about unknown scoped packages", () => {
				const result = validatePackageLocal("@unknown-org/package", "npm");
				expect(result.isClean).toBe(false);
				expect(result.warnings.some((w) => w.includes("Scoped"))).toBe(true);
			});
		});

		describe("yarn/pnpm handling", () => {
			it("should normalize yarn to npm for validation", () => {
				const result = validatePackageLocal("lodash", "yarn");
				expect(result.isSafe).toBe(true);
				expect(result.isClean).toBe(true);
			});

			it("should normalize pnpm to npm for validation", () => {
				const result = validatePackageLocal("express", "pnpm");
				expect(result.isSafe).toBe(true);
				expect(result.isClean).toBe(true);
			});
		});
	});

	describe("validatePackagesInObjective", () => {
		it("should validate packages in task objective", () => {
			const objective = "Install lodash with npm install lodash";
			const results = validatePackagesInObjective(objective);

			expect(results).toHaveLength(1);
			expect(results[0].package).toBe("lodash");
			expect(results[0].result.isSafe).toBe(true);
		});

		it("should validate multiple packages", () => {
			const objective = "npm install lodash and pip install requests";
			const results = validatePackagesInObjective(objective);

			expect(results).toHaveLength(2);
		});

		it("should return empty array for no packages", () => {
			const results = validatePackagesInObjective("Add error handling");
			expect(results).toHaveLength(0);
		});
	});

	describe("arePackagesSafe", () => {
		it("should return true for safe packages", () => {
			expect(arePackagesSafe("npm install lodash")).toBe(true);
		});

		it("should return true for no packages", () => {
			expect(arePackagesSafe("Fix the bug in parser")).toBe(true);
		});

		it("should return true for suspicious but not blocked packages", () => {
			// Package validation currently only warns, doesn't block
			expect(arePackagesSafe("npm install suspicious--package")).toBe(true);
		});
	});

	describe("getPackageWarnings", () => {
		it("should return warnings for suspicious packages", () => {
			const warnings = getPackageWarnings("npm install lodahs"); // typo
			expect(warnings.length).toBeGreaterThan(0);
			expect(warnings[0]).toContain("lodahs");
		});

		it("should return empty array for trusted packages", () => {
			const warnings = getPackageWarnings("npm install lodash");
			expect(warnings).toHaveLength(0);
		});

		it("should return empty array for no packages", () => {
			const warnings = getPackageWarnings("Fix the bug");
			expect(warnings).toHaveLength(0);
		});

		it("should combine warnings from multiple packages", () => {
			const warnings = getPackageWarnings("npm install my--bad and pip install ab");
			expect(warnings.length).toBe(2);
		});
	});

	describe("getTrustedPackages", () => {
		it("should return trusted packages list", () => {
			const trusted = getTrustedPackages();

			expect(trusted.npm.length).toBeGreaterThan(0);
			expect(trusted.pip.length).toBeGreaterThan(0);
		});

		it("should include common npm packages", () => {
			const trusted = getTrustedPackages();

			expect(trusted.npm).toContain("lodash");
			expect(trusted.npm).toContain("express");
			expect(trusted.npm).toContain("react");
			expect(trusted.npm).toContain("typescript");
		});

		it("should include common pip packages", () => {
			const trusted = getTrustedPackages();

			expect(trusted.pip).toContain("requests");
			expect(trusted.pip).toContain("flask");
			expect(trusted.pip).toContain("django");
			expect(trusted.pip).toContain("numpy");
		});
	});
});
