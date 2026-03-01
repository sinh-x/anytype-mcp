import { describe, expect, it } from "vitest";
import {
  FILE_DOWNLOAD_TOOL,
  FILE_DOWNLOAD_TOOL_NAME,
  FILE_READ_TOOL,
  FILE_READ_TOOL_NAME,
  FILE_UPLOAD_TOOL,
  FILE_UPLOAD_TOOL_NAME,
} from "../file-tools";

describe("file-tools", () => {
  describe("FILE_UPLOAD_TOOL", () => {
    it("should have the correct name", () => {
      expect(FILE_UPLOAD_TOOL.name).toBe("file-upload");
      expect(FILE_UPLOAD_TOOL_NAME).toBe("file-upload");
    });

    it("should require space_id", () => {
      const schema = FILE_UPLOAD_TOOL.inputSchema as { required: string[] };
      expect(schema.required).toContain("space_id");
    });

    it("should have local_path and url properties", () => {
      const schema = FILE_UPLOAD_TOOL.inputSchema as { properties: Record<string, unknown> };
      expect(schema.properties).toHaveProperty("local_path");
      expect(schema.properties).toHaveProperty("url");
    });

    it("should have type enum with valid values", () => {
      const schema = FILE_UPLOAD_TOOL.inputSchema as { properties: Record<string, { enum?: string[] }> };
      expect(schema.properties.type.enum).toEqual(["None", "File", "Image", "Video", "Audio", "PDF"]);
    });

    it("should not use API- prefix", () => {
      expect(FILE_UPLOAD_TOOL.name).not.toMatch(/^API-/);
    });
  });

  describe("FILE_DOWNLOAD_TOOL", () => {
    it("should have the correct name", () => {
      expect(FILE_DOWNLOAD_TOOL.name).toBe("file-download");
      expect(FILE_DOWNLOAD_TOOL_NAME).toBe("file-download");
    });

    it("should require object_id", () => {
      const schema = FILE_DOWNLOAD_TOOL.inputSchema as { required: string[] };
      expect(schema.required).toContain("object_id");
    });

    it("should have optional path property", () => {
      const schema = FILE_DOWNLOAD_TOOL.inputSchema as {
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(schema.properties).toHaveProperty("path");
      expect(schema.required).not.toContain("path");
    });
  });

  describe("FILE_READ_TOOL", () => {
    it("should have the correct name", () => {
      expect(FILE_READ_TOOL.name).toBe("file-read");
      expect(FILE_READ_TOOL_NAME).toBe("file-read");
    });

    it("should require object_id", () => {
      const schema = FILE_READ_TOOL.inputSchema as { required: string[] };
      expect(schema.required).toContain("object_id");
    });

    it("should mention size limit in description", () => {
      expect(FILE_READ_TOOL.description).toContain("10MB");
    });
  });
});
