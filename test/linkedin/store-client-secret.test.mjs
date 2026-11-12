import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runStoreClientSecret, storeArgs } from "../../linkedin/scripts/store-client-secret.mjs";

function sink() {
  const chunks = [];
  return { write: chunk => chunks.push(String(chunk)), text: () => chunks.join("") };
}

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

async function store(secret, { exitCode = 0, argv = [] } = {}) {
  const { spawn, calls } = fakeSpawn({ exitCode });
  const stdout = sink();
  const stderr = sink();
  const code = await runStoreClientSecret({ argv, prompt: async () => secret, spawn, openclawBin: "openclaw", stdout, stderr });
  return { code, calls, stdout: stdout.text(), stderr: stderr.text() };
}

test("stores the client secret as a protected secret bound to www.linkedin.com", () => {
  assert.deepEqual(storeArgs(), ["--profile", "social", "secrets", "store", "set", "LINKEDIN_CLIENT_SECRET",
    "--kind", "secret", "--allow-host", "www.linkedin.com", "--value-file", "-"]);
});

// The egress proxy inserts the stored value byte for byte into a form-encoded body.
test("the value goes only to the child's stdin, form-encoded", async () => {
  const secret = "WPL_AP1.abc+def/ghi==&x%";
  const result = await store(` ${secret} `);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].stdin(), encodeURIComponent(secret));
  assert.equal(new URLSearchParams(`client_secret=${result.calls[0].stdin()}`).get("client_secret"), secret);
  assert.deepEqual(result.calls[0].options.stdio, ["pipe", "ignore", "ignore"]);
  for (const text of [result.stdout, result.stderr, result.calls[0].args.join(" ")]) assert.ok(!text.includes("abc+def"));
});

test("an empty secret, extra arguments or a failed store report an error", async () => {
  assert.equal((await store("   ")).code, 1);
  const extra = await store("x", { argv: ["--value", "x"] });
  assert.equal(extra.code, 1);
  assert.equal(extra.calls.length, 0);
  const failed = await store("secret-value", { exitCode: 2 });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /exited 2/);
  assert.doesNotMatch(failed.stderr, /secret-value/);
});
