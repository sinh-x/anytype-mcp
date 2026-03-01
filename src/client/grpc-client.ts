import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitize } from "../utils/sanitizer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class GrpcClientError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: string,
  ) {
    super(message);
    this.name = "GrpcClientError";
  }
}

interface GrpcClientConfig {
  address: string;
  appToken?: string;
}

// gRPC response types matching the proto definitions
interface RpcError {
  code: number;
  description: string;
}

interface CreateSessionResponse {
  error?: RpcError;
  token: string;
  appToken: string;
  accountId: string;
}

interface FileUploadResponse {
  error?: RpcError;
  objectId: string;
  details?: Record<string, unknown>;
}

interface FileDownloadResponse {
  error?: RpcError;
  localPath: string;
}

// Proto enum mappings
const FILE_TYPE_MAP: Record<string, number> = {
  None: 0,
  File: 1,
  Image: 2,
  Video: 3,
  Audio: 4,
  PDF: 5,
};

const FILE_STYLE_MAP: Record<string, number> = {
  Auto: 0,
  Link: 1,
  Embed: 2,
};

const IMAGE_KIND_MAP: Record<string, number> = {
  Basic: 0,
  Cover: 1,
  Icon: 2,
  AutomaticallyAdded: 3,
};

export interface FileUploadRequest {
  spaceId: string;
  url?: string;
  localPath?: string;
  type?: string;
  style?: string;
  imageKind?: string;
}

export interface FileDownloadRequest {
  objectId: string;
  path?: string;
}

export class GrpcClient {
  private config: GrpcClientConfig;
  private client: any = null;
  private sessionToken: string | null = null;
  private connected = false;

  constructor(config: GrpcClientConfig) {
    this.config = config;
  }

  private resolveProtoPath(): string {
    // Try relative to source (development)
    const devPath = path.resolve(__dirname, "../../proto");
    if (fs.existsSync(path.join(devPath, "pb/protos/service/service.proto"))) {
      return devPath;
    }

    // Try relative to binary (production build)
    const binPath = path.resolve(__dirname, "../proto");
    if (fs.existsSync(path.join(binPath, "pb/protos/service/service.proto"))) {
      return binPath;
    }

    throw new GrpcClientError("Proto files not found", "PROTO_NOT_FOUND", `Searched: ${devPath}, ${binPath}`);
  }

  private resolveProtobufJsPath(): string {
    // protobufjs provides google/protobuf/*.proto
    try {
      const esmRequire = createRequire(import.meta.url);
      const protobufJsMain = esmRequire.resolve("protobufjs");
      return path.dirname(protobufJsMain);
    } catch {
      // Fallback: try common node_modules locations
      const candidates = [
        path.resolve(__dirname, "../../node_modules/protobufjs"),
        path.resolve(__dirname, "../node_modules/protobufjs"),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, "google/protobuf/struct.proto"))) {
          return candidate;
        }
      }
      throw new GrpcClientError(
        "protobufjs not found — needed for google/protobuf/struct.proto",
        "PROTOBUFJS_NOT_FOUND",
      );
    }
  }

  async ensureConnected(): Promise<void> {
    if (this.connected && this.client) return;

    const protoDir = this.resolveProtoPath();
    const protobufJsDir = this.resolveProtobufJsPath();

    const packageDefinition = await protoLoader.load("pb/protos/service/service.proto", {
      keepCase: false,
      longs: String,
      enums: Number,
      defaults: true,
      oneofs: true,
      includeDirs: [protoDir, protobufJsDir],
    });

    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
    const anytypePackage = protoDescriptor.anytype as any;

    if (!anytypePackage?.ClientCommands) {
      throw new GrpcClientError("ClientCommands service not found in proto definition", "PROTO_INVALID");
    }

    this.client = new anytypePackage.ClientCommands(this.config.address, grpc.credentials.createInsecure());

    // If we have an appToken, resume the session
    if (this.config.appToken) {
      await this.resumeSession(this.config.appToken);
    }

    this.connected = true;
  }

  async createSession(mnemonic: string): Promise<{ token: string; appToken: string; accountId: string }> {
    await this.ensureConnected();

    const response = await this.callRpc<CreateSessionResponse>("walletCreateSession", { mnemonic });

    if (response.error && response.error.code !== 0) {
      throw new GrpcClientError(
        `CreateSession failed: ${response.error.description}`,
        `GRPC_ERROR_${response.error.code}`,
        response.error.description,
      );
    }

    this.sessionToken = response.token;
    return {
      token: response.token,
      appToken: response.appToken,
      accountId: response.accountId,
    };
  }

  async resumeSession(appToken: string): Promise<void> {
    // Try appKey auth first; if it looks like a JWT session token, use token auth instead
    const isJwt = appToken.startsWith("eyJ");
    const authPayload = isJwt ? { token: appToken } : { appKey: appToken };

    const response = await this.callRpc<CreateSessionResponse>("walletCreateSession", authPayload);

    if (response.error && response.error.code !== 0) {
      throw new GrpcClientError(
        `ResumeSession failed: ${response.error.description}`,
        `GRPC_ERROR_${response.error.code}`,
        response.error.description,
      );
    }

    this.sessionToken = response.token;
    console.error(`gRPC session resumed successfully (${isJwt ? "token" : "appKey"} auth)`);
  }

  async fileUpload(request: FileUploadRequest): Promise<{ objectId: string; details?: Record<string, unknown> }> {
    await this.ensureConnected();

    const grpcRequest: Record<string, unknown> = {
      spaceId: request.spaceId,
      origin: 9, // api
    };

    if (request.url) grpcRequest.url = request.url;
    if (request.localPath) grpcRequest.localPath = request.localPath;
    if (request.type) grpcRequest.type = FILE_TYPE_MAP[request.type] ?? 0;
    if (request.style) grpcRequest.style = FILE_STYLE_MAP[request.style] ?? 0;
    if (request.imageKind) grpcRequest.imageKind = IMAGE_KIND_MAP[request.imageKind] ?? 0;

    const response = await this.callWithAuth<FileUploadResponse>("fileUpload", grpcRequest);

    if (response.error && response.error.code !== 0) {
      throw new GrpcClientError(
        `FileUpload failed: ${response.error.description}`,
        `GRPC_ERROR_${response.error.code}`,
        response.error.description,
      );
    }

    return {
      objectId: response.objectId,
      details: response.details,
    };
  }

  async fileDownload(request: FileDownloadRequest): Promise<{ localPath: string }> {
    await this.ensureConnected();

    const grpcRequest: Record<string, unknown> = {
      objectId: request.objectId,
    };

    if (request.path) grpcRequest.path = request.path;

    const response = await this.callWithAuth<FileDownloadResponse>("fileDownload", grpcRequest);

    if (response.error && response.error.code !== 0) {
      throw new GrpcClientError(
        `FileDownload failed: ${response.error.description}`,
        `GRPC_ERROR_${response.error.code}`,
        response.error.description,
      );
    }

    return { localPath: response.localPath };
  }

  close(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
      this.connected = false;
      this.sessionToken = null;
    }
  }

  private async callWithAuth<T>(method: string, request: Record<string, unknown>): Promise<T> {
    try {
      return await this.callRpc<T>(method, request);
    } catch (error) {
      // Auto-retry on UNAUTHENTICATED if we have an appToken
      if (error instanceof Error && error.message.includes("UNAUTHENTICATED") && this.config.appToken) {
        console.error("gRPC session expired, re-authenticating...");
        await this.resumeSession(this.config.appToken);
        return await this.callRpc<T>(method, request);
      }
      throw error;
    }
  }

  private callRpc<T>(method: string, request: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        return reject(new GrpcClientError("gRPC client not connected", "NOT_CONNECTED"));
      }

      const metadata = new grpc.Metadata();
      if (this.sessionToken) {
        metadata.add("token", this.sessionToken);
      }

      console.error(...sanitize(`gRPC call: ${method}`, request));

      this.client[method](request, metadata, (error: grpc.ServiceError | null, response: T) => {
        if (error) {
          console.error(...sanitize(`gRPC error in ${method}:`, error.message));
          return reject(
            new GrpcClientError(`gRPC ${method} failed: ${error.message}`, error.code?.toString() ?? "UNKNOWN"),
          );
        }
        resolve(response);
      });
    });
  }
}
