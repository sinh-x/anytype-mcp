import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSecrets } from "../../utils/sanitizer";
import { loadGrpcCredentials, saveCredentials } from "../credentials";

vi.mock("node:fs");

describe("gRPC credentials (unit)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ANYTYPE_GRPC_TOKEN;
    delete process.env.ANYTYPE_GRPC_ADDRESS;
    vi.clearAllMocks();
    clearSecrets();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("loadGrpcCredentials", () => {
    it("should load token from ANYTYPE_GRPC_TOKEN env var (highest priority)", () => {
      process.env.ANYTYPE_GRPC_TOKEN = "env-grpc-token";

      const result = loadGrpcCredentials();
      expect(result.appToken).toBe("env-grpc-token");
      expect(result.address).toBeUndefined();
    });

    it("should use ANYTYPE_GRPC_ADDRESS env var when set", () => {
      process.env.ANYTYPE_GRPC_TOKEN = "env-grpc-token";
      process.env.ANYTYPE_GRPC_ADDRESS = "192.168.1.100:31007";

      const result = loadGrpcCredentials();
      expect(result.address).toBe("192.168.1.100:31007");
    });

    it("should load from credentials.json when env vars are not set", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          apiKey: "rest-key",
          grpcAppToken: "file-grpc-token",
          grpcAddress: "10.0.0.1:31007",
        }),
      );

      const result = loadGrpcCredentials();
      expect(result.appToken).toBe("file-grpc-token");
      expect(result.address).toBe("10.0.0.1:31007");
    });

    it("should return undefined address when grpcAddress is not in config", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          apiKey: "rest-key",
          grpcAppToken: "file-grpc-token",
        }),
      );

      const result = loadGrpcCredentials();
      expect(result.address).toBeUndefined();
    });

    it("should return no address and no token when no credentials exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = loadGrpcCredentials();
      expect(result.appToken).toBeUndefined();
      expect(result.address).toBeUndefined();
    });

    it("should NOT fall back to apiKey when grpcAppToken is not set (JsonAPI scope lacks FileUpload)", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ apiKey: "rest-only" }));

      const result = loadGrpcCredentials();
      expect(result.appToken).toBeUndefined();
      expect(result.address).toBeUndefined();
    });

    it("should prefer grpcAppToken over apiKey", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ apiKey: "rest-key", grpcAppToken: "grpc-key" }),
      );

      const result = loadGrpcCredentials();
      expect(result.appToken).toBe("grpc-key");
    });

    it("should return no token when neither grpcAppToken nor apiKey exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));

      const result = loadGrpcCredentials();
      expect(result.appToken).toBeUndefined();
      expect(result.address).toBeUndefined();
    });

    it("should prefer env vars over config file", () => {
      process.env.ANYTYPE_GRPC_TOKEN = "env-wins";
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ grpcAppToken: "file-loses" }));

      const result = loadGrpcCredentials();
      expect(result.appToken).toBe("env-wins");
      // Should not have read the file
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });
  });

  describe("saveCredentials read-modify-write", () => {
    it("should preserve existing REST fields when saving gRPC fields", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ apiKey: "existing-key", anytypeVersion: "2025-11-08" }),
      );

      saveCredentials({ grpcAppToken: "new-grpc-token" });

      const written = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.apiKey).toBe("existing-key");
      expect(parsed.anytypeVersion).toBe("2025-11-08");
      expect(parsed.grpcAppToken).toBe("new-grpc-token");
    });

    it("should preserve existing gRPC fields when saving REST fields", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ grpcAppToken: "existing-token", grpcAddress: "10.0.0.1:31007" }),
      );

      saveCredentials({ apiKey: "new-api-key", anytypeVersion: "2025-11-08" });

      const written = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.grpcAppToken).toBe("existing-token");
      expect(parsed.grpcAddress).toBe("10.0.0.1:31007");
      expect(parsed.apiKey).toBe("new-api-key");
    });

    it("should start fresh when existing file is corrupt", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("corrupt file");
      });

      saveCredentials({ grpcAppToken: "new-token" });

      const written = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.grpcAppToken).toBe("new-token");
      expect(parsed.apiKey).toBeUndefined();
    });
  });
});
