import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DraftError, MAX_POST_CHARACTERS, readDraftText, resolveDraft } from "../../linkedin/publisher/lib/draft.mjs";

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "linkedin-draft-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "content", "drafts"), { recursive: true });
  return root;
}

test("accepts an existing .md file directly under content/drafts/", async t => {
  const root = await workspace(t);
  const file = path.join(root, "content", "drafts", "2026-10-07-evidence-v1.md");
  await writeFile(file, "Post\n");
  const resolved = await resolveDraft(root, "content/drafts/2026-10-07-evidence-v1.md");
  assert.equal(path.basename(resolved), "2026-10-07-evidence-v1.md");
});

test("refuses a path outside content/drafts/", async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, "content", "notes.md"), "x");
  await assert.rejects(resolveDraft(root, "content/notes.md"), DraftError);
  await assert.rejects(resolveDraft(root, "content/drafts/../notes.md"), DraftError);
});

test("refuses a file in a subfolder of content/drafts/", async t => {
  const root = await workspace(t);
  await mkdir(path.join(root, "content", "drafts", "old"));
  await writeFile(path.join(root, "content", "drafts", "old", "a.md"), "x");
  await assert.rejects(resolveDraft(root, "content/drafts/old/a.md"), DraftError);
});

test("refuses a missing file", async t => {
  const root = await workspace(t);
  await assert.rejects(resolveDraft(root, "content/drafts/missing.md"), /draft not found/);
});

test("refuses a non-.md file", async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, "content", "drafts", "post.txt"), "x");
  await assert.rejects(resolveDraft(root, "content/drafts/post.txt"), /\.md file/);
});

test("refuses a missing argument", async t => {
  const root = await workspace(t);
  await assert.rejects(resolveDraft(root, undefined), /usage/);
});

test("refuses a symlink in content/drafts/ that points outside it", async t => {
  const root = await workspace(t);
  const outside = path.join(root, "secret.md");
  await writeFile(outside, "x");
  try {
    await symlink(outside, path.join(root, "content", "drafts", "escape.md"));
  } catch (error) {
    t.skip(`symlinks unavailable here: ${error.code}`);
    return;
  }
  await assert.rejects(resolveDraft(root, "content/drafts/escape.md"), DraftError);
});

test("reads the whole file as the post, without surrounding whitespace", async t => {
  const root = await workspace(t);
  const file = path.join(root, "content", "drafts", "a.md");
  await writeFile(file, "\nHook line (with parens)\n\nBody #AI\n\n");
  assert.equal(await readDraftText(file), "Hook line (with parens)\n\nBody #AI");
});

test("refuses an empty or whitespace-only draft", async t => {
  const root = await workspace(t);
  const file = path.join(root, "content", "drafts", "a.md");
  await writeFile(file, " \n\t\n");
  await assert.rejects(readDraftText(file), /empty/);
});

test("refuses a draft longer than LinkedIn accepts", async t => {
  const root = await workspace(t);
  const file = path.join(root, "content", "drafts", "a.md");
  await writeFile(file, "x".repeat(MAX_POST_CHARACTERS + 1));
  await assert.rejects(readDraftText(file), /at most 3000/);
});
