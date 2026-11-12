// The permanent Basic credential is substituted by OpenClaw only at api.backblazeb2.com.
// B2 session credentials live only in this trusted publisher's memory and are never printed or persisted.
import { createHash } from "node:crypto";
import { PublishError } from "./instagram-media.mjs";

export const AUTHORIZE_URL = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account";
export const REQUEST_TIMEOUT_MS = 30000;
export const DOWNLOAD_TTL_SECONDS = 3600;
const keyPattern = /^[A-Za-z0-9._-]{1,200}$/;
const fileIdPattern = /^[A-Za-z0-9_-]{1,300}$/;
const credentialPattern = /^[\x21-\x7e]{1,4096}$/;

export function readB2Config(env) {
  const bucketId = String(env.INSTAGRAM_B2_BUCKET_ID ?? "").trim();
  const bucketName = String(env.INSTAGRAM_B2_BUCKET_NAME ?? "").trim();
  if (!/^[0-9a-f]{24}$/.test(bucketId)) throw new PublishError("INSTAGRAM_B2_BUCKET_ID must be the B2 bucket id, stored with --kind env. Nothing was posted.");
  if (!/^[A-Za-z0-9-]{6,63}$/.test(bucketName)) throw new PublishError("INSTAGRAM_B2_BUCKET_NAME must be the B2 bucket name, stored with --kind env. Nothing was posted.");
  return { bucketId, bucketName };
}

function endpoint(value, kind) {
  let url;
  try { url = new URL(value); } catch { /* rejected below */ }
  const host = kind === "api" ? /^api\d{3}\.backblazeb2\.com$/
    : kind === "download" ? /^f\d{3}\.backblazeb2\.com$/
      : /^pod-\d{3}-\d+-\d+\.(?:backblaze|backblazeb2)\.com$/;
  if (!url || url.protocol !== "https:" || url.port || url.username || url.password || url.hash || !host.test(url.hostname) ||
      (kind !== "upload" && (url.pathname !== "/" || url.search)) ||
      (kind === "upload" && !/^\/b2api\/v4\/b2_upload_file(?:\/|$)/.test(url.pathname))) {
    throw new PublishError(`B2 returned an unsafe ${kind} endpoint. Nothing was posted.`);
  }
  return kind === "upload" ? url.href : url.origin;
}

function credential(value) {
  if (typeof value !== "string" || !credentialPattern.test(value)) throw new PublishError("B2 returned an invalid session credential. Nothing was posted.");
  return value;
}

async function request(fetch, url, init, step, timeoutMs) {
  let response;
  try {
    response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new PublishError(`B2 ${step} did not complete (${error?.name === "TimeoutError" ? "timeout" : "network error"}). Nothing was posted.`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    // Provider error bodies can reflect credentials. Report only the HTTP status.
    throw new PublishError(`B2 ${step} failed with HTTP ${response.status}. Nothing was posted.`);
  }
  try { return await response.json(); } catch {
    throw new PublishError(`B2 ${step} returned invalid JSON. Nothing was posted.`);
  }
}

function apiRequest(session, operation, body) {
  return [`${session.apiUrl}/b2api/v4/${operation}`, {
    method: "POST", headers: { authorization: session.token, "content-type": "application/json" }, body: JSON.stringify(body)
  }];
}

export async function authorizeStorage({ fetch, token, b2, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const data = await request(fetch, AUTHORIZE_URL, { method: "GET", headers: { authorization: token } }, "authorization", timeoutMs);
  const storage = data?.apiInfo?.storageApi;
  const allowed = storage?.allowed;
  if (!Array.isArray(allowed?.buckets) || allowed.buckets.length !== 1 ||
      allowed.buckets[0]?.id !== b2.bucketId || allowed.buckets[0]?.name !== b2.bucketName || allowed.namePrefix ||
      !Array.isArray(allowed.capabilities) || !["writeFiles", "deleteFiles", "listFiles", "shareFiles"].every(value => allowed.capabilities.includes(value))) {
    throw new PublishError("The B2 application key must be restricted to the configured bucket and allow writing, listing, deleting and sharing files, without a file prefix. Nothing was posted.");
  }
  return { ...b2, apiUrl: endpoint(storage.apiUrl, "api"), downloadUrl: endpoint(storage.downloadUrl, "download"), token: credential(data.authorizationToken) };
}

export async function uploadSlide({ fetch, session, key, bytes, contentType = "image/jpeg", timeoutMs = REQUEST_TIMEOUT_MS }) {
  if (!keyPattern.test(key)) throw new PublishError("internal error: invalid B2 object key. Nothing was posted.");
  if (!["image/jpeg", "video/mp4"].includes(contentType)) throw new PublishError("internal error: invalid B2 media type. Nothing was posted.");
  const target = await request(fetch, ...apiRequest(session, "b2_get_upload_url", { bucketId: session.bucketId }), "upload preparation", timeoutMs);
  if (target?.bucketId !== session.bucketId) throw new PublishError("B2 returned an upload URL for another bucket. Nothing was posted.");
  const url = endpoint(target.uploadUrl, "upload");
  const data = await request(fetch, url, {
    method: "POST", headers: {
      authorization: credential(target.authorizationToken), "content-type": contentType, "content-length": String(bytes.length),
      "x-bz-file-name": encodeURIComponent(key), "x-bz-content-sha1": createHash("sha1").update(bytes).digest("hex"),
      "x-bz-info-b2-cache-control": "no-store"
    }, body: bytes
  }, "upload", timeoutMs);
  if (data?.bucketId !== session.bucketId || data?.fileName !== key || typeof data?.fileId !== "string" || !fileIdPattern.test(data.fileId)) {
    throw new PublishError("B2 returned invalid uploaded file metadata. Nothing was posted.");
  }
  return { fileId: data.fileId };
}

// A private bucket exposes only this attempt's random file prefix, for one hour. The URL goes only to Meta.
export async function createDownloadUrl({ fetch, session, key, timeoutMs = REQUEST_TIMEOUT_MS }) {
  if (!keyPattern.test(key)) throw new PublishError("internal error: invalid B2 object key. Nothing was posted.");
  const data = await request(fetch, ...apiRequest(session, "b2_get_download_authorization", {
    bucketId: session.bucketId, fileNamePrefix: key, validDurationInSeconds: DOWNLOAD_TTL_SECONDS
  }), "download authorization", timeoutMs);
  if (data?.bucketId !== session.bucketId || data?.fileNamePrefix !== key) {
    throw new PublishError("B2 returned download access for another bucket or file prefix. Nothing was posted.");
  }
  const url = new URL(`${session.downloadUrl}/file/${encodeURIComponent(session.bucketName)}/${encodeURIComponent(key)}`);
  url.searchParams.set("Authorization", credential(data.authorizationToken));
  return url.href;
}

// A lost upload response can leave a version in B2. Find only this attempt's exact random key in that case.
export async function deleteSlide({ fetch, session, key, fileId, timeoutMs = REQUEST_TIMEOUT_MS }) {
  try {
    if (!keyPattern.test(key)) return false;
    let ids;
    if (fileId) {
      if (!fileIdPattern.test(fileId)) return false;
      ids = [fileId];
    } else {
      const data = await request(fetch, ...apiRequest(session, "b2_list_file_versions", {
        bucketId: session.bucketId, prefix: key, maxFileCount: 100
      }), "cleanup listing", timeoutMs);
      if (!Array.isArray(data?.files) || data.nextFileName || data.nextFileId) return false;
      const files = data.files.filter(file => file?.fileName === key);
      if (files.some(file => typeof file.fileId !== "string" || !fileIdPattern.test(file.fileId))) return false;
      ids = files.map(file => file.fileId);
    }
    let removed = true;
    for (const id of ids) {
      try {
        await request(fetch, ...apiRequest(session, "b2_delete_file_version", { fileName: key, fileId: id }), "cleanup", timeoutMs);
      } catch { removed = false; }
    }
    return removed;
  } catch { return false; }
}
