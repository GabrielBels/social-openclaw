#!/home/openclaw/.openclaw/tools/node/bin/node
// Publishes one approved draft to the configured Instagram account, as a single image or a carousel:
// publish.mjs content/drafts/<file>.md
// The draft holds the caption; `<file>.slides.txt` beside it lists the slides, made by image_generate or drawn from SVG
// by render.mjs, with their alt text. Each slide goes to a private B2 bucket; a one-hour download URL lets Instagram fetch it into a media container,
// the post is published,
// and the slides are removed from the bucket.
// It prints one JSON line: the post URL on stdout (exit 0), or the reason on stderr (exit 1). It never prints a token,
// its sentinel, the request headers or the environment.
// It is installed outside the agent's workspace, where the agent's file tools cannot change it, so the command an
// approval names always runs this exact code. The workspace it reads drafts from is fixed, and so is the OpenClaw media
// folder where image_generate saves images.
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DraftError, readCaption, resolveDraft } from "./lib/draft.mjs";
import {
  PublishError, createContainer, fetchAccount, fetchPermalink, publishContainer, readApiVersion, readUsername, requiredProtectedSecret,
  waitForContainer
} from "./lib/instagram-media.mjs";
import { authorizeStorage, createDownloadUrl, deleteSlide, readB2Config, uploadSlide } from "./lib/b2.mjs";
import { findSlideImages, readJpeg, readSlides } from "./lib/slides.mjs";
import { readEditorialMetadata } from "./lib/editorial.mjs";
import { claimPublication } from "./lib/publication-state.mjs";

const defaultWorkspaceRoot = "/home/openclaw/.openclaw-social/workspace-instagram";
// OpenClaw's media store keeps image_generate results in this subfolder of the profile.
const defaultImagesDir = "/home/openclaw/.openclaw-social/media/tool-image-generation";

// A single image carries the caption itself; a carousel gets one container per slide, then one for the carousel.
async function publishSlides({ fetch, token, version, userId, slides, urls, caption, sleep, redact }) {
  const api = { fetch, token, version, userId, redact };
  const ready = containerId => waitForContainer({ fetch, token, version, containerId, sleep, redact });
  let creationId;
  if (slides.length === 1) {
    creationId = await createContainer({ ...api, fields: { image_url: urls[0], caption, alt_text: slides[0].alt } });
  } else {
    const children = [];
    for (const [index, slide] of slides.entries()) {
      children.push(await createContainer({ ...api, fields: { image_url: urls[index], is_carousel_item: true, alt_text: slide.alt } }));
    }
    for (const child of children) await ready(child);
    creationId = await createContainer({ ...api, fields: { media_type: "CAROUSEL", children: children.join(","), caption } });
  }
  await ready(creationId);
  return publishContainer({ ...api, creationId });
}

// Meta error messages can reflect image URLs. Remove their credentials before diagnostics are truncated or printed.
function redactDownloadAccess(message, urls) {
  let safe = String(message);
  for (const url of urls) {
    const token = new URL(url).searchParams.get("Authorization");
    for (const value of [url, encodeURIComponent(url), token, token && encodeURIComponent(token)]) {
      if (value) safe = safe.replaceAll(value, "[private image access]");
    }
  }
  return safe.replace(/([?&]Authorization=)[^&#\s"'<>]*/gi, "$1[redacted]");
}

export async function run({
  argv = process.argv.slice(2),
  env = process.env,
  fetch = globalThis.fetch,
  sleep = delay,
  newPrefix = () => randomBytes(16).toString("hex"),
  workspaceRoot = defaultWorkspaceRoot,
  imagesDir = defaultImagesDir,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  let leftInBucket = false;
  let publication;
  const privateUrls = [];
  const redact = message => redactDownloadAccess(message, privateUrls);
  try {
    if (argv.length !== 1) throw new DraftError("usage: publish.mjs <content/drafts/<file>.md>");
    const draftPath = await resolveDraft(workspaceRoot, argv[0]);
    const metadata = await readEditorialMetadata(draftPath);
    const caption = await readCaption(draftPath);
    const slides = await findSlideImages(imagesDir, await readSlides(draftPath), path.dirname(draftPath));
    const media = [];
    for (const [index, slide] of slides.entries()) media.push({ name: slide.name, bytes: await readJpeg(slide, index + 1), contentType: "image/jpeg" });
    const version = readApiVersion(env.INSTAGRAM_API_VERSION);
    const expected = readUsername(env.INSTAGRAM_USERNAME);
    const token = requiredProtectedSecret("INSTAGRAM_ACCESS_TOKEN", env);
    const b2 = readB2Config(env);
    const b2Token = requiredProtectedSecret("INSTAGRAM_B2_BASIC_AUTH", env);
    publication = await claimPublication(workspaceRoot, draftPath, metadata);

    const account = await fetchAccount({ fetch, token, version });
    if (account.username.toLowerCase() !== expected.toLowerCase()) {
      throw new PublishError(`the Instagram token belongs to @${account.username}, not @${expected} (INSTAGRAM_USERNAME). Nothing was posted.`);
    }

    const session = await authorizeStorage({ fetch, token: b2Token, b2 });
    // Random names scope temporary download access to files of this publication attempt.
    const prefix = newPrefix();
    const keys = [];
    let mediaId;
    try {
      const urls = [];
      for (const item of media) {
        const key = `${prefix}-${item.name}`;
        const staged = { key };
        keys.push(staged);
        const uploaded = await uploadSlide({ fetch, session, key, bytes: item.bytes, contentType: item.contentType });
        staged.fileId = uploaded.fileId;
        const downloadUrl = await createDownloadUrl({ fetch, session, key });
        privateUrls.push(downloadUrl);
        urls.push(downloadUrl);
      }
      mediaId = await publishSlides({ fetch, token, version, userId: account.userId, slides, urls, caption, sleep, redact });
      await publication.published({ mediaId, url: null, account: `@${account.username}` });
    } finally {
      for (const staged of keys) {
        if (!(await deleteSlide({ fetch, session, ...staged }))) leftInBucket = true;
      }
    }

    const url = await fetchPermalink({ fetch, token, version, mediaId });
    await publication.published({ mediaId, url, account: `@${account.username}` });
    stdout.write(`${redact(JSON.stringify({
      status: "published", mediaId, url, account: `@${account.username}`, draft: `content/drafts/${path.basename(draftPath)}`,
      slides: slides.length, cleanup: leftInBucket ? "failed" : "done"
    }))}\n`);
    return 0;
  } catch (error) {
    // An unexpected failure may have happened after the request was sent, so it is reported as unknown.
    const known = error instanceof DraftError || error instanceof PublishError;
    const status = known && error.outcome !== "unknown" ? "not_posted" : "unknown";
    await publication?.failed(status).catch(() => {});
    let message = known ? error.message : "publish failed unexpectedly: check the profile before retrying";
    if (leftInBucket) message += " Some media may remain in the B2 bucket; check its lifecycle rules.";
    stderr.write(`${JSON.stringify({ status, message: redact(message) })}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run();
}
