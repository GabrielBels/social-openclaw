import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "../../instagram/publisher/publish.mjs";

const igSentinel = "oc-sent-v2.ig-cli-sentinel";
const b2Sentinel = "oc-sent-v2.b2-cli-sentinel";
const bucketId = "0123456789abcdef01234567";
const env = {
  INSTAGRAM_ACCESS_TOKEN: igSentinel, INSTAGRAM_B2_BASIC_AUTH: b2Sentinel, INSTAGRAM_API_VERSION: "v25.0", INSTAGRAM_USERNAME: "minha_marca",
  INSTAGRAM_B2_BUCKET_ID: bucketId, INSTAGRAM_B2_BUCKET_NAME: "ig-media"
};
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7]);
const uuid = n => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;
const draft = "content/drafts/2026-10-12-prazo-recurso-v2.md";

function sink() {
  const chunks = [];
  return { write: chunk => chunks.push(chunk), text: () => chunks.join("") };
}

async function workspace(t, { slides = ["2026-10-12-prazo-recurso-v1-1.jpg | Capa", "2026-10-12-prazo-recurso-v2-2.jpg | Regra"] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "instagram-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "content", "drafts"), { recursive: true });
  await mkdir(path.join(root, "images"));
  await writeFile(path.join(root, draft), "Contestação tem prazo (e ela conta da nota). #pedidos\n");
  await writeFile(path.join(root, "content", "drafts", "2026-10-12-prazo-recurso-v2.slides.txt"), slides.join("\n"));
  await writeFile(path.join(root, "images", `2026-10-12-prazo-recurso-v1-1---${uuid(1)}.jpg`), jpeg);
  await writeFile(path.join(root, "images", `2026-10-12-prazo-recurso-v2-2---${uuid(2)}.jpg`), jpeg);
  return root;
}

// Fake Instagram and B2 services retain uploaded versions to exercise failure cleanup.
function services({ username = "minha_marca", status = "FINISHED", publish = () => json(200, { id: "179001" }), upload = 200 } = {}) {
  let container = 0;
  let version = 0;
  const files = new Map();
  return async (url, init) => {
    const { pathname, hostname } = new URL(url);
    if (pathname.endsWith("/b2_authorize_account")) return json(200, {
      authorizationToken: "temporary-account-token", apiInfo: { storageApi: {
        apiUrl: "https://api005.backblazeb2.com", downloadUrl: "https://f005.backblazeb2.com",
        allowed: { buckets: [{ id: bucketId, name: "ig-media" }], capabilities: ["writeFiles", "listFiles", "deleteFiles", "shareFiles"], namePrefix: null }
      } }
    });
    if (pathname.endsWith("/b2_get_upload_url")) return json(200, {
      bucketId, uploadUrl: "https://pod-000-1005-03.backblaze.com/b2api/v4/b2_upload_file", authorizationToken: "temporary-upload-token"
    });
    if (pathname.endsWith("/b2_get_download_authorization")) return json(200, {
      bucketId, fileNamePrefix: JSON.parse(init.body).fileNamePrefix, authorizationToken: "temporary-download-token"
    });
    if (hostname === "pod-000-1005-03.backblaze.com") {
      const fileName = decodeURIComponent(init.headers["x-bz-file-name"]);
      const fileId = `4_version_${++version}`;
      files.set(fileName, fileId);
      if (typeof upload === "function") return upload({ fileName, fileId, bucketId, version });
      return json(upload, { bucketId, fileName, fileId });
    }
    if (pathname.endsWith("/b2_list_file_versions")) {
      const { prefix } = JSON.parse(init.body);
      return json(200, { files: [...files].filter(([name]) => name.startsWith(prefix)).map(([fileName, fileId]) => ({ fileName, fileId })) });
    }
    if (pathname.endsWith("/b2_delete_file_version")) { files.delete(JSON.parse(init.body).fileName); return json(200, {}); }
    if (pathname.endsWith("/me")) return json(200, { user_id: "17841400000000001", username });
    if (pathname.endsWith("/media")) return json(200, { id: `18000${(container += 1)}` });
    if (pathname.endsWith("/media_publish")) return publish();
    if (url.includes("fields=status_code")) return json(200, { status_code: status });
    if (url.includes("fields=permalink")) return json(200, { permalink: "https://www.instagram.com/p/AbC123/" });
    throw new Error(`unexpected request ${url}`);
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status });
}

async function invoke(root, { argv = [draft], fetch = services(), environment = env } = {}) {
  const stdout = sink();
  const stderr = sink();
  const calls = [];
  const recordingFetch = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body, headers: init?.headers });
    return fetch(url, init);
  };
  const code = await run({
    argv, env: environment, fetch: recordingFetch, sleep: async () => {}, newPrefix: () => "f00d",
    workspaceRoot: root, imagesDir: path.join(root, "images"), stdout, stderr
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), calls };
}

test("rerunning an already published draft makes no network request", async t => {
  const root = await workspace(t);
  const first = await invoke(root);
  assert.equal(first.code, 0, first.stderr);
  const duplicate = await invoke(root);
  assert.equal(duplicate.code, 1);
  assert.equal(JSON.parse(duplicate.stderr).status, "not_posted");
  assert.match(duplicate.stderr, /already published/);
  assert.equal(duplicate.calls.length, 0);
});

test("a revision retains the weekly execution identity and cannot publish it twice", async t => {
  const root = await workspace(t);
  const metadata = { executionId: "2026-10-12-1", format: "carousel-educational" };
  await writeFile(path.join(root, draft.replace(/\.md$/, ".editorial.json")), JSON.stringify(metadata));
  assert.equal((await invoke(root)).code, 0);
  const revised = draft.replace("-v2.md", "-v3.md");
  await writeFile(path.join(root, revised), "Legenda revisada");
  await writeFile(path.join(root, revised.replace(/\.md$/, ".editorial.json")), JSON.stringify(metadata));
  await writeFile(path.join(root, revised.replace(/\.md$/, ".slides.txt")), "2026-10-12-prazo-recurso-v1-1.jpg | Capa");
  const duplicate = await invoke(root, { argv: [revised] });
  assert.equal(duplicate.code, 1);
  assert.equal(duplicate.calls.length, 0);
  assert.match(duplicate.stderr, /already published/);
});

test("a practical carousel publishes on the Friday execution", async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, draft.replace(/\.md$/, ".editorial.json")), JSON.stringify({ executionId: "2026-10-12-3", format: "carousel-practical" }));
  const result = await invoke(root);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "published");
});

test("an unknown editorial format is refused before any Instagram or storage request", async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, draft.replace(/\.md$/, ".editorial.json")), JSON.stringify({ executionId: "2026-10-12-3", format: "story" }));
  const result = await invoke(root);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /editorial format must be one of/);
});

test("a Reel is refused as an unknown format before any Instagram or storage request", async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, draft.replace(/\.md$/, ".editorial.json")), JSON.stringify({ executionId: "2026-10-12-3", format: "reel" }));
  const result = await invoke(root);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /editorial format must be one of/);
});

test("publishes a carousel: uploads each slide, creates its items and the carousel, publishes, then empties the bucket", async t => {
  const root = await workspace(t);
  const result = await invoke(root);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "published", mediaId: "179001", url: "https://www.instagram.com/p/AbC123/", account: "@minha_marca",
    draft, slides: 2, cleanup: "done"
  });
  const steps = result.calls.map(call => `${call.method} ${new URL(call.url).pathname.replace(/^.*\/(v4|v25\.0)\//, "")}`);
  assert.deepEqual(steps, [
    "GET me",
    "GET b2_authorize_account",
    "POST b2_get_upload_url", "POST b2_upload_file", "POST b2_get_download_authorization",
    "POST b2_get_upload_url", "POST b2_upload_file", "POST b2_get_download_authorization",
    "POST 17841400000000001/media", "POST 17841400000000001/media",
    "GET 180001", "GET 180002",
    "POST 17841400000000001/media",
    "GET 180003",
    "POST 17841400000000001/media_publish",
    "POST b2_delete_file_version", "POST b2_delete_file_version",
    "GET 179001"
  ]);
  const created = result.calls.filter(call => call.url.endsWith("/media")).map(call => JSON.parse(call.body));
  assert.deepEqual(created, [
    { image_url: "https://f005.backblazeb2.com/file/ig-media/f00d-2026-10-12-prazo-recurso-v1-1.jpg?Authorization=temporary-download-token", is_carousel_item: true, alt_text: "Capa" },
    { image_url: "https://f005.backblazeb2.com/file/ig-media/f00d-2026-10-12-prazo-recurso-v2-2.jpg?Authorization=temporary-download-token", is_carousel_item: true, alt_text: "Regra" },
    { media_type: "CAROUSEL", children: "180001,180002", caption: "Contestação tem prazo (e ela conta da nota). #pedidos" }
  ]);
  assert.deepEqual(JSON.parse(result.calls.find(call => call.url.endsWith("/media_publish")).body), { creation_id: "180003" });
  const uploaded = result.calls.find(call => call.url.includes("pod-000-1005-03.backblaze.com"));
  assert.deepEqual(uploaded.body, jpeg);
  assert.equal(uploaded.headers.authorization, "temporary-upload-token");
  assert.equal(result.calls[1].headers.authorization, b2Sentinel);
  assert.equal(result.calls[0].headers.authorization, `Bearer ${igSentinel}`);
});

test("publishes a single image with its caption and alt text on the one container", async t => {
  const root = await workspace(t, { slides: ["2026-10-12-prazo-recurso-v2-2.jpg | Checklist do recurso"] });
  const result = await invoke(root);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).slides, 1);
  const created = result.calls.filter(call => call.url.endsWith("/media")).map(call => JSON.parse(call.body));
  assert.deepEqual(created, [{
    image_url: "https://f005.backblazeb2.com/file/ig-media/f00d-2026-10-12-prazo-recurso-v2-2.jpg?Authorization=temporary-download-token",
    caption: "Contestação tem prazo (e ela conta da nota). #pedidos", alt_text: "Checklist do recurso"
  }]);
});

test("a token for another account posts nothing and uploads nothing", async t => {
  const root = await workspace(t);
  const result = await invoke(root, { fetch: services({ username: "outra_conta" }) });
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "not_posted", message: "the Instagram token belongs to @outra_conta, not @minha_marca (INSTAGRAM_USERNAME). Nothing was posted."
  });
  assert.equal(result.calls.length, 1);
});

test("a failed upload posts nothing and removes what was uploaded", async t => {
  const root = await workspace(t);
  const result = await invoke(root, { fetch: services({ upload: 500 }) });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).status, "not_posted");
  assert.ok(!result.calls.some(call => call.url.includes("graph.instagram.com") && call.method === "POST"));
  assert.equal(result.calls.filter(call => call.url.endsWith("/b2_delete_file_version")).length, 1);
});

test("a container Instagram could not process posts nothing and the bucket is emptied", async t => {
  const root = await workspace(t);
  const result = await invoke(root, { fetch: services({ status: "ERROR" }) });
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stderr).message, /container status ERROR/);
  assert.ok(!result.calls.some(call => call.url.endsWith("/media_publish")));
  assert.equal(result.calls.filter(call => call.url.endsWith("/b2_delete_file_version")).length, 2);
});

test("a publication that timed out is unknown, and the bucket is still emptied", async t => {
  const root = await workspace(t);
  const result = await invoke(root, { fetch: services({ publish: () => { throw new DOMException("timed out", "TimeoutError"); } }) });
  assert.equal(result.code, 1);
  assert.deepEqual(Object.keys(JSON.parse(result.stderr)), ["status", "message"]);
  assert.equal(JSON.parse(result.stderr).status, "unknown");
  assert.equal(result.calls.filter(call => call.url.endsWith("/b2_delete_file_version")).length, 2);
});

test("a slide left in the bucket is reported, without changing the outcome", async t => {
  const root = await workspace(t);
  const base = services();
  const fetch = async (url, init) => url.endsWith("/b2_delete_file_version") ? new Response(null, { status: 500 }) : base(url, init);
  const result = await invoke(root, { fetch });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).cleanup, "failed");
});

test("never prints a sentinel or an authorization header, on success or failure", async t => {
  const root = await workspace(t);
  for (const fetch of [services(), services({ status: "ERROR" }), async () => { throw new DOMException("timed out", "TimeoutError"); }]) {
    const result = await invoke(root, { fetch });
    assert.doesNotMatch(result.stdout + result.stderr, /oc-sent-v2|cli-sentinel|Bearer |Basic |temporary-account-token|temporary-upload-token|temporary-download-token/i);
  }
});

test("a missing or plaintext secret, or a missing store entry, posts nothing and calls nobody", async t => {
  const root = await workspace(t);
  const fetch = async () => assert.fail("must not call anyone");
  for (const [environment, message] of [
    [{ ...env, INSTAGRAM_ACCESS_TOKEN: undefined }, /INSTAGRAM_ACCESS_TOKEN/],
    [{ ...env, INSTAGRAM_ACCESS_TOKEN: "IGAAplaintexttoken" }, /must remain a protected OpenClaw secret/],
    [{ ...env, INSTAGRAM_B2_BASIC_AUTH: "b2-plaintext" }, /INSTAGRAM_B2_BASIC_AUTH must remain/],
    [{ ...env, INSTAGRAM_API_VERSION: undefined }, /INSTAGRAM_API_VERSION/],
    [{ ...env, INSTAGRAM_USERNAME: undefined }, /INSTAGRAM_USERNAME/],
    [{ ...env, INSTAGRAM_B2_BUCKET_NAME: undefined }, /INSTAGRAM_B2_BUCKET_NAME/]
  ]) {
    const result = await invoke(root, { environment, fetch });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).status, "not_posted");
    assert.match(JSON.parse(result.stderr).message, message);
    assert.doesNotMatch(result.stderr, /IGAAplaintexttoken|b2-plaintext/);
    assert.equal(result.calls.length, 0);
  }
});

test("a lost second upload response cleans both versions and never publishes", async t => {
  const root = await workspace(t);
  const result = await invoke(root, { fetch: services({ upload: ({ fileName, fileId, bucketId, version }) => {
    if (version === 2) throw new DOMException("lost response with temporary-upload-token", "TimeoutError");
    return json(200, { fileName, fileId, bucketId });
  } }) });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).status, "not_posted");
  assert.ok(!result.calls.some(call => call.url.endsWith("/media_publish")));
  const deleted = result.calls.filter(call => call.url.endsWith("/b2_delete_file_version")).map(call => JSON.parse(call.body).fileId);
  assert.deepEqual(deleted, ["4_version_1", "4_version_2"]);
  assert.doesNotMatch(result.stderr, /temporary-upload-token/);
});

test("failed temporary download authorization cleans the uploaded version without creating Instagram media", async t => {
  const root = await workspace(t);
  const base = services();
  const result = await invoke(root, { fetch: async (url, init) => url.endsWith("/b2_get_download_authorization")
    ? json(403, { message: "temporary-download-token" }) : base(url, init) });
  assert.equal(result.code, 1);
  assert.ok(!result.calls.some(call => call.url.endsWith("/media")));
  assert.equal(result.calls.filter(call => call.url.endsWith("/b2_delete_file_version")).length, 1);
  assert.doesNotMatch(result.stderr, /temporary-download-token/);
});

test("reflected private image URLs and bare download tokens are redacted before Graph diagnostics are truncated", async t => {
  const root = await workspace(t);
  const base = services();
  const result = await invoke(root, { fetch: async (url, init) => {
    if (url.endsWith("/media")) {
      const imageUrl = JSON.parse(init.body).image_url;
      return json(400, { error: { message: `${"x".repeat(120)} URL ${imageUrl}; token temporary-download-token` } });
    }
    return base(url, init);
  } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /private image access|redacted/);
  assert.doesNotMatch(result.stderr, /temporary-download|oc-sent-v2/);
  assert.equal(result.calls.filter(call => call.url.endsWith("/b2_delete_file_version")).length, 2);
});

test("refuses anything but exactly one draft argument, and a draft without its slides", async t => {
  const root = await workspace(t);
  const fetch = async () => assert.fail("must not call anyone");
  for (const argv of [[], [draft, "--extra"], ["../outside.md"], ["content/drafts/2026-10-12-prazo-recurso-v2.slides.txt"]]) {
    const result = await invoke(root, { argv, fetch });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).status, "not_posted");
  }
  await rm(path.join(root, "images", `2026-10-12-prazo-recurso-v2-2---${uuid(2)}.jpg`));
  const missing = await invoke(root, { fetch });
  assert.match(JSON.parse(missing.stderr).message, /slide 2 \(2026-10-12-prazo-recurso-v2-2\.jpg\) is not among the generated images/);
});

test("a slide drawn from SVG beside the draft is the one uploaded", async t => {
  const root = await workspace(t);
  const drawn = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 9, 9, 9]);
  await rm(path.join(root, "images", `2026-10-12-prazo-recurso-v2-2---${uuid(2)}.jpg`));
  await writeFile(path.join(root, "content", "drafts", "2026-10-12-prazo-recurso-v2-2.jpg"), drawn);
  const result = await invoke(root);
  assert.equal(result.code, 0, result.stderr);
  const uploads = result.calls.filter(call => new URL(call.url).hostname === "pod-000-1005-03.backblaze.com").map(call => Buffer.from(call.body));
  assert.deepEqual(uploads, [jpeg, drawn]);
});
