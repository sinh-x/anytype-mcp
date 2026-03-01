import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerSecret, registerSecrets } from "../utils/sanitizer";

export const CREDENTIALS_PATH = path.join(os.homedir(), ".config", "sinh-x", "anytype-mcp", "credentials.json");

interface CredentialsFile {
  apiKey?: string;
  anytypeVersion?: string;
  baseUrl?: string;
  grpcAppToken?: string;
  grpcAddress?: string;
}

interface LoadedCredentials {
  headers: Record<string, string>;
  baseUrl?: string;
}

export interface GrpcCredentials {
  address?: string;
  appToken?: string;
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
 * Loads gRPC credentials with priority: env vars > config file.
 * No default address — anytypeHelper uses dynamic ports, so grpcAddress must be explicitly configured.
 */
export function loadGrpcCredentials(): GrpcCredentials {
  // Priority 1: Environment variables
  const envToken = process.env.ANYTYPE_GRPC_TOKEN;
  const envAddress = process.env.ANYTYPE_GRPC_ADDRESS;

  if (envToken) {
    registerSecret(envToken);
    console.error(`Using gRPC credentials from environment variables (address: ${envAddress ?? "not set"})`);
    return { address: envAddress, appToken: envToken };
  }

  // Priority 2: Config file
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const raw = fs.readFileSync(CREDENTIALS_PATH, "utf-8");
      const config: CredentialsFile = JSON.parse(raw);

      const address = config.grpcAddress ?? envAddress;

      // Only use dedicated gRPC token (apiKey has JsonAPI scope which lacks FileUpload permission)
      if (config.grpcAppToken) {
        registerSecret(config.grpcAppToken);
        console.error(`Loaded gRPC credentials from ${CREDENTIALS_PATH} (grpcAppToken, address: ${address ?? "not set"})`);
        return { address, appToken: config.grpcAppToken };
      }

      return { address };
    }
  } catch (error) {
    console.warn("Failed to read gRPC credentials from config file:", error);
  }

  // Priority 3: No credentials (address must be explicitly configured)
  return { address: envAddress };
}

/**
 * Saves credentials to the config file, creating the directory if needed.
 * Uses read-modify-write to preserve existing fields.
 */
export function saveCredentials(
  config: { apiKey?: string; anytypeVersion?: string; baseUrl?: string; grpcAppToken?: string; grpcAddress?: string },
): void {
  const dir = path.dirname(CREDENTIALS_PATH);
  fs.mkdirSync(dir, { recursive: true });

  // Read existing config to preserve fields
  let existing: CredentialsFile = {};
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      existing = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
    }
  } catch {
    // Start fresh if file is corrupt
  }

  const data: CredentialsFile = { ...existing };

  if (config.apiKey !== undefined) data.apiKey = config.apiKey;
  if (config.anytypeVersion !== undefined) data.anytypeVersion = config.anytypeVersion;
  if (config.baseUrl !== undefined) data.baseUrl = config.baseUrl;
  if (config.grpcAppToken !== undefined) data.grpcAppToken = config.grpcAppToken;
  if (config.grpcAddress !== undefined) data.grpcAddress = config.grpcAddress;

  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
}
