# Vendored Proto Files

Minimal proto definitions vendored from [anyproto/anytype-heart](https://github.com/anyproto/anytype-heart).

## Included RPCs

- `WalletCreateSession` / `WalletCloseSession` — session management
- `FileUpload` — upload files to Anytype
- `FileDownload` — download files from Anytype

## Directory Structure

The directory layout mirrors the upstream repo so that proto `import` paths resolve correctly:

```
proto/
├── pb/protos/
│   ├── service/service.proto   ← ClientCommands service definition
│   └── commands.proto          ← RPC request/response messages
└── pkg/lib/pb/model/protos/
    └── models.proto            ← Shared enums (FileType, ImageKind, ObjectOrigin)
```

## Updating

1. Check [anytype-heart releases](https://github.com/anyproto/anytype-heart/releases) for proto changes
2. Compare the upstream `.proto` files against these vendored copies
3. Update only the message types used by this project
4. Test with `npm run build && npm test`

## Proto Loading

These files are loaded at runtime by `@grpc/proto-loader` (dynamic loading, no protoc build step).
The `includeDirs` configuration points to:
- `proto/` (this directory) — for resolving `pb/protos/...` and `pkg/lib/pb/model/protos/...` imports
- `node_modules/protobufjs` — for resolving `google/protobuf/struct.proto`
