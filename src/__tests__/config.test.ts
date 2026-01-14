/**
 * Tests for config.ts
 *
 * Tests configuration loading, merging, file precedence,
 * and validation with mock fs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock state
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
let mockCwd = "/project";
let mockHomedir = "/home/user";

// Mock os module
vi.mock("node:os", () => ({
	homedir: vi.fn(() => mockHomedir),
}));

// Mock fs module
vi.mock("node:fs", () => ({
	existsSync: vi.fn((path: string): boolean => {
		return mockFiles.has(path) || mockDirs.has(path);
	}),
	readFileSync: vi.fn((path: string, _encoding: string): string => {
		const content = mockFiles.get(path);
		if (content === undefined) {
			throw new Error(`ENOENT: no such file or directory, open '${path}'`);
		}
		return content;
	}),
}));

// Mock process.cwd
const _originalCwd = process.cwd;
Object.defineProperty(process, "cwd", {
	value: () => mockCwd,
	writable: true,
});

// Import after mocking
import {
	clearConfigCache,
	getConfigSource,
	getDefaultConfig,
	loadConfig,
	mergeWithConfig,
	type UndercityRc,
} from "../config.js";

describe("config.ts", () => {
	beforeEach(() => {
		mockFiles.clear();
		mockDirs.clear();
		mockCwd = "/project";
		mockHomedir = "/home/user";
		clearConfigCache();
		vi.clearAllMocks();
	});

	afterEach(() => {
		clearConfigCache();
		vi.resetAllMocks();
	});

	describe("loadConfig", () => {
		it("should return default config when no config files exist", () => {
			const config = loadConfig();

			expect(config.stream).toBe(false);
			expect(config.verbose).toBe(false);
			expect(config.model).toBe("sonnet");
			expect(config.worker).toBe("sonnet");
			expect(config.autoCommit).toBe(true);
			expect(config.typecheck).toBe(true);
			expect(config.local).toBe(true);
			expect(config.review).toBe(false);
			expect(config.annealing).toBe(false);
			expect(config.supervised).toBe(false);
			expect(config.parallel).toBe(1);
			expect(config.push).toBe(false);
			expect(config.maxAttempts).toBe(7);
			expect(config.maxRetriesPerTier).toBe(3);
			expect(config.maxReviewPassesPerTier).toBe(2);
			expect(config.maxOpusReviewPasses).toBe(6);
		});

		it("should load config from home directory", () => {
			const homeConfig: UndercityRc = {
				verbose: true,
				model: "opus",
			};
			mockFiles.set(`${mockHomedir}/.undercityrc`, JSON.stringify(homeConfig));

			const config = loadConfig();

			expect(config.verbose).toBe(true);
			expect(config.model).toBe("opus");
			// Other defaults should remain
			expect(config.autoCommit).toBe(true);
		});

		it("should load config from current working directory", () => {
			const cwdConfig: UndercityRc = {
				stream: true,
				worker: "haiku",
			};
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(cwdConfig));

			const config = loadConfig();

			expect(config.stream).toBe(true);
			expect(config.worker).toBe("haiku");
			expect(config.model).toBe("sonnet"); // default
		});

		it("should prefer cwd config over home config (precedence)", () => {
			const homeConfig: UndercityRc = {
				verbose: true,
				model: "haiku",
			};
			const cwdConfig: UndercityRc = {
				model: "opus",
			};

			mockFiles.set(`${mockHomedir}/.undercityrc`, JSON.stringify(homeConfig));
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(cwdConfig));

			const config = loadConfig();

			// cwd config should override home config for model
			expect(config.model).toBe("opus");
			// home config should still apply for verbose
			expect(config.verbose).toBe(true);
		});

		it("should merge home and cwd configs correctly", () => {
			const homeConfig: UndercityRc = {
				verbose: true,
				review: true,
			};
			const cwdConfig: UndercityRc = {
				stream: true,
				model: "haiku",
			};

			mockFiles.set(`${mockHomedir}/.undercityrc`, JSON.stringify(homeConfig));
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(cwdConfig));

			const config = loadConfig();

			expect(config.verbose).toBe(true);
			expect(config.review).toBe(true);
			expect(config.stream).toBe(true);
			expect(config.model).toBe("haiku");
		});

		it("should cache config on subsequent calls", () => {
			const cwdConfig: UndercityRc = {
				stream: true,
			};
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(cwdConfig));

			const config1 = loadConfig();
			expect(config1.stream).toBe(true);

			// Change the file (shouldn't affect cached result)
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify({ stream: false }));

			const config2 = loadConfig();
			expect(config2.stream).toBe(true);
		});

		it("should reload config when forceReload is true", () => {
			const cwdConfig: UndercityRc = {
				stream: true,
			};
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(cwdConfig));

			const config1 = loadConfig();
			expect(config1.stream).toBe(true);

			// Change the file
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify({ stream: false }));

			const config2 = loadConfig(true); // forceReload
			expect(config2.stream).toBe(false);
		});

		it("should return new object each time (no shared reference)", () => {
			const config1 = loadConfig();
			const config2 = loadConfig();

			expect(config1).not.toBe(config2);
			expect(config1).toEqual(config2);
		});

		it("should track config source (home directory)", () => {
			const homeConfig: UndercityRc = { verbose: true };
			mockFiles.set(`${mockHomedir}/.undercityrc`, JSON.stringify(homeConfig));

			loadConfig();
			const source = getConfigSource();

			expect(source).toBe(`${mockHomedir}/.undercityrc`);
		});

		it("should track config source (current working directory)", () => {
			const cwdConfig: UndercityRc = { stream: true };
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(cwdConfig));

			loadConfig();
			const source = getConfigSource();

			expect(source).toBe(`${mockCwd}/.undercityrc`);
		});

		it("should prefer cwd source when both exist", () => {
			const homeConfig: UndercityRc = { verbose: true };
			const cwdConfig: UndercityRc = { stream: true };

			mockFiles.set(`${mockHomedir}/.undercityrc`, JSON.stringify(homeConfig));
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(cwdConfig));

			loadConfig();
			const source = getConfigSource();

			expect(source).toBe(`${mockCwd}/.undercityrc`);
		});
	});

	describe("Validation", () => {
		it("should validate boolean options correctly", () => {
			const config: UndercityRc = {
				stream: true,
				verbose: false,
				autoCommit: true,
				typecheck: false,
				local: true,
				review: false,
				annealing: true,
				supervised: false,
				push: true,
			};
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(config));

			const loaded = loadConfig();

			expect(loaded.stream).toBe(true);
			expect(loaded.verbose).toBe(false);
			expect(loaded.autoCommit).toBe(true);
			expect(loaded.review).toBe(false);
			expect(loaded.annealing).toBe(true);
		});

		it("should validate number options and reject invalid ranges", () => {
			// Mock console.warn to suppress warnings
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const config: UndercityRc = {
				parallel: 5,
				maxAttempts: 10,
				maxRetriesPerTier: 3,
				maxReviewPassesPerTier: 2,
				maxOpusReviewPasses: 6,
			};
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(config));

			const loaded = loadConfig();

			expect(loaded.parallel).toBe(5);
			expect(loaded.maxAttempts).toBe(10);
			expect(loaded.maxRetriesPerTier).toBe(3);

			consoleWarnSpy.mockRestore();
		});

		it("should reject invalid model tiers", () => {
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const config = {
				model: "invalid-model",
			};
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(config));

			const loaded = loadConfig();

			// Should use default model instead
			expect(loaded.model).toBe("sonnet");
			expect(consoleWarnSpy).toHaveBeenCalled();

			consoleWarnSpy.mockRestore();
		});

		it("should accept valid model tiers", () => {
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			for (const model of ["haiku", "sonnet", "opus"]) {
				clearConfigCache();
				mockFiles.clear();

				const config = { model };
				mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(config));

				const loaded = loadConfig();
				expect(loaded.model).toBe(model);
			}

			consoleWarnSpy.mockRestore();
		});

		it("should reject invalid worker models", () => {
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const config = {
				worker: "opus", // Invalid: only haiku and sonnet allowed
			};
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(config));

			const loaded = loadConfig();

			expect(loaded.worker).toBe("sonnet"); // default
			expect(consoleWarnSpy).toHaveBeenCalled();

			consoleWarnSpy.mockRestore();
		});

		it("should accept valid worker models", () => {
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			for (const model of ["haiku", "sonnet"]) {
				clearConfigCache();
				mockFiles.clear();

				const config = { worker: model };
				mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(config));

				const loaded = loadConfig();
				expect(loaded.worker).toBe(model);
			}

			consoleWarnSpy.mockRestore();
		});

		it("should ignore invalid JSON in config file", () => {
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			mockFiles.set(`${mockCwd}/.undercityrc`, "{ invalid json }");

			const config = loadConfig();

			expect(config.model).toBe("sonnet"); // default
			expect(consoleWarnSpy).toHaveBeenCalled();

			consoleWarnSpy.mockRestore();
		});

		it("should ignore non-object config values", () => {
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			mockFiles.set(`${mockCwd}/.undercityrc`, '"not an object"');

			const config = loadConfig();

			expect(config.model).toBe("sonnet"); // default
			expect(consoleWarnSpy).toHaveBeenCalled();

			consoleWarnSpy.mockRestore();
		});

		it("should reject out-of-range number values", () => {
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const config = {
				parallel: 20, // max is 10
				maxAttempts: 50, // max is 20
			};
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(config));

			const loaded = loadConfig();

			expect(loaded.parallel).toBe(1); // default
			expect(loaded.maxAttempts).toBe(7); // default
			expect(consoleWarnSpy).toHaveBeenCalled();

			consoleWarnSpy.mockRestore();
		});

		it("should warn about invalid field values", () => {
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const config = {
				verbose: "not a boolean",
				parallel: 3.5, // not an integer
			};
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(config));

			const loaded = loadConfig();

			expect(loaded.verbose).toBe(false); // default
			expect(loaded.parallel).toBe(1); // default
			expect(consoleWarnSpy).toHaveBeenCalled();

			consoleWarnSpy.mockRestore();
		});
	});

	describe("mergeWithConfig", () => {
		it("should merge CLI options with config defaults", () => {
			const cwdConfig: UndercityRc = {
				verbose: true,
				model: "haiku",
			};
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(cwdConfig));

			const cliOptions = {
				stream: true,
			};

			const merged = mergeWithConfig(cliOptions);

			expect(merged.verbose).toBe(true); // from config
			expect(merged.model).toBe("haiku"); // from config
			expect(merged.stream).toBe(true); // from CLI
		});

		it("should prefer CLI options over config file values", () => {
			const cwdConfig: UndercityRc = {
				model: "haiku",
				verbose: false,
			};
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(cwdConfig));

			const cliOptions = {
				model: "opus", // Override config
				stream: true, // New value
			};

			const merged = mergeWithConfig(cliOptions);

			expect(merged.model).toBe("opus"); // CLI overrides config
			expect(merged.verbose).toBe(false); // from config
			expect(merged.stream).toBe(true); // from CLI
		});

		it("should ignore undefined CLI options", () => {
			const cwdConfig: UndercityRc = {
				verbose: true,
			};
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(cwdConfig));

			const cliOptions: Record<string, unknown> = {
				model: undefined, // Should be ignored
				stream: true,
			};

			const merged = mergeWithConfig(cliOptions);

			expect(merged.verbose).toBe(true);
			expect(merged.model).toBe("sonnet"); // default, not overridden
			expect(merged.stream).toBe(true);
		});

		it("should handle empty CLI options", () => {
			const cwdConfig: UndercityRc = {
				verbose: true,
				model: "opus",
			};
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(cwdConfig));

			const cliOptions = {};

			const merged = mergeWithConfig(cliOptions);

			expect(merged.verbose).toBe(true);
			expect(merged.model).toBe("opus");
		});

		it("should include all default config properties", () => {
			const merged = mergeWithConfig({});

			// Check all properties exist
			expect(merged.stream).toBeDefined();
			expect(merged.verbose).toBeDefined();
			expect(merged.model).toBeDefined();
			expect(merged.worker).toBeDefined();
			expect(merged.autoCommit).toBeDefined();
			expect(merged.typecheck).toBeDefined();
			expect(merged.local).toBeDefined();
			expect(merged.review).toBeDefined();
			expect(merged.annealing).toBeDefined();
			expect(merged.supervised).toBeDefined();
			expect(merged.parallel).toBeDefined();
			expect(merged.push).toBeDefined();
			expect(merged.maxAttempts).toBeDefined();
			expect(merged.maxRetriesPerTier).toBeDefined();
			expect(merged.maxReviewPassesPerTier).toBeDefined();
			expect(merged.maxOpusReviewPasses).toBeDefined();
		});

		it("should support arbitrary CLI options", () => {
			const cliOptions = {
				customOption: "customValue",
				anotherOption: 42,
			};

			const merged = mergeWithConfig(cliOptions);

			expect(merged.customOption).toBe("customValue");
			expect(merged.anotherOption).toBe(42);
		});
	});

	describe("getDefaultConfig", () => {
		it("should return complete default config", () => {
			const defaults = getDefaultConfig();

			expect(defaults.stream).toBe(false);
			expect(defaults.verbose).toBe(false);
			expect(defaults.model).toBe("sonnet");
			expect(defaults.worker).toBe("sonnet");
			expect(defaults.autoCommit).toBe(true);
			expect(defaults.typecheck).toBe(true);
			expect(defaults.local).toBe(true);
			expect(defaults.review).toBe(false);
			expect(defaults.annealing).toBe(false);
			expect(defaults.supervised).toBe(false);
			expect(defaults.parallel).toBe(1);
			expect(defaults.push).toBe(false);
			expect(defaults.maxAttempts).toBe(7);
			expect(defaults.maxRetriesPerTier).toBe(3);
			expect(defaults.maxReviewPassesPerTier).toBe(2);
			expect(defaults.maxOpusReviewPasses).toBe(6);
			expect(defaults.autoApprove).toBe(false);
			expect(defaults.maxRetries).toBe(3);
		});

		it("should return a copy, not the original object", () => {
			const defaults1 = getDefaultConfig();
			const defaults2 = getDefaultConfig();

			expect(defaults1).not.toBe(defaults2);
			expect(defaults1).toEqual(defaults2);
		});

		it("should not be affected by config file changes", () => {
			const defaults1 = getDefaultConfig();

			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify({ verbose: true }));

			const defaults2 = getDefaultConfig();

			expect(defaults1).toEqual(defaults2);
			expect(defaults2.verbose).toBe(false);
		});
	});

	describe("clearConfigCache", () => {
		it("should clear cached config", () => {
			const cwdConfig: UndercityRc = {
				verbose: true,
			};
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(cwdConfig));

			loadConfig();
			expect(getConfigSource()).toBe(`${mockCwd}/.undercityrc`);

			clearConfigCache();
			expect(getConfigSource()).toBeNull();
		});

		it("should allow reloading config after clear", () => {
			const cwdConfig: UndercityRc = {
				verbose: true,
			};
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(cwdConfig));

			const config1 = loadConfig();
			expect(config1.verbose).toBe(true);

			clearConfigCache();
			mockFiles.clear();

			const config2 = loadConfig();
			expect(config2.verbose).toBe(false); // default
		});
	});

	describe("Complex precedence scenarios", () => {
		it("should handle multiple config changes with precedence", () => {
			// Step 1: Load home config only
			const homeConfig: UndercityRc = {
				verbose: true,
				model: "haiku",
				parallel: 2,
			};
			mockFiles.set(`${mockHomedir}/.undercityrc`, JSON.stringify(homeConfig));

			let config = loadConfig();
			expect(config.verbose).toBe(true);
			expect(config.model).toBe("haiku");
			expect(config.parallel).toBe(2);

			// Step 2: Add cwd config with partial override
			clearConfigCache();
			const cwdConfig: UndercityRc = {
				model: "opus", // Override
				review: true, // New
			};
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(cwdConfig));

			config = loadConfig();
			expect(config.verbose).toBe(true); // from home
			expect(config.model).toBe("opus"); // from cwd
			expect(config.parallel).toBe(2); // from home
			expect(config.review).toBe(true); // from cwd
		});

		it("should handle all config sources together", () => {
			const homeConfig: UndercityRc = {
				verbose: true,
				review: true,
				parallel: 3,
			};
			const cwdConfig: UndercityRc = {
				model: "haiku",
				stream: true,
			};
			const cliOptions = {
				verbose: false, // Override home config
				maxAttempts: 5, // Override default
			};

			mockFiles.set(`${mockHomedir}/.undercityrc`, JSON.stringify(homeConfig));
			mockFiles.set(`${mockCwd}/.undercityrc`, JSON.stringify(cwdConfig));

			const merged = mergeWithConfig(cliOptions);

			expect(merged.verbose).toBe(false); // CLI overrides all
			expect(merged.review).toBe(true); // from home
			expect(merged.model).toBe("haiku"); // from cwd
			expect(merged.stream).toBe(true); // from cwd
			expect(merged.parallel).toBe(3); // from home
			expect(merged.maxAttempts).toBe(5); // from CLI
		});
	});
});
