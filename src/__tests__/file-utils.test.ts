/**
 * File Utilities Tests
 */

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic, writeFileAtomicAsync, writeJsonAtomic, writeJsonAtomicAsync } from "../file-utils.js";

// Mock file system
vi.mock("node:fs");
vi.mock("node:fs/promises");

const mockFs = fs as unknown as {
	existsSync: ReturnType<typeof vi.fn>;
	writeFileSync: ReturnType<typeof vi.fn>;
	renameSync: ReturnType<typeof vi.fn>;
	unlinkSync: ReturnType<typeof vi.fn>;
	mkdirSync: ReturnType<typeof vi.fn>;
};

const mockFsPromises = fsPromises as unknown as {
	writeFile: ReturnType<typeof vi.fn>;
	rename: ReturnType<typeof vi.fn>;
	unlink: ReturnType<typeof vi.fn>;
};

describe("File Utilities", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFs.existsSync = vi.fn().mockReturnValue(true);
		mockFs.writeFileSync = vi.fn();
		mockFs.renameSync = vi.fn();
		mockFs.unlinkSync = vi.fn();
		mockFs.mkdirSync = vi.fn();
		mockFsPromises.writeFile = vi.fn().mockResolvedValue(undefined);
		mockFsPromises.rename = vi.fn().mockResolvedValue(undefined);
		mockFsPromises.unlink = vi.fn().mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("writeFileAtomic", () => {
		it("should write to temp file then rename atomically", () => {
			const filePath = "/test/file.txt";
			const content = "test content";

			writeFileAtomic(filePath, content);

			expect(mockFs.writeFileSync).toHaveBeenCalledWith("/test/file.txt.tmp", content, {
				encoding: "utf-8",
				flag: "w",
			});
			expect(mockFs.renameSync).toHaveBeenCalledWith("/test/file.txt.tmp", "/test/file.txt");
		});

		it("should create directory if it doesn't exist", () => {
			mockFs.existsSync = vi.fn().mockReturnValue(false);

			writeFileAtomic("/test/subdir/file.txt", "content");

			expect(mockFs.mkdirSync).toHaveBeenCalledWith("/test/subdir", { recursive: true });
		});

		it("should cleanup temp file on error", () => {
			mockFs.writeFileSync.mockImplementation(() => {
				throw new Error("Write failed");
			});

			expect(() => writeFileAtomic("/test/file.txt", "content")).toThrow("Write failed");
			expect(mockFs.unlinkSync).toHaveBeenCalledWith("/test/file.txt.tmp");
		});

		it("should handle custom encoding", () => {
			writeFileAtomic("/test/file.txt", "content", { encoding: "ascii" });

			expect(mockFs.writeFileSync).toHaveBeenCalledWith("/test/file.txt.tmp", "content", {
				encoding: "ascii",
				flag: "w",
			});
		});
	});

	describe("writeFileAtomicAsync", () => {
		it("should write to temp file then rename atomically", async () => {
			const filePath = "/test/file.txt";
			const content = "test content";

			await writeFileAtomicAsync(filePath, content);

			expect(mockFsPromises.writeFile).toHaveBeenCalledWith("/test/file.txt.tmp", content, {
				encoding: "utf-8",
				flag: "w",
			});
			expect(mockFsPromises.rename).toHaveBeenCalledWith("/test/file.txt.tmp", "/test/file.txt");
		});

		it("should create directory if it doesn't exist", async () => {
			mockFs.existsSync = vi.fn().mockReturnValue(false);

			await writeFileAtomicAsync("/test/subdir/file.txt", "content");

			expect(mockFs.mkdirSync).toHaveBeenCalledWith("/test/subdir", { recursive: true });
		});

		it("should cleanup temp file on error", async () => {
			mockFsPromises.writeFile.mockRejectedValue(new Error("Write failed"));

			await expect(writeFileAtomicAsync("/test/file.txt", "content")).rejects.toThrow("Write failed");
			expect(mockFsPromises.unlink).toHaveBeenCalledWith("/test/file.txt.tmp");
		});

		it("should handle custom encoding", async () => {
			await writeFileAtomicAsync("/test/file.txt", "content", { encoding: "base64" });

			expect(mockFsPromises.writeFile).toHaveBeenCalledWith("/test/file.txt.tmp", "content", {
				encoding: "base64",
				flag: "w",
			});
		});
	});

	describe("writeJsonAtomic", () => {
		it("should serialize object to JSON and write atomically", () => {
			const data = { test: "value", number: 42 };

			writeJsonAtomic("/test/data.json", data);

			expect(mockFs.writeFileSync).toHaveBeenCalledWith("/test/data.json.tmp", JSON.stringify(data, null, 2), {
				encoding: "utf-8",
				flag: "w",
			});
			expect(mockFs.renameSync).toHaveBeenCalledWith("/test/data.json.tmp", "/test/data.json");
		});

		it("should handle custom JSON spacing", () => {
			const data = { test: "value" };

			writeJsonAtomic("/test/data.json", data, 4);

			expect(mockFs.writeFileSync).toHaveBeenCalledWith("/test/data.json.tmp", JSON.stringify(data, null, 4), {
				encoding: "utf-8",
				flag: "w",
			});
		});
	});

	describe("writeJsonAtomicAsync", () => {
		it("should serialize object to JSON and write atomically", async () => {
			const data = { test: "value", array: [1, 2, 3] };

			await writeJsonAtomicAsync("/test/data.json", data);

			expect(mockFsPromises.writeFile).toHaveBeenCalledWith("/test/data.json.tmp", JSON.stringify(data, null, 2), {
				encoding: "utf-8",
				flag: "w",
			});
			expect(mockFsPromises.rename).toHaveBeenCalledWith("/test/data.json.tmp", "/test/data.json");
		});

		it("should handle custom JSON spacing", async () => {
			const data = { test: "value" };

			await writeJsonAtomicAsync("/test/data.json", data, 0);

			expect(mockFsPromises.writeFile).toHaveBeenCalledWith("/test/data.json.tmp", JSON.stringify(data, null, 0), {
				encoding: "utf-8",
				flag: "w",
			});
		});
	});
});
