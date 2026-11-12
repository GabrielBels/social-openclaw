import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DraftError, MAX_CAPTION_CHARACTERS, readCaption, resolveDraft } from "../../instagram/publisher/lib/draft.mjs";

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "instagram-draft-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "content", "drafts"), { recursive: true });
  await writeFile(path.join(root, "content", "drafts", "2026-10-12-prazo-recurso-v1.md"), "Legenda.\n");
  await writeFile(path.join(root, "content", "drafts", "2026-10-12-prazo-recurso-v1.slides.txt"), "x");
  await writeFile(path.join(root, "outside.md"), "fora");
  return root;
}

test("resolves a draft directly under content/drafts/", async t => {
  const root = await workspace(t);
  const resolved = await resolveDraft(root, "content/drafts/2026-10-12-prazo-recurso-v1.md");
  assert.equal(path.basename(resolved), "2026-10-12-prazo-recurso-v1.md");
});

test("refuses a missing draft, another extension, or a file outside content/drafts/", async t => {
  const root = await workspace(t);
  for (const bad of ["content/drafts/2026-10-12-missing-v1.md", "content/drafts/2026-10-12-prazo-recurso-v1.slides.txt", "outside.md",
    "content/drafts/../../outside.md", "", undefined]) {
    await assert.rejects(resolveDraft(root, bad), DraftError, String(bad));
  }
});

test("refuses a symlink in content/drafts/ that points outside it", { skip: process.platform === "win32" }, async t => {
  const root = await workspace(t);
  await symlink(path.join(root, "outside.md"), path.join(root, "content", "drafts", "2026-10-12-link-v1.md"));
  await assert.rejects(resolveDraft(root, "content/drafts/2026-10-12-link-v1.md"), /directly under content\/drafts/);
});

async function caption(t, text) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "instagram-caption-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "2026-10-12-x-v1.md");
  await writeFile(file, text);
  return readCaption(file);
}

test("the whole file is the caption, without the surrounding whitespace", async t => {
  const text = "Pedido recusado por falta de anexo: como evitar.\n\nFonte: manual do fornecedor.\n\n#pedidos #gestaodecompras";
  assert.equal(await caption(t, `\n${text}\n\n`), text);
});

test("refuses an empty caption and one over Instagram's limits", async t => {
  await assert.rejects(caption(t, " \n"), /empty/);
  await assert.rejects(caption(t, "a".repeat(MAX_CAPTION_CHARACTERS + 1)), /2201 characters/);
  await assert.rejects(caption(t, Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ")), /31 hashtags/);
  await assert.rejects(caption(t, Array.from({ length: 21 }, (_, i) => `@conta${i}`).join(" ")), /21 @mentions/);
});

test("counts hashtags and mentions as Instagram does, not every # or @", async t => {
  const tags = Array.from({ length: 30 }, (_, i) => `#faturamento${i}`).join(" ");
  assert.ok(await caption(t, `${tags} contato@empresa.com.br C# pedido nº 12#3`));
});
