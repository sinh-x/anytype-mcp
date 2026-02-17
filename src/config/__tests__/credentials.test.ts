import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSecrets } from "../../utils/sanitizer";
import { CREDENTIALS_PATH, loadCredentials, saveCredentials } from "../credentials";

vi.mock("node:fs");

describe("credentials", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENAPI_MCP_HEADERS;
    vi.clearAllMocks();
    clearSecrets();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("CREDENTIALS_PATH", () => {
    it("should point to ~/.config/sinh-x/anytype-mcp/credentials.json", () => {
      expect(CREDENTIALS_PATH).toContain(path.join(".config", "sinh-x", "anytype-mcp", "credentials.json"));
    });
  });

  describe("loadCredentials", () => {
    it("should load headers from OPENAPI_MCP_HEADERS env var (highest priority)", () => {
      process.env.OPENAPI_MCP_HEADERS = JSON.stringify({
        Authorization: "Bearer env-token",
        "Anytype-Version": "2025-11-08",
      });

      const result = loadCredentials();
      expect(result.headers).toEqual({
        Authorization: "Bearer env-token",
        "Anytype-Version": "2025-11-08",
      });
      expect(result.baseUrl).toBeUndefined();
    });

    it("should return empty headers and warn on non-object OPENAPI_MCP_HEADERS", () => {
      const consoleSpy = vi.spyOn(console, "warn");
      process.env.OPENAPI_MCP_HEADERS = '"string"';

      const result = loadCredentials();
      expect(result.headers).toEqual({});
      expect(consoleSpy).toHaveBeenCalledWith(
        "OPENAPI_MCP_HEADERS environment variable must be a JSON object, got:",
        "string",
      );
    });

    it("should return empty headers and warn on invalid JSON in OPENAPI_MCP_HEADERS", () => {
      const consoleSpy = vi.spyOn(console, "warn");
      process.env.OPENAPI_MCP_HEADERS = "invalid json";

      const result = loadCredentials();
      expect(result.headers).toEqual({});
      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to parse OPENAPI_MCP_HEADERS environment variable:",
        expect.any(Error),
      );
    });

    it("should load from credentials.json when env var is not set", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          apiKey: "file-token",
          anytypeVersion: "2025-11-08",
          baseUrl: "http://custom:31009",
        }),
      );

      const result = loadCredentials();
      expect(result.headers).toEqual({
        Authorization: "Bearer file-token",
        "Anytype-Version": "2025-11-08",
      });
      expect(result.baseUrl).toBe("http://custom:31009");
    });

    it("should add Bearer prefix to apiKey when not present", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ apiKey: "raw-token" }));

      const result = loadCredentials();
      expect(result.headers.Authorization).toBe("Bearer raw-token");
    });

    it("should not double-prefix apiKey that already starts with Bearer", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ apiKey: "Bearer already-prefixed" }));

      const result = loadCredentials();
      expect(result.headers.Authorization).toBe("Bearer already-prefixed");
    });

    it("should skip Anytype-Version header when anytypeVersion is not set", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ apiKey: "token" }));

      const result = loadCredentials();
      expect(result.headers).toEqual({ Authorization: "Bearer token" });
      expect(result.headers["Anytype-Version"]).toBeUndefined();
    });

    it("should return empty headers when credentials.json is missing apiKey", () => {
      const consoleSpy = vi.spyOn(console, "warn");
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ anytypeVersion: "2025-11-08" }));

      const result = loadCredentials();
      expect(result.headers).toEqual({});
      expect(consoleSpy).toHaveBeenCalledWith("credentials.json is missing required 'apiKey' field");
    });

    it("should return empty headers when credentials file does not exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = loadCredentials();
      expect(result.headers).toEqual({});
      expect(result.baseUrl).toBeUndefined();
    });

    it("should return empty headers and warn on malformed credentials file", () => {
      const consoleSpy = vi.spyOn(console, "warn");
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("read error");
      });

      const result = loadCredentials();
      expect(result.headers).toEqual({});
      expect(consoleSpy).toHaveBeenCalledWith("Failed to read credentials file:", expect.any(Error));
    });

    it("should prefer env var over config file", () => {
      process.env.OPENAPI_MCP_HEADERS = JSON.stringify({ Authorization: "Bearer env-wins" });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ apiKey: "file-loses" }));

      const result = loadCredentials();
      expect(result.headers.Authorization).toBe("Bearer env-wins");
      // Should not have read the file
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });
  });

  describe("saveCredentials", () => {
    it("should create directory and write credentials file", () => {
      saveCredentials({ apiKey: "test-key", anytypeVersion: "2025-11-08" });

      expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(CREDENTIALS_PATH), { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        CREDENTIALS_PATH,
        JSON.stringify({ apiKey: "test-key", anytypeVersion: "2025-11-08" }, null, 2) + "\n",
        "utf-8",
      );
    });

    it("should include baseUrl when provided", () => {
      saveCredentials({ apiKey: "test-key", anytypeVersion: "2025-11-08", baseUrl: "http://custom:31009" });

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        CREDENTIALS_PATH,
        JSON.stringify(
          { apiKey: "test-key", anytypeVersion: "2025-11-08", baseUrl: "http://custom:31009" },
          null,
          2,
        ) + "\n",
        "utf-8",
      );
    });

    it("should omit baseUrl when not provided", () => {
      saveCredentials({ apiKey: "test-key", anytypeVersion: "2025-11-08" });

      const written = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed).not.toHaveProperty("baseUrl");
    });
  });
});
