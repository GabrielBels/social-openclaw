import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_ALT_TEXT, findSlideImages, readJpeg, readSlides, slidesFile } from "../../instagram/publisher/lib/slides.mjs";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const uuid = n => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;

async function dir(t, prefix) {
  const created = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(created, { recursive: true, force: true }));
  return created;
}

async function draftWithSlides(t, lines, draft = "2026-10-12-prazo-recurso-v2.md") {
  const drafts = await dir(t, "instagram-slides-");
  const draftPath = path.join(drafts, draft);
  await writeFile(draftPath, "Legenda");
  await writeFile(slidesFile(draftPath), lines.join("\n"));
  return draftPath;
}

test("the slide list sits beside the draft", () => {
  assert.equal(slidesFile("/w/content/drafts/2026-10-12-x-v3.md"), "/w/content/drafts/2026-10-12-x-v3.slides.txt");
});

test("reads the slides in order, with their alt text, keeping slides of earlier versions", async t => {
  const draftPath = await draftWithSlides(t, [
    "2026-10-12-prazo-recurso-v1-1.jpg | Capa: Prazo da contestação",
    "",
    "  2026-10-12-prazo-recurso-v2-2.jpg|Slide 2: conte os dias a partir da nota  ",
    "2026-10-12-prazo-recurso-v1-3.jpg | Fechamento | salve para consultar"
  ]);
  assert.deepEqual(await readSlides(draftPath), [
    { name: "2026-10-12-prazo-recurso-v1-1.jpg", alt: "Capa: Prazo da contestação" },
    { name: "2026-10-12-prazo-recurso-v2-2.jpg", alt: "Slide 2: conte os dias a partir da nota" },
    { name: "2026-10-12-prazo-recurso-v1-3.jpg", alt: "Fechamento | salve para consultar" }
  ]);
});

test("refuses a slide list that is missing, empty, too long or malformed", async t => {
  const drafts = await dir(t, "instagram-noslides-");
  const lonely = path.join(drafts, "2026-10-12-x-v1.md");
  await writeFile(lonely, "Legenda");
  await assert.rejects(readSlides(lonely), /2026-10-12-x-v1\.slides\.txt is missing/);
  const name = k => `2026-10-12-prazo-recurso-v2-${k}.jpg | alt ${k}`;
  for (const [lines, message] of [
    [[], /1 to 10 slides; it names 0/],
    [Array.from({ length: 11 }, (_, i) => name((i % 10) + 1)), /1 to 10 slides; it names 11/],
    [["2026-10-12-prazo-recurso-v2-1.jpg"], /must be "<image file> \| <alt text>"/],
    [["2026-10-12-prazo-recurso-v2-1.jpg | "], /has no alt text/],
    [[`2026-10-12-prazo-recurso-v2-1.jpg | ${"a".repeat(MAX_ALT_TEXT + 1)}`], /1001 characters of alt text/],
    [[name(1), name(1)], /repeats/]
  ]) {
    await assert.rejects(readSlides(await draftWithSlides(t, lines)), message);
  }
});

test("a slide list that is a symlink is never read", { skip: process.platform === "win32" }, async t => {
  const drafts = await dir(t, "instagram-slidelink-");
  const draftPath = path.join(drafts, "2026-10-12-x-v1.md");
  await writeFile(draftPath, "Legenda");
  await writeFile(path.join(drafts, "elsewhere.txt"), "2026-10-12-x-v1-1.jpg | alt");
  await symlink(path.join(drafts, "elsewhere.txt"), slidesFile(draftPath));
  await assert.rejects(readSlides(draftPath), /2026-10-12-x-v1\.slides\.txt is missing/);
});

test("each slide must be an image of this post, from this version or an earlier one", async t => {
  for (const bad of [
    "2026-10-12-outro-post-v1-1.jpg", "2026-10-12-prazo-recurso-v3-1.jpg", "2026-10-12-prazo-recurso-v2-11.jpg",
    "2026-10-12-prazo-recurso-v2-0.jpg", "2026-10-12-prazo-recurso-v2.png", "2026-10-12-prazo-recurso-v2-1.png",
    "../../etc/passwd", "2026-10-12-prazo-recurso-v2-1.jpg---00000001-aaaa-bbbb-cccc-dddddddddddd.jpg"
  ]) {
    await assert.rejects(readSlides(await draftWithSlides(t, [`${bad} | alt`])), /is not an image of this post/, bad);
  }
});

async function imagesDir(t, files) {
  const created = await dir(t, "instagram-images-");
  for (const [name, content = jpeg, mtime] of files) {
    await writeFile(path.join(created, name), content);
    if (mtime) await utimes(path.join(created, name), mtime, mtime);
  }
  return created;
}

test("finds each slide among the generated images, the newest when there are two", async t => {
  const images = await imagesDir(t, [
    [`2026-10-12-x-v1-1---${uuid(1)}.jpg`, jpeg, new Date("2026-10-12T10:00:00Z")],
    [`2026-10-12-x-v1-1---${uuid(2)}.jpg`, jpeg, new Date("2026-10-12T11:00:00Z")],
    [`2026-10-12-x-v2-2---${uuid(3)}.jpeg`]
  ]);
  const found = await findSlideImages(images, [{ name: "2026-10-12-x-v1-1.jpg", alt: "a" }, { name: "2026-10-12-x-v2-2.jpg", alt: "b" }]);
  assert.deepEqual(found.map(image => [image.name, image.alt, path.basename(image.path)]), [
    ["2026-10-12-x-v1-1.jpg", "a", `2026-10-12-x-v1-1---${uuid(2)}.jpg`],
    ["2026-10-12-x-v2-2.jpg", "b", `2026-10-12-x-v2-2---${uuid(3)}.jpeg`]
  ]);
});

test("a slide whose image is missing, saved without the store's suffix, or of another slide is refused", async t => {
  const images = await imagesDir(t, [
    ["2026-10-12-x-v1-1.jpg"], [`2026-10-12-x-v1-10---${uuid(1)}.jpg`], [`2026-10-12-x-v1-1---${uuid(2)}.png`]
  ]);
  await assert.rejects(findSlideImages(images, [{ name: "2026-10-12-x-v1-1.jpg", alt: "a" }]), /slide 1 \(2026-10-12-x-v1-1\.jpg\) is not among/);
  await assert.rejects(findSlideImages(path.join(images, "missing"), [{ name: "2026-10-12-x-v1-1.jpg", alt: "a" }]), /is not among/);
});

test("a slide drawn from SVG in the drafts folder wins over a generated one, and the others still come from the store", async t => {
  const images = await imagesDir(t, [[`2026-10-12-x-v1-1---${uuid(1)}.jpg`], [`2026-10-12-x-v1-2---${uuid(2)}.jpg`]]);
  const drafts = await imagesDir(t, [["2026-10-12-x-v1-1.jpg"], ["2026-10-12-x-v1-1.svg", "<svg/>"]]);
  const found = await findSlideImages(images, [{ name: "2026-10-12-x-v1-1.jpg", alt: "a" }, { name: "2026-10-12-x-v1-2.jpg", alt: "b" }], drafts);
  assert.deepEqual(found.map(image => image.path), [path.join(drafts, "2026-10-12-x-v1-1.jpg"), path.join(images, `2026-10-12-x-v1-2---${uuid(2)}.jpg`)]);
  assert.equal(found[0].size, jpeg.length);
  await assert.rejects(findSlideImages(images, [{ name: "2026-10-12-x-v1-3.jpg", alt: "c" }], drafts),
    /slide 1 \(2026-10-12-x-v1-3\.jpg\) is not among the generated images or the slides drawn from SVG; generate it with image_generate, or render its SVG/);
});

test("a symlink in the drafts folder is never taken as a drawn slide", { skip: process.platform === "win32" }, async t => {
  const images = await imagesDir(t, [[`2026-10-12-x-v1-1---${uuid(1)}.jpg`]]);
  const drafts = await imagesDir(t, [["elsewhere.jpg"]]);
  await symlink(path.join(drafts, "elsewhere.jpg"), path.join(drafts, "2026-10-12-x-v1-1.jpg"));
  const [found] = await findSlideImages(images, [{ name: "2026-10-12-x-v1-1.jpg", alt: "a" }], drafts);
  assert.equal(found.path, path.join(images, `2026-10-12-x-v1-1---${uuid(1)}.jpg`));
});

test("a symlink is never taken as a slide", { skip: process.platform === "win32" }, async t => {
  const images = await imagesDir(t, [["target.jpg"]]);
  await symlink(path.join(images, "target.jpg"), path.join(images, `2026-10-12-x-v1-1---${uuid(1)}.jpg`));
  await assert.rejects(findSlideImages(images, [{ name: "2026-10-12-x-v1-1.jpg", alt: "a" }]), /is not among/);
});

test("reads JPEG content and refuses anything else or anything larger than 8 MB", async t => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const images = await imagesDir(t, [["a.jpg", jpeg], ["b.jpg", png]]);
  assert.deepEqual(await readJpeg({ path: path.join(images, "a.jpg"), name: "a.jpg", size: jpeg.length }, 1), jpeg);
  await assert.rejects(readJpeg({ path: path.join(images, "b.jpg"), name: "b.jpg", size: png.length }, 2), /slide 2 \(b\.jpg\) is not a JPEG/);
  await assert.rejects(readJpeg({ path: path.join(images, "a.jpg"), name: "a.jpg", size: 9 * 1024 * 1024 }, 3), /larger than 8 MB/);
});
