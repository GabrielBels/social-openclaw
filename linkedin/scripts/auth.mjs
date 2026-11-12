#!/home/openclaw/.openclaw/tools/node/bin/node
// Renews the LinkedIn member token (every 60 days; LinkedIn gives self-serve apps no refresh token), in two steps:
//   auth.mjs url       Gabriel, in a WSL terminal: prints the authorization link, takes the address the browser could
//                      not open at a hidden prompt, checks its state and keeps its code for 30 minutes, in a private
//                      file outside the agent's workspace.
//   auth.mjs exchange  the agent, through Gateway-hosted exec and Gabriel's /approve, with no arguments: uses that code
//                      once and trades it for a token.
// The exchange runs in Gateway-hosted exec because the client secret is a protected OpenClaw secret
// (LINKEDIN_CLIENT_SECRET): this script only ever holds its sentinel, and the egress proxy substitutes it on the way to
// www.linkedin.com. The link and the code never pass through the agent or the chat. The client id and the redirect URL
// registered in the LinkedIn app are OpenClaw env entries (LINKEDIN_CLIENT_ID, LINKEDIN_REDIRECT_URI). The access token
// goes only to the stdin of `openclaw secrets store set`. Nothing secret is printed: no token, secret, sentinel or code.
import { spawn as spawnProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promptHidden } from "../../scripts/lib/prompt.mjs";

export const SCOPES = ["openid", "profile", "w_member_social"];
// LinkedIn authorization codes live 30 minutes.
export const CODE_TTL_MS = 30 * 60 * 1000;
const codePattern = /^[A-Za-z0-9_-]{16,2048}$/;
const authorizeUrl = "https://www.linkedin.com/oauth/v2/authorization";
const tokenUrl = "https://www.linkedin.com/oauth/v2/accessToken";
const userinfoUrl = "https://api.linkedin.com/v2/userinfo";
const requestTimeoutMs = 30000;
const protectedSentinelPrefix = "oc-sent-v2";
const defaults = {
  openclawBin: "/usr/local/bin/openclaw",
  workspace: "/home/openclaw/.openclaw-social/workspace-linkedin",
  pendingFile: "/home/openclaw/.openclaw-social/social-openclaw/state/oauth-pending.json"
};

export class AuthError extends Error {}

export function readClientId(value) {
  if (!value) throw new AuthError("LINKEDIN_CLIENT_ID is not in the OpenClaw store (see docs/operations.md, Setup)");
  if (value.startsWith(protectedSentinelPrefix)) {
    throw new AuthError("LINKEDIN_CLIENT_ID must be stored with --kind env: the browser needs its real value");
  }
  if (!/^[A-Za-z0-9]{6,64}$/.test(value)) throw new AuthError("LINKEDIN_CLIENT_ID does not look like a LinkedIn client id");
  return value;
}

function isRedirectUri(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

// The redirect URL exactly as registered in the LinkedIn app's Auth tab. The page never has to load.
export function readRedirectUri(value) {
  const redirectUri = String(value ?? "").trim();
  if (!redirectUri) throw new AuthError("LINKEDIN_REDIRECT_URI is not in the OpenClaw store (see docs/operations.md, Setup)");
  if (!isRedirectUri(redirectUri)) {
    throw new AuthError("LINKEDIN_REDIRECT_URI must be the http(s) URL registered in the LinkedIn app, without query or fragment");
  }
  return redirectUri;
}

// Gateway-hosted exec gets env entries as variables; a terminal reads the entry from the store.
function storeEnvEntry(name, { spawn, openclawBin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(openclawBin, ["--profile", "social", "secrets", "store", "get", name, "--json"],
      { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.on("error", () => reject(new AuthError(`could not run openclaw to read ${name}`)));
    child.on("close", code => {
      try {
        if (code !== 0) throw new Error();
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")).value);
      } catch {
        resolve(undefined);
      }
    });
  });
}

async function storeEnv(env, name, deps) {
  return env[name] ?? await storeEnvEntry(name, deps);
}

// A plaintext value is refused rather than used: the secret must stay a protected OpenClaw secret.
export function requiredProtectedSecret(name, env) {
  const value = env[name];
  if (!value) throw new AuthError(`${name} is not in the OpenClaw store (see docs/operations.md, Setup)`);
  if (!value.startsWith(protectedSentinelPrefix)) throw new AuthError(`${name} must remain a protected OpenClaw secret`);
  return value;
}

export function authorizationUrl({ clientId, redirectUri, state }) {
  const url = new URL(authorizeUrl);
  url.search = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, state, scope: SCOPES.join(" ")
  }).toString();
  return url.toString();
}

// The pasted address must be the registered redirect URL, carrying our state and a code (or LinkedIn's error).
export function codeFromRedirect(pasted, { redirectUri, state }) {
  let url;
  try {
    url = new URL(String(pasted).trim());
  } catch {
    throw new AuthError("that is not the address LinkedIn redirected to; nothing was saved");
  }
  const expected = new URL(redirectUri);
  if (url.origin + url.pathname !== expected.origin + expected.pathname) {
    throw new AuthError(`the address must start with ${redirectUri}; nothing was saved`);
  }
  const params = url.searchParams;
  if (params.get("state") !== state) throw new AuthError("the state does not match this link; nothing was saved");
  if (params.get("error")) throw new AuthError(`LinkedIn refused the authorization: ${params.get("error")}`);
  const code = params.get("code") ?? "";
  if (!codePattern.test(code)) throw new AuthError("the address carries no valid authorization code; nothing was saved");
  return code;
}

async function writePrivateJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

// One authorization allows one exchange: the code is removed before LinkedIn is called. The exchange must send the
// redirect URL the link carried, so it is kept with the code.
async function takePendingCode(file, now) {
  let pending;
  try {
    pending = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new AuthError("no authorization is waiting; run linkedin/scripts/auth.mjs url in WSL first");
  }
  await rm(file, { force: true });
  const age = now.getTime() - Date.parse(pending.createdAt);
  if (!(age >= 0 && age <= CODE_TTL_MS)) throw new AuthError("the authorization is older than 30 minutes; run linkedin/scripts/auth.mjs url again");
  if (!codePattern.test(String(pending.code ?? "")) || !isRedirectUri(pending.redirectUri)) {
    throw new AuthError("the saved authorization is invalid; run linkedin/scripts/auth.mjs url again");
  }
  return { code: pending.code, redirectUri: pending.redirectUri };
}

// LinkedIn's OAuth error code and description, bounded and printable; nothing else from the response is kept.
async function oauthError(response) {
  let data;
  try {
    data = JSON.parse(await response.text());
  } catch {
    return "";
  }
  const error = /^[a-z_]{1,64}$/.test(String(data?.error ?? "")) ? data.error : "";
  const description = String(data?.error_description ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
  return [error, description].filter(Boolean).join(": ");
}

async function jsonOrFail(response, stage) {
  if (!response.ok) {
    const detail = await oauthError(response);
    throw new AuthError(`${stage} failed with HTTP ${response.status}${detail ? ` (${detail})` : ""}; nothing was stored`);
  }
  try {
    return await response.json();
  } catch {
    throw new AuthError(`${stage} returned invalid JSON; nothing was stored`);
  }
}

async function send(fetch, url, init, stage) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? "timeout" : "network error";
    throw new AuthError(`${stage} did not complete (${reason}); nothing was stored, run linkedin/scripts/auth.mjs url again`);
  }
}

// LinkedIn documents `scope` as "URL-encoded, space-delimited"; commas are accepted too.
export function grantedScopes(scope) {
  let text = String(scope ?? "");
  try {
    text = decodeURIComponent(text);
  } catch {
    // not URL-encoded: keep it as is
  }
  return text.split(/[\s,]+/).filter(Boolean);
}

// The client secret travels as its sentinel. The proxy inserts the stored value as-is, which is why
// store-client-secret.mjs stores it already form-encoded.
export async function exchangeCode({ fetch, clientId, clientSecret, code, redirectUri }) {
  const response = await send(fetch, tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret
    }).toString()
  }, "the token exchange");
  const data = await jsonOrFail(response, "the token exchange");
  if (typeof data.access_token !== "string" || data.access_token === "") throw new AuthError("the token exchange returned no access token");
  if (!Number.isInteger(data.expires_in) || data.expires_in <= 0) throw new AuthError("the token exchange returned no expires_in");
  if (data.scope !== undefined && !grantedScopes(data.scope).includes("w_member_social")) {
    throw new AuthError("the token lacks w_member_social: add the Share on LinkedIn product to the app; nothing was stored");
  }
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

export async function fetchMember({ fetch, accessToken }) {
  const response = await send(fetch, userinfoUrl, { headers: { authorization: `Bearer ${accessToken}` } }, "reading /v2/userinfo");
  const data = await jsonOrFail(response, "reading /v2/userinfo");
  if (typeof data.sub !== "string" || !/^[A-Za-z0-9_-]+$/.test(data.sub)) throw new AuthError("/v2/userinfo returned no valid sub");
  const name = typeof data.name === "string" ? data.name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 100) : "";
  return { personUrn: `urn:li:person:${data.sub}`, name };
}

// The token reaches only the child's stdin. Its output is discarded except for the exit code. It is allowed for the
// API and for www.linkedin.com, where LinkedIn receives image uploads.
export function storeToken({ spawn, openclawBin, accessToken }) {
  const args = ["--profile", "social", "secrets", "store", "set", "LINKEDIN_ACCESS_TOKEN",
    "--kind", "secret", "--allow-host", "api.linkedin.com", "--allow-host", "www.linkedin.com", "--value-file", "-"];
  return new Promise((resolve, reject) => {
    const child = spawn(openclawBin, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => reject(new AuthError("could not run openclaw; nothing was stored")));
    child.on("close", code => code === 0
      ? resolve()
      : reject(new AuthError(`openclaw secrets store set exited ${code}; nothing was stored, run linkedin/scripts/auth.mjs url again`)));
    child.stdin.end(accessToken);
  });
}

async function startAuthorization({ env, spawn, openclawBin, prompt, now, newState, pendingFile, stdout }) {
  const clientId = readClientId(await storeEnv(env, "LINKEDIN_CLIENT_ID", { spawn, openclawBin }));
  const redirectUri = readRedirectUri(await storeEnv(env, "LINKEDIN_REDIRECT_URI", { spawn, openclawBin }));
  const state = newState();
  stdout.write(`Open this link in the Windows browser, sign in as yourself and allow access:\n${authorizationUrl({ clientId, redirectUri, state })}\n\n`);
  stdout.write(`LinkedIn then sends the browser to ${redirectUri}?code=...; the page may fail to load, and that is fine. Copy the whole address from its address bar.\n`);
  const code = codeFromRedirect(await prompt("Paste the address (hidden): "), { redirectUri, state });
  await writePrivateJson(pendingFile, { code, redirectUri, createdAt: now().toISOString() });
  stdout.write("Saved. Within 30 minutes, send \"renew the token\" to the bot and approve its auth.mjs exchange.\n");
}

async function finishAuthorization({ env, fetch, spawn, openclawBin, now, workspace, pendingFile, stdout }) {
  // `url` never needs the client secret, so it is checked before the code is taken: a missing one keeps the code.
  const clientSecret = requiredProtectedSecret("LINKEDIN_CLIENT_SECRET", env);
  const { code, redirectUri } = await takePendingCode(pendingFile, now());
  const clientId = readClientId(await storeEnv(env, "LINKEDIN_CLIENT_ID", { spawn, openclawBin }));
  const { accessToken, expiresIn } = await exchangeCode({ fetch, clientId, clientSecret, code, redirectUri });
  const { personUrn, name } = await fetchMember({ fetch, accessToken });
  await storeToken({ spawn, openclawBin, accessToken });
  const expiresAt = new Date(now().getTime() + expiresIn * 1000).toISOString();
  await writePrivateJson(path.join(workspace, "state", "linkedin-account.json"), { personUrn, expiresAt });
  stdout.write(`${JSON.stringify({ status: "stored", member: name || personUrn, expiresAt })}\n`);
}

export async function runAuth({
  argv = process.argv.slice(2),
  env = process.env,
  fetch = globalThis.fetch,
  spawn = spawnProcess,
  prompt = promptHidden,
  now = () => new Date(),
  newState = () => randomBytes(16).toString("hex"),
  openclawBin = defaults.openclawBin,
  workspace = defaults.workspace,
  pendingFile = defaults.pendingFile,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  const [step] = argv;
  try {
    if (argv.length !== 1 || !["url", "exchange"].includes(step)) throw new AuthError("usage: auth.mjs url | auth.mjs exchange");
    const deps = { env, fetch, spawn, prompt, now, newState, openclawBin, workspace, pendingFile, stdout };
    if (step === "url") await startAuthorization(deps);
    else await finishAuthorization(deps);
    return 0;
  } catch (error) {
    // Only the error's code or name for unexpected failures: their messages could quote a request.
    const message = error instanceof AuthError || error?.message === "run this in an interactive terminal" || error?.message === "cancelled"
      ? error.message : `token renewal failed: ${error?.code ?? error?.name ?? "error"}`;
    stderr.write(step === "exchange" ? `${JSON.stringify({ status: "failed", message })}\n` : `${message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runAuth();
}
