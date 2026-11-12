import assert from "node:assert/strict";
import test from "node:test";
import {
  GRAPH_URL, PublishError, createContainer, fetchAccount, fetchPermalink, publishContainer, readApiVersion, readUsername,
  requiredProtectedSecret, waitForContainer
} from "../../instagram/publisher/lib/instagram-media.mjs";

const sentinel = "oc-sent-v2.ig-test-sentinel";
const version = "v25.0";
const userId = "17841400000000001";

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function scripted(...answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetch, calls };
}

const graphError = (status, code, message = "boom") => json(status, { error: { message, type: "OAuthException", code } });
const networkError = code => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

test("the token must stay a protected secret, and the version and username come from the store", () => {
  assert.equal(requiredProtectedSecret("INSTAGRAM_ACCESS_TOKEN", { INSTAGRAM_ACCESS_TOKEN: sentinel }), sentinel);
  assert.throws(() => requiredProtectedSecret("INSTAGRAM_ACCESS_TOKEN", {}), /unavailable: INSTAGRAM_ACCESS_TOKEN/);
  assert.throws(() => requiredProtectedSecret("INSTAGRAM_ACCESS_TOKEN", { INSTAGRAM_ACCESS_TOKEN: "IGAAplaintext" }), /must remain a protected/);
  assert.equal(readApiVersion(" v25.0\n"), "v25.0");
  assert.throws(() => readApiVersion(undefined), /INSTAGRAM_API_VERSION is not in the OpenClaw store/);
  for (const bad of ["25.0", "v25", "latest", "v25.0/../x"]) assert.throws(() => readApiVersion(bad), /must be a Graph API version/, bad);
  assert.equal(readUsername("@minha_marca"), "minha_marca");
  for (const bad of [undefined, "", "integri dens", "a".repeat(31)]) assert.throws(() => readUsername(bad), /INSTAGRAM_USERNAME/, String(bad));
});

test("reads the account behind the token with the sentinel as a bearer", async () => {
  const { fetch, calls } = scripted(json(200, { user_id: userId, username: "minha_marca", id: "999" }));
  assert.deepEqual(await fetchAccount({ fetch, token: sentinel, version }), { userId, username: "minha_marca" });
  assert.equal(calls[0].url, `${GRAPH_URL}/${version}/me?fields=user_id,username`);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${sentinel}`);
});

test("an expired token, a missing permission or a rate limit posts nothing and says what to do", async () => {
  for (const [answer, message] of [
    [graphError(400, 190, "Error validating access token"), /expired or was revoked\. Send "renova o token"/],
    [graphError(403, 10, "no permission"), /instagram_business_content_publish/],
    [graphError(400, 4, "too many calls"), /rate or publishing limit/],
    [graphError(400, 100, "Invalid parameter"), /failed \(HTTP 400, code 100\): Invalid parameter\. Nothing was posted/]
  ]) {
    const { fetch } = scripted(answer);
    await assert.rejects(fetchAccount({ fetch, token: sentinel, version }), error => message.test(error.message) && error.outcome === "not_posted");
  }
});

test("creates a container with the given fields as JSON", async () => {
  const { fetch, calls } = scripted(json(200, { id: "180001" }));
  const fields = { image_url: "https://pub-abc.r2.dev/k-1.jpg", is_carousel_item: true, alt_text: "Capa" };
  assert.equal(await createContainer({ fetch, token: sentinel, version, userId, fields }), "180001");
  assert.equal(calls[0].url, `${GRAPH_URL}/${version}/${userId}/media`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), fields);
});

test("a container without an id, or a timeout before publishing, posts nothing", async () => {
  await assert.rejects(createContainer({ fetch: scripted(json(200, {})).fetch, token: sentinel, version, userId, fields: {} }), /without a valid id/);
  await assert.rejects(createContainer({ fetch: scripted(new DOMException("t", "TimeoutError")).fetch, token: sentinel, version, userId, fields: {} }),
    error => /did not complete \(timeout\)\. Nothing was posted/.test(error.message) && error.outcome === "not_posted");
});

test("waits while the container is in progress and stops once it is finished", async () => {
  const sleeps = [];
  const { fetch, calls } = scripted(json(200, { status_code: "IN_PROGRESS" }), json(200, { status_code: "IN_PROGRESS" }), json(200, { status_code: "FINISHED" }));
  await waitForContainer({ fetch, token: sentinel, version, containerId: "180001", sleep: async ms => sleeps.push(ms), intervalMs: 5 });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, `${GRAPH_URL}/${version}/180001?fields=status_code`);
  assert.deepEqual(sleeps, [5, 5]);
});

test("a container in error, expired, unknown or never finished posts nothing", async () => {
  for (const [answers, message] of [
    [[json(200, { status_code: "ERROR" })], /container status ERROR/],
    [[json(200, { status_code: "EXPIRED" })], /container status EXPIRED/],
    [[json(200, { status_code: "PUBLISHED" })], /unexpected container status \(PUBLISHED\)/],
    [[json(200, { status_code: "IN_PROGRESS" }), json(200, { status_code: "IN_PROGRESS" })], /did not finish processing/]
  ]) {
    const { fetch } = scripted(...answers);
    await assert.rejects(waitForContainer({ fetch, token: sentinel, version, containerId: "1", sleep: async () => {}, attempts: 2 }),
      error => message.test(error.message) && error.outcome === "not_posted");
  }
});

test("publishes the container and returns the media id", async () => {
  const { fetch, calls } = scripted(json(200, { id: "179000000000001" }));
  assert.equal(await publishContainer({ fetch, token: sentinel, version, userId, creationId: "180009" }), "179000000000001");
  assert.equal(calls[0].url, `${GRAPH_URL}/${version}/${userId}/media_publish`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { creation_id: "180009" });
});

test("a publication that may have happened is unknown; one refused or never sent posted nothing", async () => {
  for (const [answer, outcome, message] of [
    [new DOMException("timed out", "TimeoutError"), "unknown", /may already exist/],
    [new TypeError("socket hang up"), "unknown", /may already exist/],
    [graphError(500, 2, "Service temporarily unavailable"), "unknown", /HTTP 500 .*may exist anyway/],
    [json(200, {}), "unknown", /without a media id/],
    [networkError("ECONNREFUSED"), "not_posted", /could not reach Instagram \(ECONNREFUSED\)\. Nothing was sent/],
    [graphError(400, 9007, "Media ID is not available"), "not_posted", /Nothing was posted; the draft is unchanged/]
  ]) {
    const { fetch } = scripted(answer);
    await assert.rejects(publishContainer({ fetch, token: sentinel, version, userId, creationId: "1" }),
      error => error instanceof PublishError && error.outcome === outcome && message.test(error.message), String(message));
  }
});

test("returns the post's permalink, or null without failing", async () => {
  const ok = scripted(json(200, { permalink: "https://www.instagram.com/p/AbC123/" }));
  assert.equal(await fetchPermalink({ fetch: ok.fetch, token: sentinel, version, mediaId: "1" }), "https://www.instagram.com/p/AbC123/");
  assert.equal(ok.calls[0].url, `${GRAPH_URL}/${version}/1?fields=permalink`);
  for (const answer of [json(500, {}), json(200, { permalink: "https://evil.example/p/1" }), json(200, {}), new TypeError("fetch failed")]) {
    assert.equal(await fetchPermalink({ fetch: scripted(answer).fetch, token: sentinel, version, mediaId: "1" }), null);
  }
});
