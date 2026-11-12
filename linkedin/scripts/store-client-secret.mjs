#!/home/openclaw/.openclaw/tools/node/bin/node
// Operator-only, in a WSL terminal: stores the LinkedIn app's client secret as a protected OpenClaw secret bound to
// www.linkedin.com. It is typed at a hidden prompt and goes only to the stdin of `openclaw secrets store set`.
// The Gateway egress proxy inserts a stored value into a request byte for byte, and the token exchange sends the
// secret inside a form-encoded body, so the value is stored form-encoded (a "+" in the secret would otherwise
// reach LinkedIn as a space). Always store this secret through this helper, never by hand.
import { spawn as spawnProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promptHidden } from "../../scripts/lib/prompt.mjs";

export const SECRET_NAME = "LINKEDIN_CLIENT_SECRET";

export class StoreError extends Error {}

export function storeArgs() {
  return ["--profile", "social", "secrets", "store", "set", SECRET_NAME,
    "--kind", "secret", "--allow-host", "www.linkedin.com", "--value-file", "-"];
}

export async function runStoreClientSecret({
  argv = process.argv.slice(2),
  prompt = promptHidden,
  spawn = spawnProcess,
  openclawBin = "openclaw",
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  try {
    if (argv.length !== 0) throw new StoreError("usage: store-client-secret.mjs (no arguments; the secret is typed at a prompt)");
    const secret = (await prompt("LinkedIn app client secret (hidden): ")).trim();
    if (secret === "") throw new StoreError("the client secret is empty; nothing was stored");
    await new Promise((resolve, reject) => {
      const child = spawn(openclawBin, storeArgs(), { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => reject(new StoreError(`could not run ${openclawBin}; nothing was stored`)));
      child.on("close", code => code === 0
        ? resolve()
        : reject(new StoreError(`openclaw secrets store set exited ${code}; nothing was stored. Rerun this helper: a value stored by hand is not form-encoded`)));
      child.stdin.end(encodeURIComponent(secret));
    });
    stdout.write(`stored ${SECRET_NAME} (protected, bound to www.linkedin.com)\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : "storing failed"}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runStoreClientSecret();
}
