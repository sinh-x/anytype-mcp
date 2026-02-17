import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerSecrets } from "../utils/sanitizer";

export const CREDENTIALS_PATH = path.join(os.homedir(), ".config", "sinh-x", "anytype-mcp", "credentials.json");

interface CredentialsFile {
  apiKey: string;
  anytypeVersion?: string;
  baseUrl?: string;
}

interface LoadedCredentials {
  headers: Record<string, string>;
  baseUrl?: string;
}

/**
 * Loads credentials with priority: env var OPENAPI_MCP_HEADERS > config file > empty.
 * Registers any loaded secrets with the sanitizer.
 */
export function loadCredentials(): LoadedCredentials {
  // Priority 1: OPENAPI_MCP_HEADERS env var
  const headersJson = process.env.OPENAPI_MCP_HEADERS;
  if (headersJson) {
    try {
      const headers = JSON.parse(headersJson);
      if (typeof headers !== "object" || headers === null) {
        console.warn("OPENAPI_MCP_HEADERS environment variable must be a JSON object, got:", typeof headers);
        return { headers: {} };
      }
      registerSecrets(headers);
      return { headers };
    } catch (error) {
      console.warn("Failed to parse OPENAPI_MCP_HEADERS environment variable:", error);
      return { headers: {} };
    }
  }

  // Priority 2: Config file
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const raw = fs.readFileSync(CREDENTIALS_PATH, "utf-8");
      const config: CredentialsFile = JSON.parse(raw);

      if (!config.apiKey) {
        console.warn("credentials.json is missing required 'apiKey' field");
        return { headers: {} };
      }

      const headers: Record<string, string> = {};

      // Handle apiKey — add "Bearer " prefix if not already present
      headers["Authorization"] = config.apiKey.startsWith("Bearer ") ? config.apiKey : `Bearer ${config.apiKey}`;

      if (config.anytypeVersion) {
        headers["Anytype-Version"] = config.anytypeVersion;
      }

      registerSecrets(headers);
      console.error(`Loaded credentials from ${CREDENTIALS_PATH}`);
      return { headers, baseUrl: config.baseUrl };
    }
  } catch (error) {
    console.warn("Failed to read credentials file:", error);
  }

  // Priority 3: No credentials found
  console.warn(
    `No credentials found. API calls will fail with 401 Unauthorized.\n` +
      `  Option 1: Set OPENAPI_MCP_HEADERS env var with JSON headers\n` +
      `  Option 2: Run 'anytype-mcp get-key' to authenticate and save credentials to ${CREDENTIALS_PATH}`,
  );
  return { headers: {} };
}

/**
 * Saves credentials to the config file, creating the directory if needed.
 */
export function saveCredentials(config: { apiKey: string; anytypeVersion: string; baseUrl?: string }): void {
  const dir = path.dirname(CREDENTIALS_PATH);
  fs.mkdirSync(dir, { recursive: true });

  const data: CredentialsFile = {
    apiKey: config.apiKey,
    anytypeVersion: config.anytypeVersion,
  };

  if (config.baseUrl) {
    data.baseUrl = config.baseUrl;
  }

  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
}
