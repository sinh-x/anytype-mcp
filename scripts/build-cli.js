import * as esbuild from "esbuild";
import { chmod, cp, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

async function build() {
  await esbuild.build({
    entryPoints: [join(__dirname, "start-server.ts")],
    bundle: true,
    minify: true,
    platform: "node",
    target: "node18",
    format: "esm",
    outfile: "bin/cli.mjs",
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire } from 'module';const require = createRequire(import.meta.url);", // see https://github.com/evanw/esbuild/pull/2067
    },
    external: ["util", "@grpc/grpc-js", "@grpc/proto-loader", "protobufjs"],
  });

  // Make the output file executable
  await chmod("./bin/cli.mjs", 0o755);

  // Copy proto files so the bundled binary can find them
  await mkdir(join(rootDir, "bin", "proto"), { recursive: true });
  await cp(join(rootDir, "proto"), join(rootDir, "bin", "proto"), { recursive: true });
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
