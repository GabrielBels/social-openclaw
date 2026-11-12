import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CODE_TTL_MS, authorizationUrl, codeFromRedirect, grantedScopes, readClientId, readRedirectUri, runAuth } from "../../linkedin/scripts/auth.mjs";

const token = "AQV-test-access-token-value";
const clientSecretSentinel = "oc-sent-v2.test-client-secret-sentinel.end";
const clientId = "77abcdefgh";
const redirectUri = "https://app.example.test/oauth/linkedin";
const state = "a".repeat(32);
const code = "AQTQmah11lalyH65DAIivsjsAQV5P-1VTVVebnLl_SCiyMXoIjD";
const t0 = new Date("2026-10-07T12:00:00Z");
const gatewayEnv = { LINKEDIN_CLIENT_ID: clientId, LINKEDIN_REDIRECT_URI: redirectUri, LINKEDIN_CLIENT_SECRET: clientSecretSentinel };
const redirect = (params = { code, state }) => `${redirectUri}?${new URLSearchParams(params)}`;

function sink() {
  const chunks = [];
  return { write: chunk => chunks.push(String(chunk)), text: () => chunks.join("") };
}

// `secrets store get NAME --json` answers the env entries in `store`; `secrets store set` records what reached its stdin.
function fakeSpawn({ setExitCode = 0, store = { LINKEDIN_CLIENT_ID: clientId, LINKEDIN_REDIRECT_URI: redirectUri } } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    const chunks = [];
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stdin.on("data", chunk => chunks.push(chunk));
    const isGet = args.includes("get");
    const name = args[args.indexOf("get") + 1];
    if (isGet) {
      setImmediate(() => {
        child.stdout.end(name in store ? JSON.stringify({ name, kind: "env", value: store[name] }) : "");
        child.emit("close", name in store ? 0 : 1);
      });
    } else child.stdin.on("finish", () => setImmediate(() => child.emit("close", setExitCode)));
    calls.push({ command, args, options, kind: isGet ? "get" : "set", stdin: () => Buffer.concat(chunks).toString("utf8") });
    return child;
  };
  return { spawn, calls };
}

function fakeFetch({ tokenStatus = 200, tokenBody, userinfoBody = { sub: "AbC123", name: "Gabriel Example" }, throwOnToken } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/oauth/v2/accessToken")) {
      if (throwOnToken) throw throwOnToken;
      return new Response(JSON.stringify(tokenBody ?? { access_token: token, expires_in: 5184000, scope: "openid,profile,w_member_social" }), { status: tokenStatus });
    }
    if (url.endsWith("/v2/userinfo")) return new Response(JSON.stringify(userinfoBody), { status: 200 });
    throw new Error(`unexpected URL ${url}`);
  };
  return { fetch, calls };
}

async function sandbox(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "linkedin-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  return { workspace, pendingFile: path.join(root, "install", "state", "oauth-pending.json") };
}

async function invoke(paths, { argv, env = gatewayEnv, fetch = fakeFetch().fetch, spawn = fakeSpawn().spawn, pasted = redirect(), now = t0 } = {}) {
  const stdout = sink();
  const stderr = sink();
  const exit = await runAuth({ argv, env, fetch, spawn, prompt: async () => pasted, now: () => now, newState: () => state,
    openclawBin: "openclaw", workspace: paths.workspace, pendingFile: paths.pendingFile, stdout, stderr });
  return { exit, stdout: stdout.text(), stderr: stderr.text() };
}

test("builds the authorization link with the three scopes, the state and the stored redirect", () => {
  const url = new URL(authorizationUrl({ clientId, redirectUri, state }));
  assert.equal(url.origin + url.pathname, "https://www.linkedin.com/oauth/v2/authorization");
  assert.equal(url.searchParams.get("scope"), "openid profile w_member_social");
  assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(url.searchParams.get("client_id"), clientId);
  assert.equal(url.searchParams.get("state"), state);
});

test("the client id must be a plain env entry: the browser needs its real value", () => {
  assert.equal(readClientId(clientId), clientId);
  assert.throws(() => readClientId(undefined), /not in the OpenClaw store/);
  assert.throws(() => readClientId("oc-sent-v2.x.end"), /--kind env/);
  assert.throws(() => readClientId("bad id!"), /does not look like/);
});

test("the redirect URL is the store's value as registered: absolute http(s), without query or fragment", () => {
  assert.equal(readRedirectUri(` ${redirectUri}\n`), redirectUri);
  assert.equal(readRedirectUri("http://localhost:8080/cb"), "http://localhost:8080/cb");
  assert.throws(() => readRedirectUri(undefined), /LINKEDIN_REDIRECT_URI is not in the OpenClaw store/);
  for (const bad of ["/linkedin-callback", "ftp://example.test/cb", `${redirectUri}?x=1`, `${redirectUri}#x`, "oc-sent-v2.x.end"]) {
    assert.throws(() => readRedirectUri(bad), /must be the http\(s\) URL/, bad);
  }
});

test("takes the code from the pasted redirect address, refusing another state, URL, error or code", () => {
  const expected = { redirectUri, state };
  assert.equal(codeFromRedirect(`  ${redirect()}  `, expected), code);
  assert.throws(() => codeFromRedirect(redirect({ code, state: "b".repeat(32) }), expected), /state does not match/);
  assert.throws(() => codeFromRedirect(redirect({ error: "user_cancelled_authorize", state }), expected), /refused/);
  assert.throws(() => codeFromRedirect(`https://evil.example/oauth/linkedin?code=${code}&state=${state}`, expected), /must start with/);
  assert.throws(() => codeFromRedirect(`https://app.example.test/other?code=${code}&state=${state}`, expected), /must start with/);
  assert.throws(() => codeFromRedirect(redirect({ code: "short", state }), expected), /no valid authorization code/);
  assert.throws(() => codeFromRedirect("not an address", expected), /not the address/);
});

test("reads granted scopes URL-encoded, space- or comma-separated", () => {
  for (const scope of ["openid%20profile%20w_member_social", "openid profile w_member_social", "openid,profile,w_member_social"]) {
    assert.deepEqual(grantedScopes(scope), ["openid", "profile", "w_member_social"]);
  }
});

test("url, in a terminal, reads the client id and redirect URL from the store, prints the link and keeps the code privately", async t => {
  const paths = await sandbox(t);
  const { spawn, calls } = fakeSpawn();
  const result = await invoke(paths, { argv: ["url"], env: {}, spawn });
  assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(calls.map(call => call.args), [
    ["--profile", "social", "secrets", "store", "get", "LINKEDIN_CLIENT_ID", "--json"],
    ["--profile", "social", "secrets", "store", "get", "LINKEDIN_REDIRECT_URI", "--json"]
  ]);
  const link = result.stdout.split("\n").find(line => line.startsWith("https://www.linkedin.com/"));
  assert.equal(new URL(link).searchParams.get("client_id"), clientId);
  assert.equal(new URL(link).searchParams.get("redirect_uri"), redirectUri);
  assert.equal(new URL(link).searchParams.get("state"), state);
  assert.match(result.stdout, /renew the token/);
  assert.ok(!result.stdout.includes(code), "the code is never printed");
  assert.deepEqual(JSON.parse(await readFile(paths.pendingFile, "utf8")), { code, redirectUri, createdAt: t0.toISOString() });
  if (process.platform !== "win32") assert.equal((await stat(paths.pendingFile)).mode & 0o777, 0o600);
});

test("url shows no link without LINKEDIN_REDIRECT_URI in the store", async t => {
  const paths = await sandbox(t);
  const { spawn } = fakeSpawn({ store: { LINKEDIN_CLIENT_ID: clientId } });
  const result = await invoke(paths, { argv: ["url"], env: {}, spawn });
  assert.equal(result.exit, 1);
  assert.match(result.stderr, /LINKEDIN_REDIRECT_URI is not in the OpenClaw store/);
  assert.equal(result.stdout, "");
  await assert.rejects(readFile(paths.pendingFile, "utf8"), { code: "ENOENT" });
});

test("url saves nothing when the pasted address does not match the link", async t => {
  const paths = await sandbox(t);
  const result = await invoke(paths, { argv: ["url"], pasted: redirect({ code, state: "b".repeat(32) }) });
  assert.equal(result.exit, 1);
  assert.match(result.stderr, /state does not match/);
  await assert.rejects(readFile(paths.pendingFile, "utf8"), { code: "ENOENT" });
});

test("exchange uses the saved code once, sends the client secret's sentinel, and stores the token only through stdin", async t => {
  const paths = await sandbox(t);
  await invoke(paths, { argv: ["url"] });
  const { fetch, calls: fetchCalls } = fakeFetch();
  const { spawn, calls } = fakeSpawn();
  // The exchange sends the redirect URL the link carried, even if the store changed in between.
  const env = { ...gatewayEnv, LINKEDIN_REDIRECT_URI: "https://changed.example.test/cb" };
  const result = await invoke(paths, { argv: ["exchange"], env, fetch, spawn, now: new Date(t0.getTime() + 60000) });
  assert.equal(result.exit, 0, result.stderr);
  const body = new URLSearchParams(fetchCalls[0].init.body);
  assert.ok(fetchCalls[0].init.body.includes(`client_secret=${clientSecretSentinel}`), "the sentinel is sent byte for byte");
  assert.equal(body.get("client_id"), clientId);
  assert.equal(body.get("code"), code);
  assert.equal(body.get("redirect_uri"), redirectUri);
  const sets = calls.filter(call => call.kind === "set");
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].args, ["--profile", "social", "secrets", "store", "set", "LINKEDIN_ACCESS_TOKEN",
    "--kind", "secret", "--allow-host", "api.linkedin.com", "--allow-host", "www.linkedin.com", "--value-file", "-"]);
  assert.equal(sets[0].stdin(), token);
  assert.deepEqual(sets[0].options.stdio, ["pipe", "ignore", "ignore"]);
  const account = JSON.parse(await readFile(path.join(paths.workspace, "state", "linkedin-account.json"), "utf8"));
  assert.deepEqual(account, { personUrn: "urn:li:person:AbC123", expiresAt: "2026-12-06T12:01:00.000Z" });
  assert.deepEqual(JSON.parse(result.stdout), { status: "stored", member: "Gabriel Example", expiresAt: "2026-12-06T12:01:00.000Z" });
  const again = await invoke(paths, { argv: ["exchange"], fetch: async () => assert.fail("must not call LinkedIn twice") });
  assert.match(JSON.parse(again.stderr).message, /no authorization is waiting/);
});

test("nothing secret appears in output, arguments or the account file", async t => {
  const paths = await sandbox(t);
  const started = await invoke(paths, { argv: ["url"] });
  const { spawn, calls } = fakeSpawn();
  const result = await invoke(paths, { argv: ["exchange"], spawn });
  const account = await readFile(path.join(paths.workspace, "state", "linkedin-account.json"), "utf8");
  for (const value of [token, clientSecretSentinel, code]) {
    assert.ok(!(started.stdout + started.stderr + result.stdout + result.stderr).includes(value), value);
    assert.ok(!calls.map(call => call.args.join(" ")).join(" ").includes(value), value);
    assert.ok(!account.includes(value), value);
  }
});

test("exchange refuses a missing, expired, future-dated or malformed saved authorization, and always consumes it", async t => {
  const fetch = async () => assert.fail("must not call LinkedIn");
  let paths = await sandbox(t);
  assert.match(JSON.parse((await invoke(paths, { argv: ["exchange"], fetch })).stderr).message, /no authorization is waiting/);
  for (const [saved, now] of [
    [{ code, createdAt: t0.toISOString() }, new Date(t0.getTime() + CODE_TTL_MS + 1)],
    [{ code, createdAt: new Date(t0.getTime() + 60000).toISOString() }, t0],
    [{ code: "x;rm -rf", redirectUri, createdAt: t0.toISOString() }, t0],
    [{ code, createdAt: t0.toISOString() }, t0],
    [{ code, redirectUri: "javascript:alert(1)", createdAt: t0.toISOString() }, t0],
    [{ code, redirectUri }, t0]
  ]) {
    paths = await sandbox(t);
    await mkdir(path.dirname(paths.pendingFile), { recursive: true });
    await writeFile(paths.pendingFile, JSON.stringify(saved));
    const result = await invoke(paths, { argv: ["exchange"], fetch, now });
    assert.equal(result.exit, 1);
    assert.match(JSON.parse(result.stderr).message, /older than 30 minutes|invalid/);
    await assert.rejects(readFile(paths.pendingFile, "utf8"), { code: "ENOENT" });
  }
});

test("exchange refuses a plaintext or missing client secret before calling LinkedIn, and keeps the saved authorization", async t => {
  const fetch = async () => assert.fail("must not call LinkedIn");
  for (const secret of [undefined, "plaintext-client-secret"]) {
    const paths = await sandbox(t);
    await invoke(paths, { argv: ["url"] });
    const result = await invoke(paths, { argv: ["exchange"], fetch, env: { LINKEDIN_CLIENT_ID: clientId, LINKEDIN_CLIENT_SECRET: secret } });
    assert.equal(result.exit, 1);
    assert.match(JSON.parse(result.stderr).message, /LINKEDIN_CLIENT_SECRET/);
    assert.doesNotMatch(result.stderr, /plaintext-client-secret/);
    // Once the secret is stored, the same authorization still renews the token.
    const retry = await invoke(paths, { argv: ["exchange"] });
    assert.equal(retry.exit, 0, retry.stderr);
  }
});

test("a failed or timed-out exchange, a token without w_member_social, or a failed store leaves no account file", async t => {
  for (const [fetchOptions, spawnOptions] of [
    [{ tokenStatus: 400 }, {}],
    [{ throwOnToken: new DOMException("timed out", "TimeoutError") }, {}],
    [{ tokenBody: { access_token: token, expires_in: 5184000, scope: "openid%20profile" } }, {}],
    [{}, { setExitCode: 1 }]
  ]) {
    const paths = await sandbox(t);
    await invoke(paths, { argv: ["url"] });
    const { spawn } = fakeSpawn(spawnOptions);
    const result = await invoke(paths, { argv: ["exchange"], fetch: fakeFetch(fetchOptions).fetch, spawn });
    assert.equal(result.exit, 1);
    assert.ok(!result.stderr.includes(token));
    await assert.rejects(readFile(path.join(paths.workspace, "state", "linkedin-account.json"), "utf8"), { code: "ENOENT" });
  }
});

test("a refused exchange reports LinkedIn's OAuth error and nothing else from the response", async t => {
  const paths = await sandbox(t);
  await invoke(paths, { argv: ["url"] });
  const tokenBody = { error: "invalid_client", error_description: "Client authentication failed\n", access_token: token };
  const result = await invoke(paths, { argv: ["exchange"], fetch: fakeFetch({ tokenStatus: 401, tokenBody }).fetch });
  assert.equal(result.exit, 1);
  assert.equal(JSON.parse(result.stderr).message,
    "the token exchange failed with HTTP 401 (invalid_client: Client authentication failed); nothing was stored");
});

test("refuses anything but `url` or a bare `exchange`", async t => {
  const paths = await sandbox(t);
  const fetch = async () => assert.fail("must not call LinkedIn");
  for (const argv of [[], ["url", "extra"], ["exchange", code], ["exchange", code, state], ["publish"]]) {
    const result = await invoke(paths, { argv, fetch });
    assert.equal(result.exit, 1, argv.join(" "));
    assert.match(result.stderr, /usage/);
  }
});
