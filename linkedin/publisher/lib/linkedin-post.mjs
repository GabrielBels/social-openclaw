import { escapeLittleText } from "./little-text.mjs";

export const POSTS_URL = "https://api.linkedin.com/rest/posts";
export const IMAGES_URL = "https://api.linkedin.com/rest/images?action=initializeUpload";
export const REQUEST_TIMEOUT_MS = 30000;

const protectedSentinelPrefix = "oc-sent-v2";
const apiVersionPattern = /^[0-9]{6}(\.[0-9]{2})?$/;
const imageUrnPattern = /^urn:li:image:[A-Za-z0-9_-]+$/;
const personUrnPattern = /^urn:li:person:[A-Za-z0-9_-]+$/;
// The request never left this machine, so nothing can have been posted.
const connectionFailureCodes = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

// outcome: "not_posted" (LinkedIn refused, or nothing was sent) or "unknown" (the post may exist).
export class PublishError extends Error {
  constructor(message, outcome = "not_posted") {
    super(message);
    this.outcome = outcome;
  }
}

// The token is a protected OpenClaw secret: the script only ever holds its sentinel, and the Gateway egress proxy
// substitutes the value on the way to api.linkedin.com. A plaintext value is refused rather than used.
export function requiredProtectedSecret(name, env) {
  const value = env[name];
  if (!value) throw new PublishError(`protected secret is unavailable: ${name}`);
  if (!value.startsWith(protectedSentinelPrefix)) throw new PublishError(`${name} must remain a protected OpenClaw secret`);
  return value;
}

// The LinkedIn-Version header (YYYYMM), an env entry of the OpenClaw store. LinkedIn retires each version after about a
// year and then answers 426, so it is set there, not in code.
export function readApiVersion(value) {
  const version = String(value ?? "").trim();
  if (!version) throw new PublishError("LINKEDIN_API_VERSION is not in the OpenClaw store (see docs/operations.md, Setup). Nothing was posted.");
  if (!apiVersionPattern.test(version)) throw new PublishError("LINKEDIN_API_VERSION must be a LinkedIn API version (YYYYMM). Nothing was posted.");
  return version;
}

export function readAccount(account, now) {
  if (!personUrnPattern.test(account?.personUrn ?? "")) {
    throw new PublishError("state/linkedin-account.json has no valid personUrn; renew the token (linkedin/scripts/auth.mjs url in WSL, then \"renova o token\")");
  }
  const expiresAt = Date.parse(account.expiresAt);
  if (Number.isNaN(expiresAt)) throw new PublishError("state/linkedin-account.json has no valid expiresAt; renew the token (linkedin/scripts/auth.mjs url in WSL, then \"renova o token\")");
  if (expiresAt <= now.getTime()) {
    throw new PublishError("the LinkedIn token expired; renew it (linkedin/scripts/auth.mjs url in WSL, then \"renova o token\"). Nothing was posted.");
  }
  return { personUrn: account.personUrn, expiresAt: account.expiresAt };
}

function restHeaders(token, version) {
  return {
    authorization: `Bearer ${token}`,
    "linkedin-version": version,
    "x-restli-protocol-version": "2.0.0",
    "content-type": "application/json"
  };
}

export function buildPostRequest({ token, personUrn, text, version, imageUrn }) {
  return {
    url: POSTS_URL,
    init: {
      method: "POST",
      headers: restHeaders(token, version),
      body: JSON.stringify({
        author: personUrn,
        commentary: escapeLittleText(text),
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        ...(imageUrn ? { content: { media: { id: imageUrn } } } : {}),
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false
      })
    }
  };
}

// The token goes only to the upload URL LinkedIn documents for the Images API: https on www.linkedin.com/dms-uploads/.
function uploadUrlOrNull(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.linkedin.com" && url.pathname.startsWith("/dms-uploads/") ? value : null;
  } catch {
    return null;
  }
}

// Before the post exists, a failed or timed-out request cannot have posted anything.
async function imageRequest(fetch, url, init, timeoutMs, stage) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? "timeout" : error?.cause?.code ?? error?.code ?? "network error";
    throw new PublishError(`${stage} did not complete (${reason}). Nothing was posted.`);
  }
}

async function imageFailure(response, stage) {
  if (response.status === 401) {
    await response.body?.cancel();
    return new PublishError(`${stage} was refused (HTTP 401): the token expired or was revoked. Renew it (linkedin/scripts/auth.mjs url in WSL, then "renova o token"). Nothing was posted.`);
  }
  if (response.status === 403) {
    await response.body?.cancel();
    return new PublishError(`${stage} was refused (HTTP 403): LINKEDIN_ACCESS_TOKEN must be allowed for api.linkedin.com and www.linkedin.com, and the app needs w_member_social. Nothing was posted.`);
  }
  return new PublishError(`${stage} failed with HTTP ${response.status}: ${await linkedinMessage(response)}. Nothing was posted.`);
}

// Images API: register the upload for the member, send the bytes to the URL LinkedIn returns, and hand back the image
// URN for the post. One attempt each, never retried.
export async function uploadImage({ fetch, token, personUrn, version, bytes, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const registered = await imageRequest(fetch, IMAGES_URL, {
    method: "POST",
    headers: restHeaders(token, version),
    body: JSON.stringify({ initializeUploadRequest: { owner: personUrn } })
  }, timeoutMs, "registering the image");
  if (registered.status !== 200) throw await imageFailure(registered, "registering the image");
  let value;
  try {
    value = (await registered.json())?.value;
  } catch {
    throw new PublishError("LinkedIn answered the image registration with invalid JSON. Nothing was posted.");
  }
  const uploadUrl = uploadUrlOrNull(value?.uploadUrl);
  if (!uploadUrl || !imageUrnPattern.test(String(value?.image ?? ""))) {
    throw new PublishError("LinkedIn's image registration returned no valid upload URL or image id. Nothing was posted.");
  }
  const uploaded = await imageRequest(fetch, uploadUrl, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    body: bytes
  }, timeoutMs, "uploading the image");
  if (uploaded.status !== 200 && uploaded.status !== 201) throw await imageFailure(uploaded, "uploading the image");
  await uploaded.body?.cancel();
  return value.image;
}

export function postUrl(urn) {
  return `https://www.linkedin.com/feed/update/${urn}/`;
}

// LinkedIn's own error message, bounded and printable. It never carries the request's headers.
async function linkedinMessage(response) {
  let body = "";
  try {
    body = await response.text();
  } catch {
    return "no message";
  }
  let message = body;
  try {
    message = JSON.parse(body)?.message ?? body;
  } catch {
    // not JSON: keep the raw text
  }
  const clean = String(message).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean === "" ? "no message" : clean.slice(0, 300);
}

async function failureFor(response, version) {
  const { status } = response;
  if (status === 401) {
    await response.body?.cancel();
    return new PublishError("LinkedIn rejected the token (HTTP 401): it expired or was revoked. Renew it (linkedin/scripts/auth.mjs url in WSL, then \"renova o token\"). Nothing was posted.");
  }
  if (status === 403) {
    await response.body?.cancel();
    return new PublishError("The post was refused (HTTP 403): the app lacks the w_member_social scope or the Share on LinkedIn product, or the Gateway egress proxy refused the request (LINKEDIN_ACCESS_TOKEN not bound to api.linkedin.com). Nothing was posted.");
  }
  const message = await linkedinMessage(response);
  if (status === 426) {
    return new PublishError(`LinkedIn retired API version ${version} (HTTP 426: ${message}). Set LINKEDIN_API_VERSION in the OpenClaw store to an active version. Nothing was posted.`);
  }
  if (status >= 500) {
    return new PublishError(`LinkedIn answered HTTP ${status}: ${message}. The post may exist anyway: check the profile before retrying.`, "unknown");
  }
  return new PublishError(`LinkedIn answered HTTP ${status}: ${message}. Nothing was posted; the draft is unchanged.`);
}

// One attempt, never retried: a POST that timed out may already have been published.
export async function publishPost({ fetch, token, personUrn, text, version, imageUrn, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const { url, init } = buildPostRequest({ token, personUrn, text, version, imageUrn });
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const code = error?.cause?.code ?? error?.code;
    if (connectionFailureCodes.has(code)) {
      throw new PublishError(`could not reach LinkedIn (${code}). Nothing was sent.`);
    }
    const reason = error?.name === "TimeoutError" ? "timeout" : "network error";
    throw new PublishError(`the request to LinkedIn did not complete (${reason}). The post may already exist: check the profile before retrying.`, "unknown");
  }
  if (response.status !== 201) throw await failureFor(response, version);
  await response.body?.cancel();
  const urn = response.headers.get("x-restli-id");
  if (!urn) {
    throw new PublishError("LinkedIn answered 201 without a post id. The post probably exists: check the profile before retrying.", "unknown");
  }
  return { status: "published", urn, url: postUrl(urn) };
}
