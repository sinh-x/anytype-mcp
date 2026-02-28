import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Headers } from "node-fetch";
import { OpenAPIV3 } from "openapi-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../client/http-client";
import { loadCredentials } from "../../config/credentials";
import { MCPProxy } from "../proxy";

// Mock the dependencies
vi.mock("../../client/http-client");
vi.mock("@modelcontextprotocol/sdk/server/index.js");
vi.mock("../../config/credentials", () => ({
  loadCredentials: vi.fn(() => ({ headers: {}, baseUrl: undefined })),
}));

const mockLoadCredentials = vi.mocked(loadCredentials);
const MockServer = vi.mocked(Server);

describe("MCPProxy", () => {
  let proxy: MCPProxy;
  let mockOpenApiSpec: OpenAPIV3.Document;

  const getHandlers = (proxy: MCPProxy) => {
    const server = (proxy as any).server;
    return server.setRequestHandler.mock.calls
      .flatMap((x: unknown[]) => x)
      .filter((x: unknown) => typeof x === "function");
  };

  const createMockOpenApiSpec = (overrides?: Partial<OpenAPIV3.Document>): OpenAPIV3.Document => ({
    openapi: "3.0.0",
    servers: [{ url: "http://localhost:3000" }],
    info: { title: "Test API", version: "1.0.0" },
    paths: {
      "/test": {
        get: {
          operationId: "getTest",
          responses: { "200": { description: "Success" } },
        },
      },
    },
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenApiSpec = createMockOpenApiSpec();
    proxy = new MCPProxy("test-proxy", mockOpenApiSpec);
  });

  describe("listTools handler", () => {
    it("should return converted tools from OpenAPI spec", async () => {
      const [listToolsHandler] = getHandlers(proxy);
      const result = await listToolsHandler();

      expect(result).toHaveProperty("tools");
      expect(Array.isArray(result.tools)).toBe(true);
    });

    it("should truncate tool names exceeding 64 characters", async () => {
      const specWithLongName = createMockOpenApiSpec({
        paths: {
          "/test": {
            get: {
              operationId: "a".repeat(65),
              responses: { "200": { description: "Success" } },
            },
          },
        },
      });
      const testProxy = new MCPProxy("test-proxy", specWithLongName);
      const [listToolsHandler] = getHandlers(testProxy);
      const result = await listToolsHandler();

      expect(result.tools[0].name.length).toBeLessThanOrEqual(64);
    });
  });

  describe("callTool handler", () => {
    const mockSuccessResponse = {
      data: { message: "success" },
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
    };

    it("should execute operation and return formatted response", async () => {
      (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockSuccessResponse);

      (proxy as any).openApiLookup = {
        "API-getTest": {
          operationId: "getTest",
          responses: { "200": { description: "Success" } },
          method: "get",
          path: "/test",
        },
      };

      const [, callToolHandler] = getHandlers(proxy);
      const result = await callToolHandler({ params: { name: "API-getTest", arguments: {} } });

      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ message: "success" }) }],
      });
    });

    it("should throw error for non-existent operation", async () => {
      const [, callToolHandler] = getHandlers(proxy);

      await expect(callToolHandler({ params: { name: "nonExistentMethod", arguments: {} } })).rejects.toThrow(
        "Method nonExistentMethod not found",
      );
    });

    it("should handle tool names exceeding 64 characters", async () => {
      (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockSuccessResponse);

      const longToolName = "a".repeat(65);
      const truncatedToolName = longToolName.slice(0, 64);
      (proxy as any).openApiLookup = {
        [truncatedToolName]: {
          operationId: longToolName,
          responses: { "200": { description: "Success" } },
          method: "get",
          path: "/test",
        },
      };

      const [, callToolHandler] = getHandlers(proxy);
      const result = await callToolHandler({ params: { name: truncatedToolName, arguments: {} } });

      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ message: "success" }) }],
      });
    });
  });

  describe("loadCredentials integration", () => {
    const expectHeaders = (headers: Record<string, string>) => {
      expect(HttpClient).toHaveBeenCalledWith(expect.objectContaining({ headers }), expect.anything());
    };

    it("should pass headers from loadCredentials to HttpClient", () => {
      mockLoadCredentials.mockReturnValueOnce({
        headers: { Authorization: "Bearer token123", "X-Custom-Header": "test" },
      });
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expectHeaders({ Authorization: "Bearer token123", "X-Custom-Header": "test" });
    });

    it("should pass empty headers when loadCredentials returns none", () => {
      mockLoadCredentials.mockReturnValueOnce({ headers: {} });
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expectHeaders({});
    });

    it("should use baseUrl from loadCredentials when provided", () => {
      mockLoadCredentials.mockReturnValueOnce({
        headers: {},
        baseUrl: "http://config-file:31009",
      });
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: "http://config-file:31009" }),
        expect.anything(),
      );
    });
  });

  describe("base URL integration", () => {
    const originalEnv = process.env;
    const expectBaseUrl = (url: string) => {
      expect(HttpClient).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: url }), expect.anything());
    };

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should use ANYTYPE_API_BASE_URL when set", () => {
      process.env.ANYTYPE_API_BASE_URL = "http://localhost:31012";
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expectBaseUrl("http://localhost:31012");
    });

    it("should use spec servers when env var not set", () => {
      delete process.env.ANYTYPE_API_BASE_URL;
      new MCPProxy("test-proxy", mockOpenApiSpec);
      expectBaseUrl("http://localhost:3000");
    });

    it("should use default when neither env var nor spec servers available", () => {
      delete process.env.ANYTYPE_API_BASE_URL;
      new MCPProxy("test-proxy", createMockOpenApiSpec({ servers: undefined }));
      expectBaseUrl("http://127.0.0.1:31009");
    });
  });

  describe("instructions", () => {
    it("should pass instructions to Server when provided", () => {
      MockServer.mockClear();

      new MCPProxy("test-proxy", mockOpenApiSpec, "Available spaces:\n- MySpace (id: abc123)");

      expect(MockServer).toHaveBeenCalledWith(
        { name: "test-proxy", version: "1.0.0" },
        expect.objectContaining({ instructions: "Available spaces:\n- MySpace (id: abc123)" }),
      );
    });

    it("should not include instructions when not provided", () => {
      MockServer.mockClear();

      new MCPProxy("test-proxy", mockOpenApiSpec);

      const serverOptions = MockServer.mock.calls[0][1];
      expect(serverOptions).not.toHaveProperty("instructions");
    });
  });

  describe("cache integration", () => {
    const mockObjectResponse = {
      data: {
        object: {
          id: "obj-1",
          name: "Test Object",
          type: { key: "page", name: "Page" },
          properties: [{ key: "last_modified_date", date: "2025-06-01T12:00:00Z" }],
          markdown: "# Content",
        },
      },
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
    };

    beforeEach(() => {
      (proxy as any).openApiLookup = {
        "API-get-object": {
          operationId: "get_object",
          method: "get",
          path: "/v1/spaces/{space_id}/objects/{object_id}",
          responses: { "200": { description: "Success" } },
        },
        "API-update-object": {
          operationId: "update_object",
          method: "patch",
          path: "/v1/spaces/{space_id}/objects/{object_id}",
          responses: { "200": { description: "Success" } },
        },
        "API-delete-object": {
          operationId: "delete_object",
          method: "delete",
          path: "/v1/spaces/{space_id}/objects/{object_id}",
          responses: { "200": { description: "Success" } },
        },
      };
    });

    it("should cache get-object response and return cached on second call", async () => {
      const mockExecute = HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>;
      mockExecute.mockResolvedValue(mockObjectResponse);

      const [, callToolHandler] = getHandlers(proxy);
      const args = { space_id: "space-1", object_id: "obj-1" };

      // First call — fetches from API
      const result1 = await callToolHandler({ params: { name: "API-get-object", arguments: args } });
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(JSON.parse(result1.content[0].text)).toEqual(mockObjectResponse.data);

      // Second call — should be from cache
      mockExecute.mockClear();
      const result2 = await callToolHandler({ params: { name: "API-get-object", arguments: args } });
      expect(mockExecute).not.toHaveBeenCalled();
      expect(JSON.parse(result2.content[0].text)).toEqual(mockObjectResponse.data);
    });

    it("should invalidate cache on update-object", async () => {
      const mockExecute = HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>;
      mockExecute.mockResolvedValue(mockObjectResponse);

      const [, callToolHandler] = getHandlers(proxy);
      const args = { space_id: "space-1", object_id: "obj-1" };

      // Cache the object
      await callToolHandler({ params: { name: "API-get-object", arguments: args } });

      // Update it
      mockExecute.mockResolvedValue({ data: { ok: true }, status: 200, headers: new Headers() });
      await callToolHandler({ params: { name: "API-update-object", arguments: args } });

      // Next get should fetch from API again
      mockExecute.mockClear();
      mockExecute.mockResolvedValue(mockObjectResponse);
      await callToolHandler({ params: { name: "API-get-object", arguments: args } });
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("should invalidate cache on delete-object", async () => {
      const mockExecute = HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>;
      mockExecute.mockResolvedValue(mockObjectResponse);

      const [, callToolHandler] = getHandlers(proxy);
      const args = { space_id: "space-1", object_id: "obj-1" };

      // Cache the object
      await callToolHandler({ params: { name: "API-get-object", arguments: args } });

      // Delete it
      mockExecute.mockResolvedValue({ data: { ok: true }, status: 200, headers: new Headers() });
      await callToolHandler({ params: { name: "API-delete-object", arguments: args } });

      // Next get should fetch from API again
      mockExecute.mockClear();
      mockExecute.mockResolvedValue(mockObjectResponse);
      await callToolHandler({ params: { name: "API-get-object", arguments: args } });
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("should list custom tools including cache and batch tools", async () => {
      const [listToolsHandler] = getHandlers(proxy);
      const result = await listToolsHandler();

      const toolNames = result.tools.map((t: Tool) => t.name);
      expect(toolNames).toContain("API-batch-get-objects");
      expect(toolNames).toContain("API-cache-stats");
      expect(toolNames).toContain("API-get-cached-content");
    });

    it("should return cache stats", async () => {
      const mockExecute = HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>;
      mockExecute.mockResolvedValue(mockObjectResponse);

      const [, callToolHandler] = getHandlers(proxy);

      // Cache an object first
      await callToolHandler({
        params: { name: "API-get-object", arguments: { space_id: "space-1", object_id: "obj-1" } },
      });

      // Get stats
      const statsResult = await callToolHandler({ params: { name: "API-cache-stats", arguments: {} } });
      const stats = JSON.parse(statsResult.content[0].text);

      expect(stats.entry_count).toBe(1);
      expect(stats.total_size_bytes).toBeGreaterThan(0);
      expect(stats.entries[0].object_id).toBe("obj-1");
    });

    it("should return cached content via get-cached-content", async () => {
      const mockExecute = HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>;
      mockExecute.mockResolvedValue(mockObjectResponse);

      const [, callToolHandler] = getHandlers(proxy);

      // Cache an object
      await callToolHandler({
        params: { name: "API-get-object", arguments: { space_id: "space-1", object_id: "obj-1" } },
      });

      // Get it from cache
      const cachedResult = await callToolHandler({
        params: {
          name: "API-get-cached-content",
          arguments: { space_id: "space-1", object_id: "obj-1" },
        },
      });
      const data = JSON.parse(cachedResult.content[0].text);
      expect(data).toEqual(mockObjectResponse.data);
    });

    it("should return miss for uncached object in get-cached-content", async () => {
      const [, callToolHandler] = getHandlers(proxy);

      const result = await callToolHandler({
        params: {
          name: "API-get-cached-content",
          arguments: { space_id: "space-1", object_id: "not-cached" },
        },
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe("miss");
    });
  });

  describe("batch get-objects", () => {
    const makeObjResponse = (id: string, name: string) => ({
      data: {
        object: {
          id,
          name,
          type: { key: "page", name: "Page" },
          layout: "basic",
          snippet: `Preview of ${name}`,
          markdown: `# ${name}\n\nFull body content...`,
          properties: [{ key: "last_modified_date", date: "2025-06-01T12:00:00Z" }],
        },
      },
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
    });

    beforeEach(() => {
      (proxy as any).openApiLookup = {
        "API-get-object": {
          operationId: "get_object",
          method: "get",
          path: "/v1/spaces/{space_id}/objects/{object_id}",
          responses: { "200": { description: "Success" } },
        },
      };
    });

    it("should fetch multiple objects and return summaries", async () => {
      const mockExecute = HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>;
      mockExecute
        .mockResolvedValueOnce(makeObjResponse("obj-1", "First"))
        .mockResolvedValueOnce(makeObjResponse("obj-2", "Second"));

      const [, callToolHandler] = getHandlers(proxy);
      const result = await callToolHandler({
        params: {
          name: "API-batch-get-objects",
          arguments: { space_id: "space-1", object_ids: ["obj-1", "obj-2"] },
        },
      });

      const summaries = JSON.parse(result.content[0].text);
      expect(summaries).toHaveLength(2);
      expect(summaries[0].name).toBe("First");
      expect(summaries[0].object_id).toBe("obj-1");
      expect(summaries[0].size_bytes).toBeGreaterThan(0);
      expect(summaries[0].has_body).toBe(true);
      expect(summaries[1].name).toBe("Second");
      // Summaries should not contain full body content
      expect(summaries[0]).not.toHaveProperty("markdown");
    });

    it("should use cache for already-cached objects", async () => {
      const mockExecute = HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>;
      mockExecute.mockResolvedValueOnce(makeObjResponse("obj-1", "First"));

      const [, callToolHandler] = getHandlers(proxy);

      // Pre-cache obj-1 via get-object
      await callToolHandler({
        params: { name: "API-get-object", arguments: { space_id: "space-1", object_id: "obj-1" } },
      });
      expect(mockExecute).toHaveBeenCalledTimes(1);

      // Batch fetch — obj-1 from cache, obj-2 from API
      mockExecute.mockClear();
      mockExecute.mockResolvedValueOnce(makeObjResponse("obj-2", "Second"));

      const result = await callToolHandler({
        params: {
          name: "API-batch-get-objects",
          arguments: { space_id: "space-1", object_ids: ["obj-1", "obj-2"] },
        },
      });

      // Only obj-2 should have triggered an API call
      expect(mockExecute).toHaveBeenCalledTimes(1);
      const summaries = JSON.parse(result.content[0].text);
      expect(summaries).toHaveLength(2);
    });

    it("should handle errors for individual objects gracefully", async () => {
      const mockExecute = HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>;
      mockExecute
        .mockResolvedValueOnce(makeObjResponse("obj-1", "Good"))
        .mockRejectedValueOnce(new Error("Not found"));

      const [, callToolHandler] = getHandlers(proxy);
      const result = await callToolHandler({
        params: {
          name: "API-batch-get-objects",
          arguments: { space_id: "space-1", object_ids: ["obj-1", "obj-bad"] },
        },
      });

      const summaries = JSON.parse(result.content[0].text);
      expect(summaries).toHaveLength(2);
      expect(summaries[0].name).toBe("Good");
      expect(summaries[1].status).toBe("error");
      expect(summaries[1].object_id).toBe("obj-bad");
    });

    it("should reject empty object_ids", async () => {
      const [, callToolHandler] = getHandlers(proxy);

      await expect(
        callToolHandler({
          params: { name: "API-batch-get-objects", arguments: { space_id: "space-1", object_ids: [] } },
        }),
      ).rejects.toThrow("object_ids must be a non-empty array");
    });

    it("should reject more than 50 object_ids", async () => {
      const [, callToolHandler] = getHandlers(proxy);
      const ids = Array.from({ length: 51 }, (_, i) => `obj-${i}`);

      await expect(
        callToolHandler({
          params: { name: "API-batch-get-objects", arguments: { space_id: "space-1", object_ids: ids } },
        }),
      ).rejects.toThrow("object_ids cannot exceed 50 items");
    });

    it("should populate cache for batch-fetched objects", async () => {
      const mockExecute = HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>;
      mockExecute.mockResolvedValueOnce(makeObjResponse("obj-1", "Cached"));

      const [, callToolHandler] = getHandlers(proxy);
      await callToolHandler({
        params: {
          name: "API-batch-get-objects",
          arguments: { space_id: "space-1", object_ids: ["obj-1"] },
        },
      });

      // Object should now be in cache — get-cached-content should work
      const cachedResult = await callToolHandler({
        params: {
          name: "API-get-cached-content",
          arguments: { space_id: "space-1", object_id: "obj-1" },
        },
      });
      const data = JSON.parse(cachedResult.content[0].text);
      expect(data.object.name).toBe("Cached");
    });
  });

  describe("connect", () => {
    it("should connect to transport", async () => {
      const mockTransport = {} as Transport;
      await proxy.connect(mockTransport);

      const server = (proxy as any).server;
      expect(server.connect).toHaveBeenCalledWith(mockTransport);
    });
  });
});
