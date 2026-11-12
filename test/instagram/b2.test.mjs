import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AUTHORIZE_URL, DOWNLOAD_TTL_SECONDS, authorizeStorage, createDownloadUrl, deleteSlide, readB2Config, uploadSlide } from "../../instagram/publisher/lib/b2.mjs";

const b2 = { bucketId: "0123456789abcdef01234567", bucketName: "brand-instagram" };
const env = { INSTAGRAM_B2_BUCKET_ID: b2.bucketId, INSTAGRAM_B2_BUCKET_NAME: b2.bucketName };
const token = "oc-sent-v2.b2-test.end";
const session = { ...b2, apiUrl: "https://api005.backblazeb2.com", downloadUrl: "https://f005.backblazeb2.com", token: "temporary-account-token" };
const target = { bucketId: b2.bucketId, uploadUrl: "https://pod-000-1005-03.backblaze.com/b2api/v4/b2_upload_file?cvt=test", authorizationToken: "temporary-upload-token" };
const json = data => new Response(JSON.stringify(data));
const auth = () => ({ authorizationToken: session.token, apiInfo: { storageApi: {
  apiUrl: session.apiUrl, downloadUrl: session.downloadUrl,
  allowed: { buckets: [{ id: b2.bucketId, name: b2.bucketName }], capabilities: ["writeFiles", "listFiles", "deleteFiles", "shareFiles"], namePrefix: null }
} } });

test("B2 coordinates name the dedicated bucket and reject missing or malformed values", () => {
  assert.deepEqual(readB2Config(env), b2);
  for (const [name, value] of [["INSTAGRAM_B2_BUCKET_ID", undefined], ["INSTAGRAM_B2_BUCKET_ID", "wrong"],
    ["INSTAGRAM_B2_BUCKET_NAME", "a/b"], ["INSTAGRAM_B2_BUCKET_NAME", "short"]]) {
    assert.throws(() => readB2Config({ ...env, [name]: value }), new RegExp(name));
  }
});

test("authorization sends only the protected header sentinel and accepts a key scoped to this bucket", async () => {
  const calls = [];
  const result = await authorizeStorage({ b2, token, fetch: async (url, init) => { calls.push({ url, init }); return json(auth()); } });
  assert.deepEqual(result, session);
  assert.equal(calls[0].url, AUTHORIZE_URL);
  assert.deepEqual(calls[0].init.headers, { authorization: token });
  assert.equal(calls[0].init.redirect, "error");
});

test("authorization refuses unrestricted keys, other buckets, missing capabilities and incompatible prefixes", async () => {
  for (const restriction of [
    { buckets: null }, { buckets: [] }, { buckets: [{ id: "other", name: b2.bucketName }] },
    { buckets: [{ id: b2.bucketId, name: "other-app" }] },
    { buckets: [{ id: b2.bucketId, name: b2.bucketName }, { id: "other", name: "other-app" }] },
    { capabilities: ["writeFiles", "listFiles"] }, { capabilities: ["writeFiles", "listFiles", "deleteFiles"] },
    { capabilities: "writeFileslistFilesdeleteFilesshareFiles" }, { namePrefix: "other/" }
  ]) {
    const data = auth();
    Object.assign(data.apiInfo.storageApi.allowed, restriction);
    await assert.rejects(authorizeStorage({ b2, token, fetch: async () => json(data) }), /restricted to the configured bucket/);
  }
});

test("credentials are never forwarded to unsafe API or download destinations", async () => {
  for (const [field, value] of [
    ["apiUrl", "https://api005.backblazeb2.com.evil.example"], ["apiUrl", "http://api005.backblazeb2.com"],
    ["apiUrl", "https://user:pass@api005.backblazeb2.com"], ["apiUrl", "https://api005.backblazeb2.com:8443"],
    ["apiUrl", "https://api005.backblazeb2.com/extra"], ["downloadUrl", "https://evil.example"],
    ["downloadUrl", "https://f005.backblazeb2.com/?token=secret"]
  ]) {
    const data = auth(); data.apiInfo.storageApi[field] = value;
    let calls = 0;
    await assert.rejects(authorizeStorage({ b2, token, fetch: async () => { calls++; return json(data); } }), /unsafe .* endpoint/);
    assert.equal(calls, 1);
  }
});

test("uploads JPEG bytes with a checksum and fixed length, returning the exact version id", async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff]);
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return json(calls.length === 1 ? target : { bucketId: b2.bucketId, fileName: "random-1.jpg", fileId: "4_version" }); };
  assert.deepEqual(await uploadSlide({ fetch, session, key: "random-1.jpg", bytes }), { fileId: "4_version" });
  assert.equal(calls[0].init.headers.authorization, session.token);
  assert.equal(calls[1].init.headers.authorization, target.authorizationToken);
  assert.equal(calls[1].init.headers["content-type"], "image/jpeg");
  assert.equal(calls[1].init.headers["content-length"], String(bytes.length));
  assert.equal(calls[1].init.headers["x-bz-content-sha1"], createHash("sha1").update(bytes).digest("hex"));
  assert.equal(calls[1].init.body, bytes);
  assert.ok(calls.every(call => call.init.redirect === "error"));
});

test("private download access lasts one hour and is restricted to this random image key", async () => {
  const calls = [];
  const token = "temporary-download-token+/=";
  const url = await createDownloadUrl({ session, key: "random.jpg", fetch: async (url, init) => {
    calls.push({ url, init }); return json({ bucketId: b2.bucketId, fileNamePrefix: "random.jpg", authorizationToken: token });
  } });
  assert.equal(DOWNLOAD_TTL_SECONDS, 3600);
  assert.ok(calls[0].url.endsWith("/b2_get_download_authorization"));
  assert.deepEqual(JSON.parse(calls[0].init.body), { bucketId: b2.bucketId, fileNamePrefix: "random.jpg", validDurationInSeconds: 3600 });
  const download = new URL(url);
  assert.equal(download.origin, session.downloadUrl);
  assert.equal(download.pathname, "/file/brand-instagram/random.jpg");
  assert.equal(download.searchParams.get("Authorization"), token);
  assert.equal(calls[0].init.redirect, "error");
});

test("download authorization for a different bucket or prefix is refused", async () => {
  for (const change of [{ bucketId: "other" }, { fileNamePrefix: "" }, { fileNamePrefix: "random.jpg-extra" }, { authorizationToken: "bad\nheader" }]) {
    await assert.rejects(createDownloadUrl({ session, key: "random.jpg", fetch: async () => json({
      bucketId: b2.bucketId, fileNamePrefix: "random.jpg", authorizationToken: "temporary-download-token", ...change
    }) }));
  }
});

test("unsafe upload destinations, credentials and bucket mismatches fail before sending bytes", async () => {
  for (const change of [
    { uploadUrl: "https://pod-000-1005-03.backblaze.com.evil.example/b2api/v4/b2_upload_file" },
    { uploadUrl: "http://pod-000-1005-03.backblaze.com/b2api/v4/b2_upload_file" },
    { uploadUrl: "https://pod-000-1005-03.backblaze.com/reflect" }, { bucketId: "other" },
    { authorizationToken: "token\r\nheader: value" }
  ]) {
    let calls = 0;
    await assert.rejects(uploadSlide({ session, key: "random.jpg", bytes: Buffer.from("x"), fetch: async () => {
      calls++; return json({ ...target, ...change });
    } }));
    assert.equal(calls, 1);
  }
});

test("provider error bodies and network exception details never become publisher errors", async () => {
  for (const fetch of [async () => new Response('secret-token-reflected', { status: 401 }),
    async () => { throw new Error("secret-token-reflected"); }, async () => new Response("secret-token-reflected")]) {
    await assert.rejects(authorizeStorage({ fetch, b2, token }), error => !error.message.includes("secret-token-reflected"));
  }
});

test("cleanup deletes the exact known version without listing other project files", async () => {
  const calls = [];
  assert.equal(await deleteSlide({ session, key: "random.jpg", fileId: "4_version", fetch: async (url, init) => {
    calls.push({ url, init }); return json({});
  } }), true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/b2_delete_file_version"));
  assert.deepEqual(JSON.parse(calls[0].init.body), { fileName: "random.jpg", fileId: "4_version" });
});

test("a lost upload response triggers exact-key version cleanup, preserving other names", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return json(url.endsWith("/b2_list_file_versions") ? { files: [
      { fileName: "random.jpg", fileId: "4_v1" }, { fileName: "random.jpg", fileId: "4_v2" },
      { fileName: "random.jpg-unrelated", fileId: "4_other" }
    ], nextFileName: null, nextFileId: null } : {});
  };
  assert.equal(await deleteSlide({ fetch, session, key: "random.jpg" }), true);
  assert.equal(calls[0].body.prefix, "random.jpg");
  assert.deepEqual(calls.slice(1).map(call => call.body.fileId), ["4_v1", "4_v2"]);
});

test("cleanup failures are reported without throwing or skipping remaining known versions", async () => {
  assert.equal(await deleteSlide({ session, key: "random.jpg", fileId: "4_v1", fetch: async () => new Response(null, { status: 500 }) }), false);
  let deleted = 0;
  assert.equal(await deleteSlide({ session, key: "random.jpg", fetch: async url => {
    if (url.endsWith("/b2_list_file_versions")) return json({ files: [{ fileName: "random.jpg", fileId: "4_v1" }, { fileName: "random.jpg", fileId: "4_v2" }] });
    deleted++; return deleted === 1 ? new Response(null, { status: 500 }) : json({});
  } }), false);
  assert.equal(deleted, 2);
  assert.equal(await deleteSlide({ session, key: "random.jpg", fetch: async () => json({ files: [], nextFileName: "more" }) }), false);
});
