import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrpcClient, GrpcClientError } from "../grpc-client";

// Mock @grpc/grpc-js — must use vi.hoisted() for variables referenced in vi.mock factories
const { mockClient, MockMetadata, MockClientCommands } = vi.hoisted(() => {
  const mockClient = {
    walletCreateSession: vi.fn(),
    fileUpload: vi.fn(),
    fileDownload: vi.fn(),
    close: vi.fn(),
  };

  // Must be proper classes since they're called with `new`
  class MockMetadata {
    add = vi.fn();
  }

  class MockClientCommands {
    walletCreateSession = mockClient.walletCreateSession;
    fileUpload = mockClient.fileUpload;
    fileDownload = mockClient.fileDownload;
    close = mockClient.close;
  }

  return { mockClient, MockMetadata, MockClientCommands };
});

vi.mock("@grpc/grpc-js", () => ({
  credentials: {
    createInsecure: vi.fn(() => "insecure"),
  },
  Metadata: MockMetadata,
  loadPackageDefinition: vi.fn(() => ({
    anytype: {
      ClientCommands: MockClientCommands,
    },
  })),
}));

// Mock @grpc/proto-loader
vi.mock("@grpc/proto-loader", () => ({
  load: vi.fn(() => Promise.resolve({})),
}));

// Mock fs for proto path resolution
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

describe("GrpcClient", () => {
  let client: GrpcClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new GrpcClient({ address: "127.0.0.1:31010" });
  });

  afterEach(() => {
    client.close();
  });

  describe("ensureConnected", () => {
    it("should load protos and create gRPC channel", async () => {
      await client.ensureConnected();
      const protoLoader = await import("@grpc/proto-loader");
      expect(protoLoader.load).toHaveBeenCalledWith("pb/protos/service/service.proto", expect.any(Object));
    });

    it("should not reconnect if already connected", async () => {
      await client.ensureConnected();
      await client.ensureConnected();
      const protoLoader = await import("@grpc/proto-loader");
      expect(protoLoader.load).toHaveBeenCalledTimes(1);
    });
  });

  describe("createSession", () => {
    it("should call walletCreateSession with mnemonic", async () => {
      mockClient.walletCreateSession.mockImplementation(
        (_req: unknown, _meta: unknown, cb: (err: null, resp: unknown) => void) => {
          cb(null, { error: { code: 0 }, token: "session-token", appToken: "app-token", accountId: "acc-123" });
        },
      );

      await client.ensureConnected();
      const result = await client.createSession("word1 word2 word3");

      expect(result.token).toBe("session-token");
      expect(result.appToken).toBe("app-token");
      expect(result.accountId).toBe("acc-123");
      expect(mockClient.walletCreateSession).toHaveBeenCalledWith(
        { mnemonic: "word1 word2 word3" },
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("should throw GrpcClientError on non-zero error code", async () => {
      mockClient.walletCreateSession.mockImplementation(
        (_req: unknown, _meta: unknown, cb: (err: null, resp: unknown) => void) => {
          cb(null, { error: { code: 1, description: "bad input" }, token: "", appToken: "", accountId: "" });
        },
      );

      await client.ensureConnected();
      await expect(client.createSession("bad")).rejects.toThrow(GrpcClientError);
    });
  });

  describe("fileUpload", () => {
    beforeEach(async () => {
      // Auto-connect without authentication
      mockClient.walletCreateSession.mockImplementation(
        (_req: unknown, _meta: unknown, cb: (err: null, resp: unknown) => void) => {
          cb(null, { error: { code: 0 }, token: "tok", appToken: "app", accountId: "acc" });
        },
      );
    });

    it("should call fileUpload RPC with correct parameters", async () => {
      mockClient.fileUpload.mockImplementation(
        (_req: unknown, _meta: unknown, cb: (err: null, resp: unknown) => void) => {
          cb(null, { error: { code: 0 }, objectId: "obj-123", details: {} });
        },
      );

      await client.ensureConnected();
      const result = await client.fileUpload({
        spaceId: "space-1",
        localPath: "/tmp/image.png",
        type: "Image",
        imageKind: "Basic",
      });

      expect(result.objectId).toBe("obj-123");
      expect(mockClient.fileUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          spaceId: "space-1",
          localPath: "/tmp/image.png",
          type: 2, // Image
          imageKind: 0, // Basic
          origin: 9, // api
        }),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("should throw GrpcClientError on upload failure", async () => {
      mockClient.fileUpload.mockImplementation(
        (_req: unknown, _meta: unknown, cb: (err: null, resp: unknown) => void) => {
          cb(null, { error: { code: 2, description: "bad input" }, objectId: "" });
        },
      );

      await client.ensureConnected();
      await expect(
        client.fileUpload({ spaceId: "space-1", localPath: "/nonexistent" }),
      ).rejects.toThrow(GrpcClientError);
    });
  });

  describe("fileDownload", () => {
    it("should call fileDownload RPC with correct parameters", async () => {
      mockClient.fileDownload.mockImplementation(
        (_req: unknown, _meta: unknown, cb: (err: null, resp: unknown) => void) => {
          cb(null, { error: { code: 0 }, localPath: "/tmp/downloaded.png" });
        },
      );

      await client.ensureConnected();
      const result = await client.fileDownload({ objectId: "obj-123", path: "/tmp" });

      expect(result.localPath).toBe("/tmp/downloaded.png");
      expect(mockClient.fileDownload).toHaveBeenCalledWith(
        { objectId: "obj-123", path: "/tmp" },
        expect.any(Object),
        expect.any(Function),
      );
    });
  });

  describe("close", () => {
    it("should close the gRPC client", async () => {
      await client.ensureConnected();
      client.close();
      expect(mockClient.close).toHaveBeenCalled();
    });
  });

  describe("GrpcClientError", () => {
    it("should have correct properties", () => {
      const error = new GrpcClientError("test message", "TEST_CODE", "details");
      expect(error.name).toBe("GrpcClientError");
      expect(error.message).toBe("test message");
      expect(error.code).toBe("TEST_CODE");
      expect(error.details).toBe("details");
      expect(error).toBeInstanceOf(Error);
    });
  });
});
