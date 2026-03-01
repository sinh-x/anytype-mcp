import * as readline from "readline";
import { GrpcClient } from "../client/grpc-client";
import { CREDENTIALS_PATH, loadGrpcCredentials, saveCredentials } from "../config/credentials";

export async function grpcAuth(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (question: string): Promise<string> => {
    return new Promise<string>((resolve) => {
      rl.question(question, resolve);
    });
  };

  try {
    const { address: existingAddress } = loadGrpcCredentials();

    console.log("Note: If you already ran 'anytype-mcp get-key', file tools work automatically.");
    console.log("This command is only needed for mnemonic-based auth as an alternative.\n");

    // Prompt for gRPC address
    const defaultHint = existingAddress ? ` [${existingAddress}]` : "";
    console.log("Hint: Find the anytypeHelper gRPC port with: ss -tlnp | grep anytypeHelper");
    const addressInput = await prompt(`Enter gRPC address (host:port)${defaultHint}: `);
    const address = addressInput.trim() || existingAddress;

    if (!address) {
      console.error("Error: gRPC address is required (anytypeHelper uses dynamic ports)");
      process.exit(1);
    }

    console.log(`\nConnecting to Anytype gRPC at ${address}...`);

    const mnemonic = await prompt("Enter your 12-word recovery phrase: ");
    if (!mnemonic.trim()) {
      console.error("Error: Mnemonic cannot be empty");
      process.exit(1);
    }

    const client = new GrpcClient({ address });
    await client.ensureConnected();

    const { token, appToken, accountId } = await client.createSession(mnemonic.trim());
    client.close();

    // Prefer appToken (persistent) if returned; otherwise save session token (full scope but ephemeral)
    const grpcToken = appToken || token;
    const tokenType = appToken ? "appToken (persistent)" : "session token (re-run grpc-auth after Anytype restarts)";

    // Save the token and address to credentials (read-modify-write)
    saveCredentials({ grpcAppToken: grpcToken, grpcAddress: address });

    console.log(`\nAuthenticated successfully!`);
    console.log(`  Account ID: ${accountId}`);
    console.log(`  gRPC address: ${address}`);
    console.log(`  Token type: ${tokenType}`);
    console.log(`  Credentials saved to ${CREDENTIALS_PATH}`);
    console.log(`\nThe gRPC file tools (file-upload, file-download, file-read) are now available.`);
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    rl.close();
  }
}
