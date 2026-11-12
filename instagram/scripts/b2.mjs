#!/home/openclaw/.openclaw/tools/node/bin/node
// Operator-only hidden entry of a bucket-restricted B2 key. No credential is printed or written to a file.
import { spawn as spawnProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promptHidden } from "../../scripts/lib/prompt.mjs";

export const SECRET_NAME = "INSTAGRAM_B2_BASIC_AUTH";
export const SECRET_HOST = "api.backblazeb2.com";
export function storeArgs() {
  return ["--profile", "social", "secrets", "store", "set", SECRET_NAME, "--kind", "secret", "--allow-host", SECRET_HOST, "--value-file", "-"];
}

export async function runStore({
  argv = process.argv.slice(2), prompt = promptHidden, spawn = spawnProcess, openclawBin = "/usr/local/bin/openclaw",
  stdout = process.stdout, stderr = process.stderr
} = {}) {
  try {
    if (argv.length !== 1 || argv[0] !== "store") throw new Error("usage: b2.mjs store");
    const keyId = (await prompt("B2 application key ID (hidden): ")).trim();
    const key = (await prompt("B2 application key (hidden): ")).trim();
    if (!/^[A-Za-z0-9]{10,100}$/.test(keyId) || !/^[A-Za-z0-9+/_=-]{20,200}$/.test(key)) {
      throw new Error("That does not look like a B2 application key ID and key; nothing was stored.");
    }
    const value = `Basic ${Buffer.from(`${keyId}:${key}`).toString("base64")}`;
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(openclawBin, storeArgs(), { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => reject(new Error("Could not run OpenClaw; nothing was stored.")));
      child.on("close", resolve);
      child.stdin.on("error", () => reject(new Error("Could not store the B2 credential.")));
      child.stdin.end(value);
    });
    if (exit !== 0) throw new Error("OpenClaw could not store the B2 credential.");
    stdout.write(`Stored ${SECRET_NAME} as a protected secret bound to ${SECRET_HOST}.\n`);
    return 0;
  } catch (error) {
    const safe = ["usage: b2.mjs store", "That does not look like a B2 application key ID and key; nothing was stored.",
      "Could not run OpenClaw; nothing was stored.", "Could not store the B2 credential.", "OpenClaw could not store the B2 credential.",
      "run this in an interactive terminal", "cancelled"];
    stderr.write(`${safe.includes(error?.message) ? error.message : "B2 credential entry failed; no credential was printed."}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runStore();
