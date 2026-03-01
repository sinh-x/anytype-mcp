# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

### Development
- `npm install -D` - Install all dependencies including devDependencies
- `npm run dev` - Start the development server with file watching (uses tsx watch)
- `npm run build` - Build the TypeScript project and generate CLI binary (`bin/cli.mjs`) via esbuild

### Testing
- `npm test` - Run all tests once with Vitest
- `npm run test:dev` - Run tests in watch mode
- Run a specific test file: `npx vitest run src/openapi/__tests__/parser.test.ts`

### Code Quality
- `npm run lint` - Check code formatting with ESLint
- `npm run lint:fix` - Auto-fix formatting issues with ESLint
- `npm run format` - Auto-fix formatting issues with Prettier
- `npm run typecheck` - Run TypeScript type checking without emitting files

### Utility Scripts
- `npm run parse-openapi` - Parse OpenAPI specification

## Architecture Overview

This is an MCP (Model Context Protocol) server that bridges Anytype's API with AI assistants. The architecture follows a proxy pattern where OpenAPI specifications are dynamically converted to MCP tools.

### Entry Points

The CLI (`scripts/start-server.ts` → `bin/cli.mjs`) supports three commands:
- `run` (default) — starts the MCP server on stdio
- `get-key` — interactive flow to authenticate and obtain an API key from a running Anytype instance
- `grpc-auth` — alternative gRPC auth via 12-word mnemonic (not needed if `get-key` was already run — the REST API key is reused for gRPC)

### Core Components

**MCP Proxy Layer (`src/mcp/proxy.ts`)**
- Central orchestrator that implements the MCP server protocol
- Converts OpenAPI operations to MCP tools dynamically at runtime
- Handles tool listing and execution through the MCP protocol
- Maintains a lookup table mapping MCP tool names to OpenAPI operations

**OpenAPI Parser (`src/openapi/parser.ts`)**
- Converts OpenAPI schemas to JSON Schema format for MCP compatibility
- Handles $ref resolution with cycle detection and schema caching
- Supports multipart/form-data for file uploads
- Also generates tool definitions for OpenAI (`convertToOpenAITools()`) and Anthropic (`convertToAnthropicTools()`) formats
- Special-case handling for icon schemas (emoji only) and property value union types

**HTTP Client (`src/client/http-client.ts`)**
- Built on openapi-client-axios for OpenAPI-aware HTTP requests
- Handles authentication headers from environment variables
- Supports file uploads via FormData with single and multi-file support
- Separates path/query parameters from body parameters automatically

**Server Initialization (`src/init-server.ts`)**
- Loads OpenAPI spec from URL or local file
- Initializes the MCP proxy with the spec
- Connects to stdio transport for communication

**gRPC Client (`src/client/grpc-client.ts`)**
- Pure JS gRPC client for Anytype's `ClientCommands` service (port 31007)
- Handles session management (create/resume via `WalletCreateSession` RPC)
- Exposes `fileUpload()` and `fileDownload()` methods
- Lazy connection — doesn't connect until first use
- Auto-retries on UNAUTHENTICATED by re-calling `resumeSession()`
- Uses vendored proto files from `proto/` directory

**File Tools (`src/mcp/file-tools.ts`)**
- Three custom MCP tools backed by gRPC (not OpenAPI-generated, no `API-` prefix):
  - `file-upload` — upload a file by local path or URL
  - `file-download` — download a file to the local filesystem
  - `file-read` — download and return file content (text, image, or base64)

**Library Exports (`src/index.ts`)**
- Exports `HttpClient`, `OpenAPIToMCPConverter`, and OpenAPI types for use as a library

### Key Design Patterns

1. **Dynamic Tool Generation**: Tools are not hardcoded but generated from the OpenAPI spec at runtime, making the server adaptable to API changes.

2. **Header Injection**: Authentication and version headers are parsed from `OPENAPI_MCP_HEADERS` environment variable (JSON object) and injected into all requests. The `Anytype-Version` header is auto-stripped from tool input schemas since it's already set via the headers.

3. **Tool Naming**: Each OpenAPI operation becomes an MCP tool named `API-{operationId}` in kebab-case, truncated to 64 characters (with a numeric suffix if needed for uniqueness). Operations tagged `Auth` are excluded.

4. **Base URL Resolution** (`src/utils/base-url.ts`): Priority order is (1) `ANYTYPE_API_BASE_URL` env var, (2) OpenAPI spec `servers[0].url`, (3) default `http://127.0.0.1:31009`.

5. **Build**: esbuild bundles `scripts/start-server.ts` into a single self-contained `bin/cli.mjs` with a shebang for direct execution. gRPC dependencies (`@grpc/grpc-js`, `@grpc/proto-loader`, `protobufjs`) are externalized. Proto files are copied to `bin/proto/` during build.

6. **gRPC File Tools**: Three tools (`file-upload`, `file-download`, `file-read`) use gRPC instead of REST to communicate with the Anytype desktop app's `ClientCommands` service. These require separate authentication via `grpc-auth` command.

### Known Limitations

- **Filters not supported**: `FilterExpression` refs resolve to `{}` and `filters` fields are stripped from request bodies (multiple TODOs in parser).

## Environment Variables

### REST API
- `OPENAPI_MCP_HEADERS` — JSON object of headers injected into every API request (e.g., `{"Authorization":"Bearer <KEY>", "Anytype-Version":"2025-11-08"}`)
- `ANYTYPE_API_BASE_URL` — Override the default API base URL (default: `http://127.0.0.1:31009`)

### gRPC (File Tools)
- `ANYTYPE_GRPC_TOKEN` — gRPC app token for session resumption (alternative to config file)
- `ANYTYPE_GRPC_ADDRESS` — Override gRPC address (default: `127.0.0.1:31010`)

## Testing Strategy

Tests use Vitest and are colocated with source files in `__tests__` directories. Key test areas:
- OpenAPI to MCP conversion logic
- HTTP client behavior including file uploads
- MCP proxy tool execution
- Multipart form data handling
- gRPC client connection, session, and file operations
- File type detection and MIME mapping
- Credential loading (REST and gRPC priority chains)

## Git Branch Strategy

This is a fork of [anyproto/anytype-mcp](https://github.com/anyproto/anytype-mcp).

- **`main`** — tracks upstream. Used only to sync with `anyproto/anytype-mcp`. Never commit directly here. **Never merge `sinh-x-develop` (or any fork branch) into `main`** — it must stay a clean mirror of upstream.
- **`sinh-x-develop`** — personal development base branch. All feature work branches from and merges back into this branch. Periodically rebase onto `main` to pick up upstream changes.
- **Feature branches** — branch from `sinh-x-develop` using `feat/`, `fix/`, `chore/` prefixes (e.g., `feat/add-filters`). PR back into `sinh-x-develop`.

### Fork Versioning

Format: `{upstream-version}-sinh.{increment}`

- `1.2.2-sinh.1` — first fork release on upstream 1.2.2
- `1.2.2-sinh.2` — second fork release
- `1.3.0-sinh.1` — first fork release after rebasing onto upstream 1.3.0

Tags use `v` prefix (e.g., `v1.2.2-sinh.1`) and are applied on `sinh-x-develop` only. Bump the version in `package.json` and tag when merging feature branches.

## Code Style

- Prettier with 120 character line width
- Double quotes for strings
- Automatic import organization via prettier-plugin-organize-imports
- TypeScript strict mode enabled
