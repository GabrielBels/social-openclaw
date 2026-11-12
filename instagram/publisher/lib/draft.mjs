import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

// Instagram's limits for a caption.
export const MAX_CAPTION_CHARACTERS = 2200;
export const MAX_HASHTAGS = 30;
export const MAX_MENTIONS = 20;

const hashtag = /(?<![\p{L}\p{N}_&#])#[\p{L}\p{N}_]+/gu;
const mention = /(?<![\p{L}\p{N}_.@])@[A-Za-z0-9._]+/gu;

export class DraftError extends Error {}

// The only file publish.mjs may post: an existing .md file directly inside <workspace>/content/drafts/, after
// resolving symlinks, so a link that points elsewhere is refused.
export async function resolveDraft(workspaceRoot, draftArg) {
  if (typeof draftArg !== "string" || draftArg.trim() === "") throw new DraftError("usage: publish.mjs <content/drafts/<file>.md>");
  if (!draftArg.endsWith(".md")) throw new DraftError("the draft must be a .md file under content/drafts/");
  const draftsDir = path.join(workspaceRoot, "content", "drafts");
  let realDrafts;
  let realDraft;
  try {
    realDrafts = await realpath(draftsDir);
    realDraft = await realpath(path.resolve(workspaceRoot, draftArg));
  } catch {
    throw new DraftError(`draft not found: ${draftArg}`);
  }
  if (path.dirname(realDraft) !== realDrafts || !realDraft.endsWith(".md")) {
    throw new DraftError("the draft must be a .md file directly under content/drafts/");
  }
  return realDraft;
}

// The whole file is the caption, exactly as it will appear. Surrounding whitespace (an editor's final newline) is not
// part of it. Instagram refuses a caption over its limits, so they are checked before anything is uploaded.
export async function readCaption(draftPath) {
  const text = (await readFile(draftPath, "utf8")).trim();
  if (text === "") throw new DraftError("the draft is empty");
  if (text.length > MAX_CAPTION_CHARACTERS) {
    throw new DraftError(`the caption has ${text.length} characters; Instagram accepts at most ${MAX_CAPTION_CHARACTERS}`);
  }
  const hashtags = text.match(hashtag)?.length ?? 0;
  if (hashtags > MAX_HASHTAGS) throw new DraftError(`the caption has ${hashtags} hashtags; Instagram accepts at most ${MAX_HASHTAGS}`);
  const mentions = text.match(mention)?.length ?? 0;
  if (mentions > MAX_MENTIONS) throw new DraftError(`the caption has ${mentions} @mentions; Instagram accepts at most ${MAX_MENTIONS}`);
  return text;
}
