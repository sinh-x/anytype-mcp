import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { OpenAPIV3 } from "openapi-types";
import { loadCredentials } from "./config/credentials";
import { MCPProxy } from "./mcp/proxy";
import { determineBaseUrl, getDefaultSpecUrl } from "./utils/base-url";

export class ValidationError extends Error {
  constructor(public errors: any[]) {
    super("OpenAPI validation failed");
    this.name = "ValidationError";
  }
}

export async function loadOpenApiSpec(specPath?: string): Promise<OpenAPIV3.Document> {
  const finalSpec = specPath || getDefaultSpecUrl();
  let rawSpec: string;

  if (finalSpec.startsWith("http://") || finalSpec.startsWith("https://")) {
    try {
      const response = await axios.get(finalSpec);
      rawSpec = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    } catch (error: any) {
      if (error.code === "ECONNREFUSED") {
        console.error("Can't connect to API. Please ensure Anytype is running and reachable.");
        process.exit(1);
      }
      console.error("Failed to fetch OpenAPI specification from URL:", error.message);
      process.exit(1);
    }
  } else {
    const filePath = path.resolve(process.cwd(), finalSpec);
    try {
      rawSpec = fs.readFileSync(filePath, "utf-8");
    } catch (error: any) {
      console.error("Failed to read OpenAPI specification file:", error.message || String(error));
      process.exit(1);
    }
  }

  try {
    return JSON.parse(rawSpec) as OpenAPIV3.Document;
  } catch (error: any) {
    console.error("Failed to parse OpenAPI specification:", error.message);
    process.exit(1);
  }
}

interface Space {
  id: string;
  name: string;
}

/**
 * Prefetches spaces from the Anytype API and formats them as an instructions string.
 * Returns undefined on failure (non-fatal).
 */
export async function prefetchSpaces(openApiSpec: OpenAPIV3.Document): Promise<string | undefined> {
  try {
    const { headers, baseUrl: credentialsBaseUrl } = loadCredentials();
    const baseUrl = determineBaseUrl(openApiSpec, credentialsBaseUrl);

    const response = await axios.get(`${baseUrl}/v1/spaces`, {
      params: { limit: 1000 },
      headers,
    });

    const spaces: Space[] = response.data?.data ?? response.data?.spaces ?? [];
    if (spaces.length === 0) {
      console.error("No spaces found during prefetch");
      return undefined;
    }

    const spaceList = spaces.map((s) => `- "${s.name}" (id: ${s.id})`).join("\n");
    return `Available Anytype spaces:\n${spaceList}\n\nUse the space id when calling space-scoped tools.`;
  } catch (error: any) {
    console.error("Failed to prefetch spaces (non-fatal):", error.message);
    return undefined;
  }
}

export async function initProxy(specPath: string) {
  console.error("Initializing Anytype MCP Server...");
  const openApiSpec = await loadOpenApiSpec(specPath);

  const instructions = await prefetchSpaces(openApiSpec);
  const proxy = new MCPProxy("Anytype API", openApiSpec, instructions);

  await proxy.connect(new StdioServerTransport());
  console.error("Anytype MCP Server running on stdio");
}
