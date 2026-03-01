import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JSONSchema7 as IJsonSchema } from "json-schema";
import { OpenAPIV3 } from "openapi-types";
import {
  BATCH_GET_OBJECTS_TOOL,
  BATCH_GET_OBJECTS_TOOL_NAME,
  BATCH_UPDATE_OBJECTS_TOOL,
  BATCH_UPDATE_OBJECTS_TOOL_NAME,
  CACHE_STATS_TOOL,
  CACHE_STATS_TOOL_NAME,
  GET_CACHED_CONTENT_TOOL,
  GET_CACHED_CONTENT_TOOL_NAME,
  ObjectCacheManager,
} from "./cache";
import {
  FILE_DOWNLOAD_TOOL,
  FILE_DOWNLOAD_TOOL_NAME,
  FILE_READ_TOOL,
  FILE_READ_TOOL_NAME,
  FILE_UPLOAD_TOOL,
  FILE_UPLOAD_TOOL_NAME,
} from "./file-tools";
import { GrpcClient, GrpcClientError } from "../client/grpc-client";
import { HttpClient, HttpClientError } from "../client/http-client";
import { GrpcCredentials, loadCredentials, loadGrpcCredentials } from "../config/credentials";
import { OpenAPIToMCPConverter } from "../openapi/parser";
import { determineBaseUrl } from "../utils/base-url";
import { getMimeType, isImageFile, isTextFile } from "../utils/file-type-detector";
import { sanitize } from "../utils/sanitizer";

type NewToolDefinition = {
  methods: Array<{
    name: string;
    description: string;
    inputSchema: IJsonSchema & { type: "object" };
    outputSchema?: IJsonSchema;
  }>;
};

export class MCPProxy {
  private server: Server;
  private httpClient: HttpClient;
  private tools: Record<string, NewToolDefinition>;
  private openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }>;
  private objectCache: ObjectCacheManager;
  private grpcClient: GrpcClient | null = null;
  private grpcCredentials: GrpcCredentials;

  constructor(name: string, openApiSpec: OpenAPIV3.Document, instructions?: string) {
    this.server = new Server(
      { name, version: "1.0.0" },
      { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
    );
    const { headers, baseUrl: credentialsBaseUrl } = loadCredentials();
    const baseUrl = determineBaseUrl(openApiSpec, credentialsBaseUrl);
    this.httpClient = new HttpClient(
      {
        baseUrl,
        headers,
      },
      openApiSpec,
    );

    // Convert OpenAPI spec to MCP tools
    const converter = new OpenAPIToMCPConverter(openApiSpec);
    const { tools, openApiLookup } = converter.convertToMCPTools();
    this.tools = tools;
    this.openApiLookup = openApiLookup;
    this.objectCache = new ObjectCacheManager();

    // Initialize gRPC credentials (lazy — won't connect until first use)
    this.grpcCredentials = loadGrpcCredentials();

    this.setupHandlers();
  }

  private setupHandlers() {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [];

      // Add methods as separate tools to match the MCP format
      Object.entries(this.tools).forEach(([toolName, def]) => {
        def.methods.forEach((method) => {
          const toolNameWithMethod = `${toolName}-${method.name}`;
          const truncatedToolName = this.truncateToolName(toolNameWithMethod);
          const inputSchema = { ...method.inputSchema } as Tool["inputSchema"];

          // Inject force_refresh into API-get-object schema
          if (truncatedToolName === "API-get-object") {
            inputSchema.properties = {
              ...inputSchema.properties,
              force_refresh: {
                type: "boolean",
                description: "Bypass the cache and fetch fresh data from the API. Defaults to false.",
              },
            };
          }

          tools.push({
            name: truncatedToolName,
            description: method.description,
            inputSchema,
          });
        });
      });

      // Add custom tools
      tools.push(BATCH_GET_OBJECTS_TOOL);
      tools.push(BATCH_UPDATE_OBJECTS_TOOL);
      tools.push(CACHE_STATS_TOOL);
      tools.push(GET_CACHED_CONTENT_TOOL);

      // Add gRPC file tools
      tools.push(FILE_UPLOAD_TOOL);
      tools.push(FILE_DOWNLOAD_TOOL);
      tools.push(FILE_READ_TOOL);

      return { tools };
    });

    // Handle tool calling
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.error(...sanitize("calling tool", request.params));
      const { name, arguments: params } = request.params;

      // Handle custom tools
      if (name === BATCH_GET_OBJECTS_TOOL_NAME) {
        return this.handleBatchGetObjects(params);
      }
      if (name === BATCH_UPDATE_OBJECTS_TOOL_NAME) {
        return this.handleBatchUpdateObjects(params);
      }
      if (name === CACHE_STATS_TOOL_NAME) {
        return this.handleCacheStats(params);
      }
      if (name === GET_CACHED_CONTENT_TOOL_NAME) {
        return this.handleGetCachedContent(params);
      }

      // Handle gRPC file tools
      if (name === FILE_UPLOAD_TOOL_NAME) {
        return this.handleFileUpload(params);
      }
      if (name === FILE_DOWNLOAD_TOOL_NAME) {
        return this.handleFileDownload(params);
      }
      if (name === FILE_READ_TOOL_NAME) {
        return this.handleFileRead(params);
      }

      // Find the operation in OpenAPI spec
      const operation = this.findOperation(name);
      console.error(...sanitize("operations", this.openApiLookup));
      if (!operation) {
        throw new Error(`Method ${name} not found`);
      }

      try {
        // Cache-aware handling for object operations
        if (name === "API-get-object") {
          return this.handleGetObject(operation, params);
        }

        // Execute the operation
        const response = await this.httpClient.executeOperation(operation, params);

        // Post-operation cache handling
        if (name === "API-update-object") {
          const spaceId = params?.space_id as string;
          const objectId = params?.object_id as string;
          if (spaceId && objectId && response.data) {
            // Write-through: cache the updated object from the response
            this.objectCache.set(spaceId, objectId, response.data as Record<string, unknown>);
            console.error(`Cache write-through for ${spaceId}:${objectId} after update`);
          }
        } else if (name === "API-delete-object") {
          const spaceId = params?.space_id as string;
          const objectId = params?.object_id as string;
          if (spaceId && objectId) {
            this.objectCache.invalidate(spaceId, objectId);
            console.error(`Cache invalidated for ${spaceId}:${objectId} after delete`);
          }
        }

        // Opportunistic cache invalidation from search results
        if (name === "API-search-space" || name === "API-search-global") {
          const spaceId = params?.space_id as string;
          const results = (response.data as Record<string, unknown>)?.data as
            | Array<Record<string, unknown>>
            | undefined;
          if (spaceId && results) {
            const invalidated = this.objectCache.invalidateStaleFromSearch(spaceId, results);
            if (invalidated > 0) {
              console.error(`Cache: invalidated ${invalidated} stale entries from search results`);
            }
          }
        }

        // Convert response to MCP format
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response.data),
            },
          ],
        };
      } catch (error) {
        console.error(...sanitize("Error in tool call", error));
        if (error instanceof HttpClientError) {
          console.error(...sanitize("HttpClientError encountered, returning structured error", error));
          const data = error.data?.response?.data ?? error.data ?? {};
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "error",
                  ...(typeof data === "object" ? data : { data: data }),
                }),
              },
            ],
          };
        }
        throw error;
      }
    });
  }

  private async handleGetObject(
    operation: OpenAPIV3.OperationObject & { method: string; path: string },
    params: Record<string, unknown> | undefined,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const spaceId = params?.space_id as string;
    const objectId = params?.object_id as string;
    const forceRefresh = params?.force_refresh as boolean | undefined;

    // Force refresh: invalidate cache entry before lookup
    if (forceRefresh && spaceId && objectId) {
      this.objectCache.invalidate(spaceId, objectId);
      console.error(`Force refresh: invalidated cache for ${spaceId}:${objectId}`);
    }

    // Check cache first
    if (spaceId && objectId) {
      const cached = this.objectCache.get(spaceId, objectId);
      if (cached) {
        console.error(`Cache hit for ${spaceId}:${objectId}`);
        return {
          content: [{ type: "text", text: JSON.stringify(cached.data) }],
        };
      }
    }

    // Cache miss — fetch from API (strip force_refresh before sending)
    const { force_refresh: _, ...apiParams } = params ?? {};
    const response = await this.httpClient.executeOperation(operation, apiParams);

    // Cache the result
    if (spaceId && objectId && response.data) {
      this.objectCache.set(spaceId, objectId, response.data as Record<string, unknown>);
      console.error(`Cached object ${spaceId}:${objectId}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(response.data) }],
    };
  }

  private async handleBatchGetObjects(
    params: Record<string, unknown> | undefined,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const spaceId = params?.space_id as string | undefined;
    const objectIds = params?.object_ids as string[] | undefined;
    const forceRefresh = params?.force_refresh as boolean | undefined;

    if (!spaceId) {
      throw new Error("space_id is required");
    }
    if (!objectIds || !Array.isArray(objectIds) || objectIds.length === 0) {
      throw new Error("object_ids must be a non-empty array");
    }
    if (objectIds.length > 50) {
      throw new Error("object_ids cannot exceed 50 items");
    }

    // Force refresh: invalidate all requested objects before lookup
    if (forceRefresh) {
      for (const objectId of objectIds) {
        this.objectCache.invalidate(spaceId, objectId);
      }
      console.error(`Force refresh: invalidated ${objectIds.length} cache entries for batch get`);
    }

    const operation = this.findOperation("API-get-object");
    if (!operation) {
      throw new Error("get-object operation not found in OpenAPI spec");
    }

    const CONCURRENCY = 10;
    const summaries: Array<
      | import("./cache").ObjectSummary
      | { object_id: string; status: "error"; error: string }
    > = [];

    for (let i = 0; i < objectIds.length; i += CONCURRENCY) {
      const batch = objectIds.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (objectId) => {
          // Check cache first
          const cached = this.objectCache.get(spaceId, objectId);
          if (cached) {
            console.error(`Batch: cache hit for ${spaceId}:${objectId}`);
            return cached;
          }

          // Fetch from API and cache
          const response = await this.httpClient.executeOperation(operation, {
            space_id: spaceId,
            object_id: objectId,
          });
          const data = response.data as Record<string, unknown>;
          this.objectCache.set(spaceId, objectId, data);
          return this.objectCache.get(spaceId, objectId)!;
        }),
      );

      for (let j = 0; j < settled.length; j++) {
        const result = settled[j];
        const objectId = batch[j];
        if (result.status === "fulfilled") {
          summaries.push(this.objectCache.buildSummary(result.value));
        } else {
          const err = result.reason;
          const errorMsg =
            err instanceof HttpClientError
              ? JSON.stringify(err.data?.response?.data ?? err.data ?? err.message)
              : String(err);
          summaries.push({ object_id: objectId, status: "error", error: errorMsg });
        }
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(summaries) }],
    };
  }

  private async handleBatchUpdateObjects(
    params: Record<string, unknown> | undefined,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const spaceId = params?.space_id as string | undefined;
    const updates = params?.updates as Array<Record<string, unknown>> | undefined;

    if (!spaceId) {
      throw new Error("space_id is required");
    }
    if (!updates || !Array.isArray(updates) || updates.length === 0) {
      throw new Error("updates must be a non-empty array");
    }
    if (updates.length > 20) {
      throw new Error("updates cannot exceed 20 items");
    }

    const operation = this.findOperation("API-update-object");
    if (!operation) {
      throw new Error("update-object operation not found in OpenAPI spec");
    }

    const CONCURRENCY = 5;
    const results: Array<
      | import("./cache").ObjectSummary
      | { object_id: string; status: "error"; error: string }
    > = [];

    for (let i = 0; i < updates.length; i += CONCURRENCY) {
      const batch = updates.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (update) => {
          const objectId = update.object_id as string;
          if (!objectId) throw new Error("object_id is required in each update");

          // Build params: space_id + object_id + update fields
          const { object_id, ...updateFields } = update;
          const callParams = { space_id: spaceId, object_id: objectId, ...updateFields };

          const response = await this.httpClient.executeOperation(operation, callParams);
          const data = response.data as Record<string, unknown>;

          // Write-through: cache the updated object
          this.objectCache.set(spaceId, objectId, data);
          console.error(`Batch update: write-through cache for ${spaceId}:${objectId}`);

          return this.objectCache.get(spaceId, objectId)!;
        }),
      );

      for (let j = 0; j < settled.length; j++) {
        const result = settled[j];
        const objectId = batch[j].object_id as string;
        if (result.status === "fulfilled") {
          results.push(this.objectCache.buildSummary(result.value));
        } else {
          const err = result.reason;
          const errorMsg =
            err instanceof HttpClientError
              ? JSON.stringify(err.data?.response?.data ?? err.data ?? err.message)
              : String(err);
          results.push({ object_id: objectId, status: "error", error: errorMsg });
        }
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(results) }],
    };
  }

  private handleCacheStats(
    params: Record<string, unknown> | undefined,
  ): { content: Array<{ type: string; text: string }> } {
    const spaceId = params?.space_id as string | undefined;
    const stats = this.objectCache.getStats(spaceId);
    return {
      content: [{ type: "text", text: JSON.stringify(stats) }],
    };
  }

  private handleGetCachedContent(
    params: Record<string, unknown> | undefined,
  ): { content: Array<{ type: string; text: string }> } {
    const spaceId = params?.space_id as string | undefined;
    const objectId = params?.object_id as string | undefined;

    if (!spaceId || !objectId) {
      throw new Error("space_id and object_id are required");
    }

    const cached = this.objectCache.get(spaceId, objectId);
    if (!cached) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "miss",
              message: `Object ${objectId} not found in cache. Use API-get-object to fetch it first.`,
            }),
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(cached.data) }],
    };
  }

  private async ensureGrpcClient(): Promise<GrpcClient> {
    if (!this.grpcCredentials.address) {
      throw new GrpcClientError(
        "gRPC address not configured. anytypeHelper uses dynamic ports — configure grpcAddress in credentials.json or run 'anytype-mcp grpc-auth'. Hint: find the port with `ss -tlnp | grep anytypeHelper`.",
        "NO_GRPC_ADDRESS",
      );
    }

    if (!this.grpcCredentials.appToken) {
      throw new GrpcClientError(
        "gRPC authentication required. Run 'anytype-mcp get-key' (recommended) or 'anytype-mcp grpc-auth' to set up access.",
        "NO_APP_TOKEN",
      );
    }

    if (!this.grpcClient) {
      this.grpcClient = new GrpcClient({
        address: this.grpcCredentials.address,
        appToken: this.grpcCredentials.appToken,
      });
    }

    await this.grpcClient.ensureConnected();
    return this.grpcClient;
  }

  private async handleFileUpload(
    params: Record<string, unknown> | undefined,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const spaceId = params?.space_id as string | undefined;
    const localPath = params?.local_path as string | undefined;
    const url = params?.url as string | undefined;

    if (!spaceId) throw new Error("space_id is required");
    if (!localPath && !url) throw new Error("Either local_path or url is required");
    if (localPath && url) throw new Error("Provide either local_path or url, not both");

    try {
      const client = await this.ensureGrpcClient();
      const result = await client.fileUpload({
        spaceId,
        localPath,
        url,
        type: params?.type as string | undefined,
        style: params?.style as string | undefined,
        imageKind: params?.image_kind as string | undefined,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      if (error instanceof GrpcClientError) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ status: "error", code: error.code, message: error.message }) },
          ],
        };
      }
      throw error;
    }
  }

  private async handleFileDownload(
    params: Record<string, unknown> | undefined,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const objectId = params?.object_id as string | undefined;
    if (!objectId) throw new Error("object_id is required");

    try {
      const client = await this.ensureGrpcClient();
      const result = await client.fileDownload({
        objectId,
        path: params?.path as string | undefined,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      if (error instanceof GrpcClientError) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ status: "error", code: error.code, message: error.message }) },
          ],
        };
      }
      throw error;
    }
  }

  private async handleFileRead(
    params: Record<string, unknown> | undefined,
  ): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }> {
    const objectId = params?.object_id as string | undefined;
    if (!objectId) throw new Error("object_id is required");

    const MAX_SIZE = 10 * 1024 * 1024; // 10MB

    try {
      const client = await this.ensureGrpcClient();

      // Download to temp directory
      const tmpDir = path.join(os.tmpdir(), "anytype-mcp-file-read");
      fs.mkdirSync(tmpDir, { recursive: true });

      const result = await client.fileDownload({ objectId, path: tmpDir });
      const filePath = result.localPath;

      try {
        // Check file size
        const stats = fs.statSync(filePath);
        if (stats.size > MAX_SIZE) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "error",
                  message: `File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.`,
                  localPath: filePath,
                }),
              },
            ],
          };
        }

        // Text files: return content directly
        if (isTextFile(filePath)) {
          const content = fs.readFileSync(filePath, "utf-8");
          return {
            content: [{ type: "text", text: content }],
          };
        }

        // Images: return as MCP image content
        if (isImageFile(filePath)) {
          const data = fs.readFileSync(filePath).toString("base64");
          const mimeType = getMimeType(filePath);
          return {
            content: [{ type: "image", data, mimeType }],
          };
        }

        // Other binary: return as base64 text
        const data = fs.readFileSync(filePath).toString("base64");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                encoding: "base64",
                mimeType: getMimeType(filePath),
                data,
                localPath: filePath,
              }),
            },
          ],
        };
      } finally {
        // Clean up temp file
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch (error) {
      if (error instanceof GrpcClientError) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ status: "error", code: error.code, message: error.message }) },
          ],
        };
      }
      throw error;
    }
  }

  private findOperation(operationId: string): (OpenAPIV3.OperationObject & { method: string; path: string }) | null {
    return this.openApiLookup[operationId] ?? null;
  }

  private truncateToolName(name: string): string {
    if (name.length <= 64) {
      return name;
    }
    return name.slice(0, 64);
  }

  async connect(transport: Transport) {
    // The SDK will handle stdio communication
    await this.server.connect(transport);
  }
}
