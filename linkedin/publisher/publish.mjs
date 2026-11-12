#!/home/openclaw/.openclaw/tools/node/bin/node
// Publishes one approved draft to the member's LinkedIn profile, with the image made for it when there is one:
// publish.mjs content/drafts/<file>.md
// It prints one JSON line: the post URL on stdout (exit 0), or the reason on stderr (exit 1). It never prints the
// token, its sentinel, the request headers or the environment.
// It is installed outside the agent's workspace, where the agent's file tools cannot change it, so the command an
// approval names always runs this exact code. The workspace it reads drafts and state from is fixed, and so is the
// OpenClaw media folder where image_generate saves images.
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DraftError, readDraftText, resolveDraft } from "./lib/draft.mjs";
import { findDraftImage, readImage } from "./lib/image.mjs";
import { PublishError, publishPost, readAccount, readApiVersion, requiredProtectedSecret, uploadImage } from "./lib/linkedin-post.mjs";

const defaultWorkspaceRoot = "/home/openclaw/.openclaw-social/workspace-linkedin";
// OpenClaw's media store keeps image_generate results in this subfolder of the profile.
const defaultImagesDir = "/home/openclaw/.openclaw-social/media/tool-image-generation";

async function loadAccount(workspaceRoot, now) {
  let account;
  try {
    account = JSON.parse(await readFile(path.join(workspaceRoot, "state", "linkedin-account.json"), "utf8"));
  } catch {
    throw new PublishError("state/linkedin-account.json is missing or unreadable; renew the token (linkedin/scripts/auth.mjs url in WSL, then \"renew the token\")");
  }
  return readAccount(account, now);
}

export async function run({
  argv = process.argv.slice(2),
  env = process.env,
  fetch = globalThis.fetch,
  now = new Date(),
  workspaceRoot = defaultWorkspaceRoot,
  imagesDir = defaultImagesDir,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  try {
    if (argv.length !== 1) throw new DraftError("usage: publish.mjs <content/drafts/<file>.md>");
    const draftPath = await resolveDraft(workspaceRoot, argv[0]);
    const text = await readDraftText(draftPath);
    const { personUrn } = await loadAccount(workspaceRoot, now);
    const version = readApiVersion(env.LINKEDIN_API_VERSION);
    const token = requiredProtectedSecret("LINKEDIN_ACCESS_TOKEN", env);
    const image = await findDraftImage(imagesDir, draftPath);
    const imageUrn = image ? await uploadImage({ fetch, token, personUrn, version, bytes: await readImage(image) }) : undefined;
    const result = await publishPost({ fetch, token, personUrn, text, version, imageUrn });
    stdout.write(`${JSON.stringify({ ...result, draft: `content/drafts/${path.basename(draftPath)}`, image: image?.name ?? null })}\n`);
    return 0;
  } catch (error) {
    // An unexpected failure may have happened after the request was sent, so it is reported as unknown.
    const known = error instanceof DraftError || error instanceof PublishError;
    const status = known && error.outcome !== "unknown" ? "not_posted" : "unknown";
    const message = known ? error.message : "publish failed unexpectedly: check the profile before retrying";
    stderr.write(`${JSON.stringify({ status, message })}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run();
}
