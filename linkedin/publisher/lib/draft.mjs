import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

// LinkedIn's limit for a post's commentary.
export const MAX_POST_CHARACTERS = 3000;

export class DraftError extends Error {}

// The only file publish.mjs may post (or render.mjs draw, with `.svg`): an existing file with that extension directly
// inside <workspace>/content/drafts/, after resolving symlinks, so a link that points elsewhere is refused.
export async function resolveDraft(workspaceRoot, draftArg, {
  extension = ".md", usage = "usage: publish.mjs <content/drafts/<file>.md>"
} = {}) {
  if (typeof draftArg !== "string" || draftArg.trim() === "") throw new DraftError(usage);
  if (!draftArg.endsWith(extension)) throw new DraftError(`the draft must be a ${extension} file under content/drafts/`);
  const draftsDir = path.join(workspaceRoot, "content", "drafts");
  let realDrafts;
  let realDraft;
  try {
    realDrafts = await realpath(draftsDir);
    realDraft = await realpath(path.resolve(workspaceRoot, draftArg));
  } catch {
    throw new DraftError(`draft not found: ${draftArg}`);
  }
  if (path.dirname(realDraft) !== realDrafts || !realDraft.endsWith(extension)) {
    throw new DraftError(`the draft must be a ${extension} file directly under content/drafts/`);
  }
  return realDraft;
}

// The whole file is the post. Surrounding whitespace (an editor's final newline) is not part of it.
export async function readDraftText(draftPath) {
  const text = (await readFile(draftPath, "utf8")).trim();
  if (text === "") throw new DraftError("the draft is empty");
  if (text.length > MAX_POST_CHARACTERS) {
    throw new DraftError(`the draft has ${text.length} characters; LinkedIn accepts at most ${MAX_POST_CHARACTERS}`);
  }
  return text;
}
