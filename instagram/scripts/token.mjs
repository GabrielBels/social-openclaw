#!/home/openclaw/.openclaw/tools/node/bin/node
// Keeps the Instagram token, a protected OpenClaw secret (INSTAGRAM_ACCESS_TOKEN) bound to graph.instagram.com:
//   token.mjs store    Gabriel, in a WSL terminal: takes the token generated in the Meta app (60 days) at a hidden
//                      prompt and stores it. Needed once, and again only if the token was allowed to expire.
//   token.mjs refresh  the agent, through Gateway-hosted exec and Gabriel's /approve, with no other argument: trades
//                      the stored token (at least 24 hours old and not expired) for a new 60-day one. Meta needs no app
//                      secret for this, and the egress proxy substitutes the stored value for its sentinel in the URL.
// The new token goes only to the stdin of `openclaw secrets store set`; state/instagram-token.json in the agent's
// workspace keeps only when it expires. Nothing secret is printed: no token or sentinel.
import { spawn as spawnProcess } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promptHidden } from "../../scripts/lib/prompt.mjs";

export const TOKEN_NAME = "INSTAGRAM_ACCESS_TOKEN";
export const TOKEN_HOST = "graph.instagram.com";
// Meta documents a token generated in the app dashboard as valid for 60 days.
export const DASHBOARD_TOKEN_DAYS = 60;
export const REFRESH_URL = "https://graph.instagram.com/refresh_access_token";
const requestTimeoutMs = 30000;
const protectedSentinelPrefix = "oc-sent-v2";
const tokenPattern = /^[A-Za-z0-9._-]{40,2048}$/;
const defaults = {
  openclawBin: "/usr/local/bin/openclaw",
  workspace: "/home/openclaw/.openclaw-social/workspace-instagram"
};

export class TokenError extends Error {}

export function storeArgs() {
  return ["--profile", "social", "secrets", "store", "set", TOKEN_NAME, "--kind", "secret", "--allow-host", TOKEN_HOST, "--value-file", "-"];
}

// The token reaches only the child's stdin. Its output is discarded except for the exit code.
function storeToken({ spawn, openclawBin, token }) {
  return new Promise((resolve, reject) => {
    const child = spawn(openclawBin, storeArgs(), { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => reject(new TokenError("could not run openclaw; nothing was stored")));
    child.on("close", code => code === 0
      ? resolve()
      : reject(new TokenError(`openclaw secrets store set exited ${code}; nothing was stored`)));
    child.stdin.end(token);
  });
}

async function writeState(workspace, value) {
  const file = path.join(workspace, "state", "instagram-token.json");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

async function storeFromPrompt({ prompt, spawn, openclawBin, workspace, now, stdout }) {
  const token = (await prompt("Instagram access token from the Meta app (hidden): ")).trim();
  if (!tokenPattern.test(token)) throw new TokenError("that does not look like an Instagram access token; nothing was stored");
  await storeToken({ spawn, openclawBin, token });
  const renewedAt = now();
  const expiresAt = new Date(renewedAt.getTime() + DASHBOARD_TOKEN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await writeState(workspace, { expiresAt, renewedAt: renewedAt.toISOString() });
  stdout.write(`Stored ${TOKEN_NAME} (protected, bound to ${TOKEN_HOST}). It lasts until about ${expiresAt}; after 24 hours, send "renew the token" to the Instagram bot to extend it.\n`);
}

// Meta's own error code and message, bounded and printable; nothing else from the response is kept.
async function graphError(response) {
  try {
    const error = JSON.parse(await response.text())?.error;
    const message = String(error?.message ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
    return { code: Number.isInteger(error?.code) ? error.code : undefined, message };
  } catch {
    return { message: "" };
  }
}

async function refresh({ env, fetch, spawn, openclawBin, workspace, now, stdout }) {
  const current = env[TOKEN_NAME];
  if (!current) throw new TokenError(`${TOKEN_NAME} is not in the OpenClaw store; run instagram/scripts/token.mjs store in WSL first`);
  if (!current.startsWith(protectedSentinelPrefix)) throw new TokenError(`${TOKEN_NAME} must remain a protected OpenClaw secret; store it again with instagram/scripts/token.mjs store`);
  const url = new URL(REFRESH_URL);
  url.search = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: current }).toString();
  let response;
  try {
    response = await fetch(url.toString(), { method: "GET", signal: AbortSignal.timeout(requestTimeoutMs) });
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? "timeout" : "network error";
    throw new TokenError(`the refresh did not complete (${reason}); the stored token is unchanged`);
  }
  if (!response.ok) {
    const { code, message } = await graphError(response);
    if (code === 190) {
      throw new TokenError("the stored token expired or was revoked: generate a new one in the Meta app and run instagram/scripts/token.mjs store in WSL");
    }
    throw new TokenError(`the refresh failed with HTTP ${response.status}${message ? ` (${message})` : ""}; the stored token is unchanged. A token can be refreshed only after 24 hours`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new TokenError("the refresh returned invalid JSON; the stored token is unchanged");
  }
  if (typeof data?.access_token !== "string" || !tokenPattern.test(data.access_token)) {
    throw new TokenError("the refresh returned no access token; the stored token is unchanged");
  }
  if (!Number.isInteger(data.expires_in) || data.expires_in <= 0) throw new TokenError("the refresh returned no expires_in; the stored token is unchanged");
  await storeToken({ spawn, openclawBin, token: data.access_token });
  const renewedAt = now();
  const expiresAt = new Date(renewedAt.getTime() + data.expires_in * 1000).toISOString();
  await writeState(workspace, { expiresAt, renewedAt: renewedAt.toISOString() });
  stdout.write(`${JSON.stringify({ status: "stored", expiresAt })}\n`);
}

export async function runToken({
  argv = process.argv.slice(2),
  env = process.env,
  fetch = globalThis.fetch,
  spawn = spawnProcess,
  prompt = promptHidden,
  now = () => new Date(),
  openclawBin = defaults.openclawBin,
  workspace = defaults.workspace,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  const [step] = argv;
  try {
    if (argv.length !== 1 || !["store", "refresh"].includes(step)) throw new TokenError("usage: token.mjs store | token.mjs refresh");
    const deps = { env, fetch, spawn, prompt, now, openclawBin, workspace, stdout };
    if (step === "store") await storeFromPrompt(deps);
    else await refresh(deps);
    return 0;
  } catch (error) {
    // Only the error's code or name for unexpected failures: their messages could quote a request.
    const message = error instanceof TokenError || error?.message === "run this in an interactive terminal" || error?.message === "cancelled"
      ? error.message : `token ${step ?? ""} failed: ${error?.code ?? error?.name ?? "error"}`;
    stderr.write(step === "refresh" ? `${JSON.stringify({ status: "failed", message })}\n` : `${message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runToken();
}
