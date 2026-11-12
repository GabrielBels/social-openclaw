// Instagram API with Instagram Login (graph.instagram.com): the account behind the token, media containers, and their
// publication. The token is a protected OpenClaw secret: this code only ever holds its sentinel, and the Gateway egress
// proxy substitutes the value on the way to graph.instagram.com.

export const GRAPH_URL = "https://graph.instagram.com";
export const REQUEST_TIMEOUT_MS = 30000;
// Instagram fetches each image when its container is created; an image container is usually ready at once.
export const STATUS_ATTEMPTS = 20;
export const STATUS_INTERVAL_MS = 3000;

const protectedSentinelPrefix = "oc-sent-v2";
const apiVersionPattern = /^v[1-9][0-9]{0,2}\.0$/;
const usernamePattern = /^[A-Za-z0-9._]{1,30}$/;
const idPattern = /^[0-9]{1,40}$/;
// The request never left this machine, so nothing can have been posted.
const connectionFailureCodes = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
const rateLimitCodes = new Set([4, 9, 17, 32, 613]);

// outcome: "not_posted" (Instagram refused, or nothing was sent) or "unknown" (the post may exist).
export class PublishError extends Error {
  constructor(message, outcome = "not_posted") {
    super(message);
    this.outcome = outcome;
  }
}

// A plaintext value is refused rather than used: the secret must stay a protected OpenClaw secret.
export function requiredProtectedSecret(name, env) {
  const value = env[name];
  if (!value) throw new PublishError(`protected secret is unavailable: ${name}. Nothing was posted.`);
  if (!value.startsWith(protectedSentinelPrefix)) throw new PublishError(`${name} must remain a protected OpenClaw secret. Nothing was posted.`);
  return value;
}

// The Graph API version in each path (vNN.0), an env entry of the OpenClaw store, so a retired version is replaced
// without a code change.
export function readApiVersion(value) {
  const version = String(value ?? "").trim();
  if (!version) throw new PublishError("INSTAGRAM_API_VERSION is not in the OpenClaw store (see docs/operations.md, Setup). Nothing was posted.");
  if (!apiVersionPattern.test(version)) throw new PublishError("INSTAGRAM_API_VERSION must be a Graph API version such as v25.0. Nothing was posted.");
  return version;
}

// The account the token must belong to, an env entry of the OpenClaw store: a token for any other account posts nothing.
export function readUsername(value) {
  const username = String(value ?? "").trim().replace(/^@/, "");
  if (!usernamePattern.test(username)) {
    throw new PublishError("INSTAGRAM_USERNAME must be the Instagram account's username, stored with --kind env. Nothing was posted.");
  }
  return username;
}

function headers(token) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

// Meta's own error code and message, bounded and printable. It never carries the request's headers.
async function graphError(response, redact = value => value) {
  let body = "";
  try {
    body = await response.text();
  } catch {
    return { message: "no message" };
  }
  let error;
  try {
    error = JSON.parse(body)?.error;
  } catch {
    // not JSON: keep the raw text
  }
  const raw = error?.error_user_msg || error?.message || body;
  const message = redact(String(raw)).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300) || "no message";
  return { code: Number.isInteger(error?.code) ? error.code : undefined, message };
}

async function failure(response, stage, nothing = "Nothing was posted.", redact) {
  const { code, message } = await graphError(response, redact);
  const detail = `HTTP ${response.status}${code === undefined ? "" : `, code ${code}`}`;
  if (code === 190) {
    return new PublishError(`${stage} was refused (${detail}): the Instagram token expired or was revoked. Send "renova o token", or generate a new token in the Meta app and run instagram/scripts/token.mjs store in WSL. ${nothing}`);
  }
  if (code === 10 || code === 200 || response.status === 403) {
    return new PublishError(`${stage} was refused (${detail}: ${message}): the token needs instagram_business_content_publish, or the egress proxy refused the request (INSTAGRAM_ACCESS_TOKEN not bound to graph.instagram.com). ${nothing}`);
  }
  if (rateLimitCodes.has(code) || response.status === 429) {
    return new PublishError(`${stage} was refused (${detail}): Instagram's rate or publishing limit. Try again later. ${nothing}`);
  }
  return new PublishError(`${stage} failed (${detail}): ${message}. ${nothing}`);
}

// Before media_publish nothing is public: a failed or timed-out request posts nothing (unpublished containers expire).
async function request(fetch, url, init, stage, timeoutMs) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? "timeout" : error?.cause?.code ?? error?.code ?? "network error";
    throw new PublishError(`${stage} did not complete (${reason}). Nothing was posted.`);
  }
}

async function json(response, stage) {
  try {
    return await response.json();
  } catch {
    throw new PublishError(`Instagram answered ${stage} with invalid JSON. Nothing was posted.`);
  }
}

// The professional account behind the token: its id for the media endpoints and its username, which the publisher
// checks against INSTAGRAM_USERNAME before anything is uploaded.
export async function fetchAccount({ fetch, token, version, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const stage = "reading the Instagram account";
  const response = await request(fetch, `${GRAPH_URL}/${version}/me?fields=user_id,username`, { method: "GET", headers: headers(token) }, stage, timeoutMs);
  if (!response.ok) throw await failure(response, stage);
  const data = await json(response, stage);
  const userId = String(data?.user_id ?? "");
  const username = String(data?.username ?? "");
  if (!idPattern.test(userId) || !usernamePattern.test(username)) throw new PublishError("Instagram returned no valid account id or username. Nothing was posted.");
  return { userId, username };
}

// One media container: an image, carousel item or carousel.
export async function createContainer({ fetch, token, version, userId, fields, redact, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const stage = "creating the media container";
  const response = await request(fetch, `${GRAPH_URL}/${version}/${userId}/media`, {
    method: "POST", headers: headers(token), body: JSON.stringify(fields)
  }, stage, timeoutMs);
  if (!response.ok) throw await failure(response, stage, undefined, redact);
  const id = String((await json(response, stage))?.id ?? "");
  if (!idPattern.test(id)) throw new PublishError("Instagram created a container without a valid id. Nothing was posted.");
  return id;
}

// Waits until Instagram has fetched and processed the container's media.
export async function waitForContainer({
  fetch, token, version, containerId, sleep, redact, attempts = STATUS_ATTEMPTS, intervalMs = STATUS_INTERVAL_MS,
  timeoutMs = REQUEST_TIMEOUT_MS
}) {
  const stage = "checking the media container";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await request(fetch, `${GRAPH_URL}/${version}/${containerId}?fields=status_code`, { method: "GET", headers: headers(token) }, stage, timeoutMs);
    if (!response.ok) throw await failure(response, stage, undefined, redact);
    const status = String((await json(response, stage))?.status_code ?? "");
    if (status === "FINISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new PublishError(`Instagram could not process a slide (container status ${status}): check that the image URL is public and the image is a JPEG. Nothing was posted.`);
    }
    if (status !== "IN_PROGRESS") throw new PublishError(`Instagram reported an unexpected container status (${status.slice(0, 20) || "none"}). Nothing was posted.`);
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new PublishError("Instagram did not finish processing the slides in time. Nothing was posted.");
}

// One attempt, never retried: a request that timed out may already have published the post.
export async function publishContainer({ fetch, token, version, userId, creationId, redact, timeoutMs = REQUEST_TIMEOUT_MS }) {
  let response;
  try {
    response = await fetch(`${GRAPH_URL}/${version}/${userId}/media_publish`, {
      method: "POST", headers: headers(token), body: JSON.stringify({ creation_id: creationId }), signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const code = error?.cause?.code ?? error?.code;
    if (connectionFailureCodes.has(code)) throw new PublishError(`could not reach Instagram (${code}). Nothing was sent.`);
    const reason = error?.name === "TimeoutError" ? "timeout" : "network error";
    throw new PublishError(`the request to publish did not complete (${reason}). The post may already exist: check the profile before retrying.`, "unknown");
  }
  if (response.status >= 500) {
    const { message } = await graphError(response, redact);
    throw new PublishError(`Instagram answered HTTP ${response.status} to the publication: ${message}. The post may exist anyway: check the profile before retrying.`, "unknown");
  }
  if (!response.ok) throw await failure(response, "publishing", "Nothing was posted; the draft is unchanged.", redact);
  let id = "";
  try {
    id = String((await response.json())?.id ?? "");
  } catch {
    // handled below
  }
  if (!idPattern.test(id)) {
    throw new PublishError("Instagram answered the publication without a media id. The post probably exists: check the profile before retrying.", "unknown");
  }
  return id;
}

// The post's public URL. The post already exists, so a failure here only leaves the URL out.
export async function fetchPermalink({ fetch, token, version, mediaId, timeoutMs = REQUEST_TIMEOUT_MS }) {
  try {
    const response = await fetch(`${GRAPH_URL}/${version}/${mediaId}?fields=permalink`, {
      method: "GET", headers: headers(token), signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const permalink = String((await response.json())?.permalink ?? "");
    const url = new URL(permalink);
    return url.protocol === "https:" && url.hostname === "www.instagram.com" ? permalink : null;
  } catch {
    return null;
  }
}
