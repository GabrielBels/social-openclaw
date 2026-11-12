import assert from "node:assert/strict";
import test from "node:test";
import {
  IMAGES_URL, POSTS_URL, PublishError, buildPostRequest, postUrl, publishPost, readAccount, readApiVersion, requiredProtectedSecret,
  uploadImage
} from "../../linkedin/publisher/lib/linkedin-post.mjs";

const sentinel = "oc-sent-v2.test-sentinel";
const personUrn = "urn:li:person:AbC123_-x";
const version = "202512";

function response(status, { headers = {}, body = "" } = {}) {
  return new Response(status === 204 ? null : body, { status, headers });
}

function fetchReturning(result) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (result instanceof Error) throw result;
    return result;
  };
  return { fetch, calls };
}

function networkError(code) {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
}

test("the LinkedIn-Version is the store's value, as YYYYMM", () => {
  assert.equal(readApiVersion(` ${version}\n`), version);
  assert.throws(() => readApiVersion(undefined), /LINKEDIN_API_VERSION is not in the OpenClaw store/);
  for (const bad of ["2026-09", "latest", "20260", "202609\r\nx-evil: 1"]) {
    assert.throws(() => readApiVersion(bad), /must be a LinkedIn API version/, bad);
  }
});

test("builds the Posts API request with the stored version and an escaped commentary", () => {
  const { url, init } = buildPostRequest({ token: sentinel, personUrn, text: "Hello (world) #AI", version });
  assert.equal(url, POSTS_URL);
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, {
    authorization: `Bearer ${sentinel}`,
    "linkedin-version": version,
    "x-restli-protocol-version": "2.0.0",
    "content-type": "application/json"
  });
  assert.deepEqual(JSON.parse(init.body), {
    author: personUrn,
    commentary: "Hello \\(world\\) \\#AI",
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false
  });
});

test("builds the post with the uploaded image when there is one", () => {
  const { init } = buildPostRequest({ token: sentinel, personUrn, text: "Hi", version, imageUrn: "urn:li:image:C4E10AQ" });
  assert.deepEqual(JSON.parse(init.body).content, { media: { id: "urn:li:image:C4E10AQ" } });
});

const uploadUrl = "https://www.linkedin.com/dms-uploads/C4E10AQ/uploaded-image/0?ca=vector_feedshare&cn=uploads&sync=0&v=beta&ut=abc";

function imageFetch({ registration = { status: 200, body: { value: { uploadUrl, image: "urn:li:image:C4E10AQ" } } }, upload = 201 } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === IMAGES_URL) return new Response(JSON.stringify(registration.body), { status: registration.status });
    return new Response(null, { status: upload });
  };
  return { fetch, calls };
}

test("uploads an image: registers it for the member, then sends the bytes with the token to LinkedIn's upload URL", async () => {
  const { fetch, calls } = imageFetch();
  const bytes = Buffer.from("png bytes");
  assert.equal(await uploadImage({ fetch, token: sentinel, personUrn, version, bytes }), "urn:li:image:C4E10AQ");
  assert.equal(calls[0].url, IMAGES_URL);
  assert.deepEqual(JSON.parse(calls[0].init.body), { initializeUploadRequest: { owner: personUrn } });
  assert.equal(calls[0].init.headers["linkedin-version"], version);
  assert.equal(calls[1].url, uploadUrl);
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(calls[1].init.headers.authorization, `Bearer ${sentinel}`);
  assert.equal(calls[1].init.body, bytes);
});

test("never sends the token to an upload URL outside https://www.linkedin.com/dms-uploads/", async () => {
  for (const bad of ["https://evil.example/dms-uploads/x", "http://www.linkedin.com/dms-uploads/x", "https://www.linkedin.com/other/x", "not a url"]) {
    const { fetch, calls } = imageFetch({ registration: { status: 200, body: { value: { uploadUrl: bad, image: "urn:li:image:C4E10AQ" } } } });
    await assert.rejects(uploadImage({ fetch, token: sentinel, personUrn, version, bytes: Buffer.from("x") }), error => {
      assert.ok(error instanceof PublishError);
      assert.equal(error.outcome, "not_posted");
      assert.match(error.message, /no valid upload URL/);
      return true;
    });
    assert.equal(calls.length, 1, bad);
  }
});

test("a failed image registration or upload posts nothing and never echoes the token", async () => {
  for (const [options, message] of [
    [{ registration: { status: 403, body: { message: "x" } } }, /registering the image was refused \(HTTP 403\).*www\.linkedin\.com/],
    [{ registration: { status: 422, body: { message: "Invalid owner" } } }, /registering the image failed with HTTP 422: Invalid owner/],
    [{ upload: 403 }, /uploading the image was refused \(HTTP 403\)/],
    [{ upload: 500 }, /uploading the image failed with HTTP 500/]
  ]) {
    const { fetch } = imageFetch(options);
    await assert.rejects(uploadImage({ fetch, token: sentinel, personUrn, version, bytes: Buffer.from("x") }), error => {
      assert.equal(error.outcome, "not_posted");
      assert.match(error.message, message);
      assert.match(error.message, /Nothing was posted/);
      assert.doesNotMatch(error.message, /oc-sent-v2|Bearer/);
      return true;
    });
  }
});

test("builds the post URL from the x-restli-id URN", () => {
  assert.equal(postUrl("urn:li:share:7123"), "https://www.linkedin.com/feed/update/urn:li:share:7123/");
});

test("requires the token to be a protected sentinel", () => {
  assert.equal(requiredProtectedSecret("T", { T: sentinel }), sentinel);
  assert.throws(() => requiredProtectedSecret("T", {}), /unavailable: T/);
  assert.throws(() => requiredProtectedSecret("T", { T: "AQX-plaintext-token" }), /must remain a protected/);
});

test("refusing a plaintext token never echoes it", () => {
  try {
    requiredProtectedSecret("T", { T: "AQX-plaintext-token" });
    assert.fail("expected a refusal");
  } catch (error) {
    assert.doesNotMatch(error.message, /AQX-plaintext-token/);
  }
});

test("reads a valid account and refuses an expired, malformed or missing one", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  assert.deepEqual(readAccount({ personUrn, expiresAt: "2026-12-01T00:00:00Z" }, now), { personUrn, expiresAt: "2026-12-01T00:00:00Z" });
  assert.throws(() => readAccount({ personUrn, expiresAt: "2026-10-07T11:59:59Z" }, now), /expired; renew it \(linkedin\/scripts\/auth\.mjs url in WSL, then "renew the token"\)/);
  assert.throws(() => readAccount({ personUrn: "urn:li:organization:1", expiresAt: "2026-12-01T00:00:00Z" }, now), /personUrn/);
  assert.throws(() => readAccount({ personUrn, expiresAt: "soon" }, now), /expiresAt/);
  assert.throws(() => readAccount(undefined, now), /personUrn/);
});

test("201 with x-restli-id is published with its URL", async () => {
  const { fetch, calls } = fetchReturning(response(201, { headers: { "x-restli-id": "urn:li:share:7380000000000000000" } }));
  const result = await publishPost({ fetch, token: sentinel, personUrn, text: "Hi", version });
  assert.deepEqual(result, {
    status: "published",
    urn: "urn:li:share:7380000000000000000",
    url: "https://www.linkedin.com/feed/update/urn:li:share:7380000000000000000/"
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

const failures = [
  { name: "401", result: response(401, { body: '{"message":"Expired"}' }), outcome: "not_posted", message: /HTTP 401.*renew the token/ },
  { name: "403", result: response(403, { body: '{"message":"Not enough permissions"}' }), outcome: "not_posted", message: /HTTP 403.*w_member_social/ },
  { name: "422", result: response(422, { body: '{"message":"Invalid commentary","status":422}' }), outcome: "not_posted", message: /HTTP 422: Invalid commentary\. Nothing was posted/ },
  { name: "426", result: response(426, { body: '{"code":"NONEXISTENT_VERSION","message":"Requested version 20250101 is not active"}' }), outcome: "not_posted", message: /retired API version 202512.*Set LINKEDIN_API_VERSION/ },
  { name: "429", result: response(429, { body: '{"message":"Too many requests"}' }), outcome: "not_posted", message: /HTTP 429: Too many requests/ },
  { name: "500", result: response(500, { body: "upstream\nfailure" }), outcome: "unknown", message: /HTTP 500: upstream failure\. The post may exist/ },
  { name: "201 without id", result: response(201), outcome: "unknown", message: /without a post id/ },
  { name: "timeout", result: Object.assign(new DOMException("timed out", "TimeoutError")), outcome: "unknown", message: /\(timeout\).*check the profile/ },
  { name: "reset after sending", result: networkError("ECONNRESET"), outcome: "unknown", message: /\(network error\).*check the profile/ },
  { name: "connection refused", result: networkError("ECONNREFUSED"), outcome: "not_posted", message: /ECONNREFUSED\)\. Nothing was sent/ }
];

for (const { name, result, outcome, message } of failures) {
  test(`${name} is reported as ${outcome} without a retry`, async () => {
    const { fetch, calls } = fetchReturning(result);
    await assert.rejects(publishPost({ fetch, token: sentinel, personUrn, text: "Hi", version }), error => {
      assert.ok(error instanceof PublishError);
      assert.equal(error.outcome, outcome);
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /oc-sent-v2|Bearer/);
      return true;
    });
    assert.equal(calls.length, 1);
  });
}
