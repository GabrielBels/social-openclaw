import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findDraftImage, readImage } from "../../linkedin/publisher/lib/image.mjs";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest of a png")]);
const uuid = n => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;
const draft = name => `/workspace/content/drafts/${name}`;

async function imagesDir(t, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "linkedin-images-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content = png, mtime] of files) {
    await writeFile(path.join(dir, name), content);
    if (mtime) await utimes(path.join(dir, name), mtime, mtime);
  }
  return dir;
}

test("finds the image saved under the draft's own name", async t => {
  const dir = await imagesDir(t, [[`2026-10-08-ai-agents-v1---${uuid(1)}.png`], [`2026-10-08-other-post-v1---${uuid(2)}.png`]]);
  const image = await findDraftImage(dir, draft("2026-10-08-ai-agents-v1.md"));
  assert.equal(image.name, "2026-10-08-ai-agents-v1.png");
  assert.equal(image.path, path.join(dir, `2026-10-08-ai-agents-v1---${uuid(1)}.png`));
});

test("a version without its own image reuses the newest image of an earlier version, never a later one", async t => {
  const dir = await imagesDir(t, [
    [`2026-10-08-ai-agents-v1---${uuid(1)}.png`], [`2026-10-08-ai-agents-v2---${uuid(2)}.png`], [`2026-10-08-ai-agents-v4---${uuid(3)}.png`]
  ]);
  assert.equal((await findDraftImage(dir, draft("2026-10-08-ai-agents-v3.md"))).name, "2026-10-08-ai-agents-v2.png");
  assert.equal((await findDraftImage(dir, draft("2026-10-08-ai-agents-v1.md"))).name, "2026-10-08-ai-agents-v1.png");
});

test("of two images for the same version, the newest wins", async t => {
  const dir = await imagesDir(t, [
    [`2026-10-08-ai-agents-v1---${uuid(1)}.png`, png, new Date("2026-10-08T10:00:00Z")],
    [`2026-10-08-ai-agents-v1---${uuid(2)}.png`, png, new Date("2026-10-08T11:00:00Z")]
  ]);
  const image = await findDraftImage(dir, draft("2026-10-08-ai-agents-v1.md"));
  assert.equal(image.path, path.join(dir, `2026-10-08-ai-agents-v1---${uuid(2)}.png`));
});

test("another post's image, a name without the store's suffix, another format or a missing folder means text only", async t => {
  const dir = await imagesDir(t, [
    ["2026-10-08-ai-agents-v1.png"], [`2026-10-08-ai-agents-extra-v1---${uuid(1)}.png`], [`2026-10-08-ai-agents-v1---${uuid(2)}.gif`]
  ]);
  assert.equal(await findDraftImage(dir, draft("2026-10-08-ai-agents-v1.md")), null);
  assert.equal(await findDraftImage(path.join(dir, "missing"), draft("2026-10-08-ai-agents-v1.md")), null);
});

test("finds the PNG drawn next to the draft, and the newest version across the drafts and media folders", async t => {
  const drafts = await imagesDir(t, [["2026-10-08-ai-agents-v2.png"], ["2026-10-08-ai-agents-v2.svg", "<svg/>"], ["2026-10-08-other-v1.png"]]);
  const media = await imagesDir(t, [[`2026-10-08-ai-agents-v1---${uuid(1)}.png`], [`2026-10-08-ai-agents-v3---${uuid(2)}.png`]]);
  const atVersion = n => findDraftImage(media, path.join(drafts, `2026-10-08-ai-agents-v${n}.md`));
  assert.deepEqual([(await atVersion(2)).path, (await atVersion(2)).name],
    [path.join(drafts, "2026-10-08-ai-agents-v2.png"), "2026-10-08-ai-agents-v2.png"]);
  assert.equal((await atVersion(3)).path, path.join(media, `2026-10-08-ai-agents-v3---${uuid(2)}.png`));
  assert.equal((await atVersion(1)).path, path.join(media, `2026-10-08-ai-agents-v1---${uuid(1)}.png`));
  assert.equal(await findDraftImage(media, path.join(drafts, "2026-10-08-third-v1.md")), null);
});

test("a symlink is never taken as the image", { skip: process.platform === "win32" }, async t => {
  const dir = await imagesDir(t, [["target.png"]]);
  await symlink(path.join(dir, "target.png"), path.join(dir, `2026-10-08-ai-agents-v1---${uuid(1)}.png`));
  assert.equal(await findDraftImage(dir, draft("2026-10-08-ai-agents-v1.md")), null);
});

test("reads PNG and JPEG content, and refuses anything else or anything larger than 10 MB", async t => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const dir = await imagesDir(t, [["a.png", png], ["b.jpg", jpeg], ["c.png", Buffer.from("<svg/>")]]);
  assert.deepEqual(await readImage({ path: path.join(dir, "a.png"), name: "a.png", size: png.length }), png);
  assert.deepEqual(await readImage({ path: path.join(dir, "b.jpg"), name: "b.jpg", size: jpeg.length }), jpeg);
  await assert.rejects(readImage({ path: path.join(dir, "c.png"), name: "c.png", size: 6 }), /not a PNG or JPEG/);
  await assert.rejects(readImage({ path: path.join(dir, "a.png"), name: "a.png", size: 11 * 1024 * 1024 }), /larger than 10 MB/);
});
