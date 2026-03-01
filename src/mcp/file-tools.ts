import { Tool } from "@modelcontextprotocol/sdk/types.js";

export const FILE_UPLOAD_TOOL_NAME = "file-upload";
export const FILE_DOWNLOAD_TOOL_NAME = "file-download";
export const FILE_READ_TOOL_NAME = "file-read";

export const FILE_UPLOAD_TOOL: Tool = {
  name: FILE_UPLOAD_TOOL_NAME,
  description:
    "Upload a file to Anytype via gRPC. Provide either a local file path or a URL. " +
    "Returns the created object ID and details. Requires gRPC authentication (run 'anytype-mcp grpc-auth' first).",
  inputSchema: {
    type: "object",
    properties: {
      space_id: {
        type: "string",
        description: "The space ID to upload the file into",
      },
      local_path: {
        type: "string",
        description: "Absolute path to a local file to upload (mutually exclusive with url)",
      },
      url: {
        type: "string",
        description: "URL of a file to upload (mutually exclusive with local_path)",
      },
      type: {
        type: "string",
        enum: ["None", "File", "Image", "Video", "Audio", "PDF"],
        description: "File type hint. Defaults to 'None' (auto-detect)",
      },
      style: {
        type: "string",
        enum: ["Auto", "Link", "Embed"],
        description: "Display style. Defaults to 'Auto'",
      },
      image_kind: {
        type: "string",
        enum: ["Basic", "Cover", "Icon", "AutomaticallyAdded"],
        description: "Image kind (only relevant for images). Defaults to 'Basic'",
      },
    },
    required: ["space_id"],
    additionalProperties: false,
  },
};

export const FILE_DOWNLOAD_TOOL: Tool = {
  name: FILE_DOWNLOAD_TOOL_NAME,
  description:
    "Download a file from Anytype to the local filesystem via gRPC. " +
    "Returns the local file path where the file was saved. Requires gRPC authentication.",
  inputSchema: {
    type: "object",
    properties: {
      object_id: {
        type: "string",
        description: "The Anytype object ID of the file to download",
      },
      path: {
        type: "string",
        description: "Directory path to save the file to. Uses OS temp directory if not specified",
      },
    },
    required: ["object_id"],
    additionalProperties: false,
  },
};

export const FILE_READ_TOOL: Tool = {
  name: FILE_READ_TOOL_NAME,
  description:
    "Download and read the content of a file from Anytype. For text files, returns the text content directly. " +
    "For images, returns base64-encoded image data as an MCP image content block. " +
    "For other binary files, returns base64-encoded data. 10MB size limit. Requires gRPC authentication.",
  inputSchema: {
    type: "object",
    properties: {
      object_id: {
        type: "string",
        description: "The Anytype object ID of the file to read",
      },
    },
    required: ["object_id"],
    additionalProperties: false,
  },
};
