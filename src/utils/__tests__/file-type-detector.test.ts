import { describe, expect, it } from "vitest";
import { getMimeType, isImageFile, isTextFile } from "../file-type-detector";

describe("file-type-detector", () => {
  describe("isTextFile", () => {
    it("should return true for common text extensions", () => {
      expect(isTextFile("readme.md")).toBe(true);
      expect(isTextFile("data.json")).toBe(true);
      expect(isTextFile("data.csv")).toBe(true);
      expect(isTextFile("notes.txt")).toBe(true);
      expect(isTextFile("index.html")).toBe(true);
      expect(isTextFile("style.css")).toBe(true);
      expect(isTextFile("app.ts")).toBe(true);
      expect(isTextFile("app.js")).toBe(true);
      expect(isTextFile("config.yaml")).toBe(true);
      expect(isTextFile("config.yml")).toBe(true);
      expect(isTextFile("query.sql")).toBe(true);
      expect(isTextFile("script.py")).toBe(true);
      expect(isTextFile("schema.proto")).toBe(true);
    });

    it("should return false for binary extensions", () => {
      expect(isTextFile("photo.png")).toBe(false);
      expect(isTextFile("image.jpg")).toBe(false);
      expect(isTextFile("video.mp4")).toBe(false);
      expect(isTextFile("document.pdf")).toBe(false);
      expect(isTextFile("archive.zip")).toBe(false);
      expect(isTextFile("audio.mp3")).toBe(false);
    });

    it("should be case-insensitive", () => {
      expect(isTextFile("FILE.MD")).toBe(true);
      expect(isTextFile("DATA.JSON")).toBe(true);
    });
  });

  describe("isImageFile", () => {
    it("should return true for image extensions", () => {
      expect(isImageFile("photo.png")).toBe(true);
      expect(isImageFile("photo.jpg")).toBe(true);
      expect(isImageFile("photo.jpeg")).toBe(true);
      expect(isImageFile("photo.gif")).toBe(true);
      expect(isImageFile("photo.webp")).toBe(true);
      expect(isImageFile("icon.svg")).toBe(true);
    });

    it("should return false for non-image files", () => {
      expect(isImageFile("video.mp4")).toBe(false);
      expect(isImageFile("readme.md")).toBe(false);
      expect(isImageFile("data.json")).toBe(false);
    });
  });

  describe("getMimeType", () => {
    it("should return correct MIME types for known extensions", () => {
      expect(getMimeType("image.png")).toBe("image/png");
      expect(getMimeType("image.jpg")).toBe("image/jpeg");
      expect(getMimeType("doc.pdf")).toBe("application/pdf");
      expect(getMimeType("data.json")).toBe("application/json");
      expect(getMimeType("style.css")).toBe("text/css");
      expect(getMimeType("video.mp4")).toBe("video/mp4");
      expect(getMimeType("audio.mp3")).toBe("audio/mpeg");
    });

    it("should return application/octet-stream for unknown extensions", () => {
      expect(getMimeType("file.xyz")).toBe("application/octet-stream");
      expect(getMimeType("file.unknown")).toBe("application/octet-stream");
    });
  });
});
