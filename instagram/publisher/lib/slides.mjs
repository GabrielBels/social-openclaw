import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DraftError } from "./draft.mjs";

// Instagram's limits: a carousel holds at most 10 images, alt text at most 1,000 characters, and an image at most 8 MB.
export const MAX_SLIDES = 10;
export const MAX_ALT_TEXT = 1000;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const draftName = /^(.+)-v([1-9][0-9]*)\.md$/;
// A slide is named after its post and the version that made it: `<date>-<slug>-v<m>-<k>.jpg`.
const slideName = /^(.+)-v([1-9][0-9]*)-([1-9]|10)\.jpg$/;
// OpenClaw's media store saves an image_generate result as `<requested name>---<uuid>.<ext>`.
const savedSuffix = /^---[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg)$/i;

function printable(text) {
  return String(text).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 80);
}

// A draft's slides: `<draft name>.slides.txt` beside it, one line per slide in carousel order,
// `<image file> | <alt text>`.
export function slidesFile(draftPath) {
  return draftPath.replace(/\.md$/, ".slides.txt");
}

// Each slide names an image of the same post made by this version or an earlier one, so a revision can keep the
// slides it did not change.
export async function readSlides(draftPath) {
  const draft = path.basename(draftPath).match(draftName);
  if (!draft) throw new DraftError("the draft name must end in -v<n>.md");
  const [, base, version] = draft;
  const listName = path.basename(slidesFile(draftPath));
  let text;
  try {
    // A regular file beside the draft, never a link that points elsewhere.
    if (!(await lstat(slidesFile(draftPath))).isFile()) throw new Error("not a regular file");
    text = await readFile(slidesFile(draftPath), "utf8");
  } catch {
    throw new DraftError(`the slide list ${listName} is missing`);
  }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_SLIDES) {
    throw new DraftError(`${listName} must name 1 to ${MAX_SLIDES} slides; it names ${lines.length}`);
  }
  const seen = new Set();
  return lines.map((line, index) => {
    const position = index + 1;
    const separator = line.indexOf("|");
    if (separator < 0) throw new DraftError(`slide ${position} in ${listName} must be "<image file> | <alt text>"`);
    const name = line.slice(0, separator).trim();
    const alt = line.slice(separator + 1).trim();
    const slide = name.match(slideName);
    if (!slide || slide[1] !== base || Number(slide[2]) > Number(version)) {
      throw new DraftError(`slide ${position} (${printable(name)}) is not an image of this post: ${base}-v<m>-<k>.jpg, with m up to ${version}`);
    }
    if (seen.has(name)) throw new DraftError(`slide ${position} repeats ${name}`);
    seen.add(name);
    if (alt === "") throw new DraftError(`slide ${position} (${name}) has no alt text`);
    if (alt.length > MAX_ALT_TEXT) throw new DraftError(`slide ${position} (${name}) has ${alt.length} characters of alt text; Instagram accepts at most ${MAX_ALT_TEXT}`);
    return { name, alt };
  });
}

// Each slide's image: the JPEG render.mjs drew from its SVG, under the slide's own name in the drafts folder, or else
// the image image_generate saved under that name, the newest of two.
export async function findSlideImages(imagesDir, slides, draftsDir) {
  let names;
  try {
    names = await readdir(imagesDir);
  } catch {
    names = [];
  }
  const images = [];
  for (const [index, slide] of slides.entries()) {
    if (draftsDir) {
      const drawn = path.join(draftsDir, slide.name);
      const info = await lstat(drawn).catch(() => null);
      if (info?.isFile()) {
        images.push({ ...slide, path: drawn, mtimeMs: info.mtimeMs, size: info.size });
        continue;
      }
    }
    const stem = slide.name.slice(0, -".jpg".length);
    let best = null;
    for (const name of names) {
      if (!name.startsWith(`${stem}---`) || !savedSuffix.test(name.slice(stem.length))) continue;
      const info = await lstat(path.join(imagesDir, name));
      if (!info.isFile()) continue;
      if (!best || info.mtimeMs > best.mtimeMs) best = { path: path.join(imagesDir, name), mtimeMs: info.mtimeMs, size: info.size };
    }
    if (!best) {
      throw new DraftError(`slide ${index + 1} (${slide.name}) is not among the generated images or the slides drawn from SVG; ` +
        "generate it with image_generate, or render its SVG");
    }
    images.push({ ...slide, ...best });
  }
  return images;
}

// Instagram publishes JPEG only; the content decides, not the file name.
export async function readJpeg(image, position) {
  if (image.size > MAX_IMAGE_BYTES) throw new DraftError(`slide ${position} (${image.name}) is larger than 8 MB, Instagram's limit`);
  const bytes = await readFile(image.path);
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    throw new DraftError(`slide ${position} (${image.name}) is not a JPEG; generate it again with outputFormat jpeg`);
  }
  return bytes;
}
