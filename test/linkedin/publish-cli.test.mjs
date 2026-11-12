import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "../../linkedin/publisher/publish.mjs";

const sentinel = "oc-sent-v2.cli-test-sentinel-value";
const version = "202512";
const now = new Date("2026-10-07T12:00:00Z");

function sink() {
  const chunks = [];
  return { write: chunk => chunks.push(chunk), text: () => chunks.join("") };
}

async function workspace(t, { account = { personUrn: "urn:li:person:abc", expiresAt: "2026-12-01T00:00:00Z" } } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "content", "drafts"), { recursive: true });
  await mkdir(path.join(root, "state"), { recursive: true });
  await writeFile(path.join(root, "content", "drafts", "2026-10-07-x-v2.md"), "Ship it (carefully). #AI\n");
  if (account) await writeFile(path.join(root, "state", "linkedin-account.json"), JSON.stringify(account));
  return root;
}

async function invoke(root, { argv = ["content/drafts/2026-10-07-x-v2.md"], env = { LINKEDIN_ACCESS_TOKEN: sentinel, LINKEDIN_API_VERSION: version }, fetch } = {}) {
  const stdout = sink();
  const stderr = sink();
  const calls = [];
  const recordingFetch = async (url, init) => {
    calls.push({ url, init });
    return fetch(url, init);
  };
  const code = await run({ argv, env, fetch: recordingFetch, now, workspaceRoot: root, imagesDir: path.join(root, "images"), stdout, stderr });
  return { code, stdout: stdout.text(), stderr: stderr.text(), calls };
}

test("publishes the draft and prints the post URL and the draft path", async t => {
  const root = await workspace(t);
  const result = await invoke(root, {
    fetch: async () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:1" } })
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "published", urn: "urn:li:share:1", url: "https://www.linkedin.com/feed/update/urn:li:share:1/",
    draft: "content/drafts/2026-10-07-x-v2.md", image: null
  });
  assert.equal(JSON.parse(result.calls[0].init.body).commentary, "Ship it \\(carefully\\). \\#AI");
  assert.equal(result.calls[0].init.headers["linkedin-version"], version);
  assert.equal(result.stderr, "");
});

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("image")]);
const uploadUrl = "https://www.linkedin.com/dms-uploads/C4E/uploaded-image/0?ut=1";

async function withImage(root) {
  await mkdir(path.join(root, "images"));
  await writeFile(path.join(root, "images", "2026-10-07-x-v1---00000001-aaaa-bbbb-cccc-dddddddddddd.png"), png);
}

const linkedinWithImages = ({ upload = 201 } = {}) => async (url, init) => {
  if (url.endsWith("action=initializeUpload")) return new Response(JSON.stringify({ value: { uploadUrl, image: "urn:li:image:C4E" } }), { status: 200 });
  if (url === uploadUrl) return new Response(null, { status: upload });
  return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:1" } });
};

test("posts the draft with the image generated for it, reusing an earlier version's image, and reports it", async t => {
  const root = await workspace(t);
  await withImage(root);
  const result = await invoke(root, { fetch: linkedinWithImages() });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).image, "2026-10-07-x-v1.png");
  assert.deepEqual(result.calls.map(call => call.init.method), ["POST", "PUT", "POST"]);
  assert.deepEqual(result.calls[1].init.body, png);
  assert.deepEqual(JSON.parse(result.calls[2].init.body).content, { media: { id: "urn:li:image:C4E" } });
});

test("a failed image upload posts nothing", async t => {
  const root = await workspace(t);
  await withImage(root);
  const result = await invoke(root, { fetch: linkedinWithImages({ upload: 403 }) });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).status, "not_posted");
  assert.equal(result.calls.length, 2, "the post itself is never sent");
});

test("never prints the sentinel or the authorization header, on success or failure", async t => {
  const root = await workspace(t);
  for (const fetch of [
    async () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:1" } }),
    async () => new Response('{"message":"bad"}', { status: 400 }),
    async () => { throw new DOMException("timed out", "TimeoutError"); }
  ]) {
    const result = await invoke(root, { fetch });
    assert.doesNotMatch(result.stdout + result.stderr, /oc-sent-v2|cli-test-sentinel|Bearer|authorization/i);
  }
});

test("a missing or plaintext token posts nothing", async t => {
  const root = await workspace(t);
  const fetch = async () => assert.fail("must not call LinkedIn");
  for (const env of [{ LINKEDIN_API_VERSION: version }, { LINKEDIN_API_VERSION: version, LINKEDIN_ACCESS_TOKEN: "AQX-plaintext" }]) {
    const result = await invoke(root, { env, fetch });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).status, "not_posted");
    assert.doesNotMatch(result.stderr, /AQX-plaintext/);
    assert.equal(result.calls.length, 0);
  }
});

test("a missing LinkedIn API version posts nothing and names its store entry", async t => {
  const root = await workspace(t);
  const result = await invoke(root, { env: { LINKEDIN_ACCESS_TOKEN: sentinel }, fetch: async () => assert.fail("must not call LinkedIn") });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).status, "not_posted");
  assert.match(JSON.parse(result.stderr).message, /LINKEDIN_API_VERSION/);
  assert.equal(result.calls.length, 0);
});

test("an expired or missing account posts nothing and asks for re-auth", async t => {
  const fetch = async () => assert.fail("must not call LinkedIn");
  for (const account of [{ personUrn: "urn:li:person:abc", expiresAt: "2026-10-01T00:00:00Z" }, null]) {
    const root = await workspace(t, { account });
    const result = await invoke(root, { fetch });
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stderr).message, /renova o token/);
    assert.equal(result.calls.length, 0);
  }
});

test("refuses anything but exactly one draft argument", async t => {
  const root = await workspace(t);
  const fetch = async () => assert.fail("must not call LinkedIn");
  for (const argv of [[], ["content/drafts/2026-10-07-x-v2.md", "--extra"], ["../outside.md"]]) {
    const result = await invoke(root, { argv, fetch });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).status, "not_posted");
  }
});

test("a timeout is reported as unknown, so the agent asks Gabriel to check the profile", async t => {
  const root = await workspace(t);
  const result = await invoke(root, { fetch: async () => { throw new DOMException("timed out", "TimeoutError"); } });
  assert.equal(result.code, 1);
  assert.deepEqual(Object.keys(JSON.parse(result.stderr)), ["status", "message"]);
  assert.equal(JSON.parse(result.stderr).status, "unknown");
  assert.equal(result.calls.length, 1);
});
