import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { REFRESH_URL, runToken, storeArgs } from "../../instagram/scripts/token.mjs";

const dashboardToken = `IGAA${"d".repeat(120)}`;
const refreshedToken = `IGAA${"r".repeat(120)}`;
const sentinel = "oc-sent-v2.ig-token-sentinel.end";
const t0 = new Date("2026-10-12T12:00:00Z");

function sink() {
  const chunks = [];
  return { write: chunk => chunks.push(String(chunk)), text: () => chunks.join("") };
}

// `openclaw secrets store set` records what reached its stdin and exits with `exitCode`.
function fakeSpawn({ exitCode = 0 } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    const chunks = [];
    child.stdin = new PassThrough();
    child.stdin.on("data", chunk => chunks.push(chunk));
    child.stdin.on("finish", () => setImmediate(() => child.emit("close", exitCode)));
    calls.push({ command, args, options, stdin: () => Buffer.concat(chunks).toString("utf8") });
    return child;
  };
  return { spawn, calls };
}

function fakeFetch(answer = () => new Response(JSON.stringify({ access_token: refreshedToken, token_type: "bearer", expires_in: 5183944 }), { status: 200 })) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return answer();
  };
  return { fetch, calls };
}

async function invoke(t, { argv, env = { INSTAGRAM_ACCESS_TOKEN: sentinel }, fetch = fakeFetch().fetch, spawn = fakeSpawn().spawn, typed = dashboardToken } = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "instagram-token-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const stdout = sink();
  const stderr = sink();
  const exit = await runToken({ argv, env, fetch, spawn, prompt: async () => typed, now: () => t0, openclawBin: "openclaw", workspace, stdout, stderr });
  return { exit, stdout: stdout.text(), stderr: stderr.text(), workspace };
}

const stateOf = async workspace => JSON.parse(await readFile(path.join(workspace, "state", "instagram-token.json"), "utf8"));

test("stores the token as a protected secret bound to graph.instagram.com, through stdin only", () => {
  assert.deepEqual(storeArgs(), ["--profile", "social", "secrets", "store", "set", "INSTAGRAM_ACCESS_TOKEN",
    "--kind", "secret", "--allow-host", "graph.instagram.com", "--value-file", "-"]);
});

test("store: takes the dashboard token at the hidden prompt, stores it and records a 60-day expiry", async t => {
  const { spawn, calls } = fakeSpawn();
  const result = await invoke(t, { argv: ["store"], spawn, typed: ` ${dashboardToken}\n` });
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, storeArgs());
  assert.equal(calls[0].stdin(), dashboardToken);
  assert.deepEqual(await stateOf(result.workspace), { expiresAt: "2026-12-11T12:00:00.000Z", renewedAt: "2026-10-12T12:00:00.000Z" });
  if (process.platform !== "win32") assert.equal((await stat(path.join(result.workspace, "state", "instagram-token.json"))).mode & 0o777, 0o600);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(dashboardToken));
});

test("store: refuses something that is not a token, and reports a failed store", async t => {
  for (const typed of ["", "https://www.instagram.com/oauth/authorize?code=x", "short"]) {
    const { spawn, calls } = fakeSpawn();
    const result = await invoke(t, { argv: ["store"], spawn, typed });
    assert.equal(result.exit, 1);
    assert.match(result.stderr, /does not look like an Instagram access token; nothing was stored/);
    assert.equal(calls.length, 0);
  }
  const failed = await invoke(t, { argv: ["store"], spawn: fakeSpawn({ exitCode: 3 }).spawn });
  assert.equal(failed.exit, 1);
  assert.match(failed.stderr, /exited 3; nothing was stored/);
});

test("refresh: trades the stored token's sentinel for a new token, stores it and records its expiry", async t => {
  const { fetch, calls } = fakeFetch();
  const store = fakeSpawn();
  const result = await invoke(t, { argv: ["refresh"], fetch, spawn: store.spawn });
  assert.equal(result.exit, 0, result.stderr);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, REFRESH_URL);
  assert.equal(url.searchParams.get("grant_type"), "ig_refresh_token");
  assert.equal(url.searchParams.get("access_token"), sentinel);
  assert.equal(store.calls[0].stdin(), refreshedToken);
  const expiresAt = new Date(t0.getTime() + 5183944 * 1000).toISOString();
  assert.deepEqual(JSON.parse(result.stdout), { status: "stored", expiresAt });
  assert.deepEqual(await stateOf(result.workspace), { expiresAt, renewedAt: t0.toISOString() });
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${refreshedToken}|oc-sent-v2`));
});

test("refresh: a missing or plaintext token, or a refusal, changes nothing and says what to do", async t => {
  for (const [options, message] of [
    [{ env: {} }, /not in the OpenClaw store; run instagram\/scripts\/token\.mjs store/],
    [{ env: { INSTAGRAM_ACCESS_TOKEN: dashboardToken } }, /must remain a protected OpenClaw secret/],
    [{ fetch: fakeFetch(() => new Response(JSON.stringify({ error: { message: "Error validating access token", code: 190 } }), { status: 400 })).fetch },
      /expired or was revoked: generate a new one in the Meta app/],
    [{ fetch: fakeFetch(() => new Response(JSON.stringify({ error: { message: "Token too new", code: 100 } }), { status: 400 })).fetch },
      /HTTP 400 \(Token too new\); the stored token is unchanged\. A token can be refreshed only after 24 hours/],
    [{ fetch: fakeFetch(() => { throw new DOMException("timed out", "TimeoutError"); }).fetch }, /did not complete \(timeout\)/],
    [{ fetch: fakeFetch(() => new Response(JSON.stringify({ access_token: refreshedToken }), { status: 200 })).fetch }, /no expires_in/],
    [{ fetch: fakeFetch(() => new Response("not json", { status: 200 })).fetch }, /invalid JSON/]
  ]) {
    const store = fakeSpawn();
    const result = await invoke(t, { argv: ["refresh"], spawn: store.spawn, ...options });
    assert.equal(result.exit, 1);
    assert.equal(JSON.parse(result.stderr).status, "failed");
    assert.match(JSON.parse(result.stderr).message, message);
    assert.equal(store.calls.length, 0, "nothing was stored");
    assert.doesNotMatch(result.stderr, new RegExp(dashboardToken));
  }
});

test("refuses anything but store or refresh", async t => {
  for (const argv of [[], ["refresh", "now"], ["url"], ["exchange"]]) {
    const result = await invoke(t, { argv, fetch: fakeFetch(() => assert.fail("must not call Instagram")).fetch });
    assert.equal(result.exit, 1);
    assert.match(result.stderr, /usage: token\.mjs store \| token\.mjs refresh/);
  }
});
