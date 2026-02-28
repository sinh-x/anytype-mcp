import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { JSONSchema7 as IJsonSchema } from "json-schema";
import { OpenAPIV3 } from "openapi-types";
import {
  BATCH_GET_OBJECTS_TOOL,
  BATCH_GET_OBJECTS_TOOL_NAME,
  CACHE_STATS_TOOL,
  CACHE_STATS_TOOL_NAME,
  GET_CACHED_CONTENT_TOOL,
  GET_CACHED_CONTENT_TOOL_NAME,
  ObjectCacheManager,
} from "./cache";
import { HttpClient, HttpClientError } from "../client/http-client";
import { loadCredentials } from "../config/credentials";
import { OpenAPIToMCPConverter } from "../openapi/parser";
import { determineBaseUrl } from "../utils/base-url";
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
          tools.push({
            name: truncatedToolName,
            description: method.description,
            inputSchema: method.inputSchema as Tool["inputSchema"],
          });
        });
      });

      // Add custom tools
      tools.push(BATCH_GET_OBJECTS_TOOL);
      tools.push(CACHE_STATS_TOOL);
      tools.push(GET_CACHED_CONTENT_TOOL);

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
      if (name === CACHE_STATS_TOOL_NAME) {
        return this.handleCacheStats(params);
      }
      if (name === GET_CACHED_CONTENT_TOOL_NAME) {
        return this.handleGetCachedContent(params);
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

        // Post-operation cache invalidation
        if (name === "API-update-object" || name === "API-delete-object") {
          const spaceId = params?.space_id as string;
          const objectId = params?.object_id as string;
          if (spaceId && objectId) {
            this.objectCache.invalidate(spaceId, objectId);
            console.error(`Cache invalidated for ${spaceId}:${objectId} after ${name}`);
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

    // Cache miss — fetch from API
    const response = await this.httpClient.executeOperation(operation, params);

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

    if (!spaceId) {
      throw new Error("space_id is required");
    }
    if (!objectIds || !Array.isArray(objectIds) || objectIds.length === 0) {
      throw new Error("object_ids must be a non-empty array");
    }
    if (objectIds.length > 50) {
      throw new Error("object_ids cannot exceed 50 items");
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
