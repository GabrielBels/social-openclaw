import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runStore, storeArgs } from "../../instagram/scripts/b2.mjs";

const keyId = "005dummykeyidentifier";
const key = "K005dummyapplicationkeyforunittest";

async function invoke({ argv = ["store"], typed = [keyId, key], exit = 0, promptError } = {}) {
  const calls = [], output = [], errors = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdin = new PassThrough();
    const chunks = [];
    child.stdin.on("data", chunk => chunks.push(chunk));
    child.stdin.on("finish", () => setImmediate(() => child.emit("close", exit)));
    calls.push({ command, args, options, value: () => Buffer.concat(chunks).toString() });
    return child;
  };
  const code = await runStore({ argv, spawn, openclawBin: "openclaw", prompt: async () => {
    if (promptError) throw promptError;
    return typed.shift();
  }, stdout: { write: value => output.push(value) }, stderr: { write: value => errors.push(value) } });
  return { code, calls, text: output.join("") + errors.join("") };
}

test("B2 key entry stores the complete Basic header through stdin as a host-bound protected secret", async () => {
  const result = await invoke();
  assert.equal(result.code, 0, result.text);
  assert.equal(result.calls[0].value(), `Basic ${Buffer.from(`${keyId}:${key}`).toString("base64")}`);
  assert.deepEqual(result.calls[0].args, storeArgs());
  assert.ok(storeArgs().includes("api.backblazeb2.com"));
  assert.deepEqual(result.calls[0].options.stdio, ["pipe", "ignore", "ignore"]);
  assert.ok(!JSON.stringify(result.calls[0].args).includes(key));
  assert.doesNotMatch(result.text, new RegExp(`${key}|${keyId}|${Buffer.from(`${keyId}:${key}`).toString("base64")}`));
});

test("invalid input and a failed protected store do not report success or echo credentials", async () => {
  for (const options of [{ typed: ["bad", key] }, { argv: [] }, { exit: 1 }, { promptError: new Error(key) }]) {
    const result = await invoke(options);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.text, new RegExp(`${key}|${keyId}`));
    assert.ok(!result.text.startsWith("Stored"));
  }
});
