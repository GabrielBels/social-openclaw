import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PublishError } from "./linkedin-post.mjs";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// render.mjs saves a post's image next to its draft as `<date>-<slug>-v<n>.png`.
const renderedName = /^(.+)-v([1-9][0-9]*)\.(png)$/;
// OpenClaw's media store saves an image_generate result as `<requested name>---<uuid>.<ext>`.
const savedName = /^(.+)-v([1-9][0-9]*)---[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g)$/i;
const draftName = /^(.+)-v([1-9][0-9]*)\.md$/;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A post's image carries its draft's name (`<date>-<slug>-v<n>.png`): rendered next to the draft, or made by
// image_generate in OpenClaw's media folder. A version without its own image reuses the newest image of an earlier
// version of the same post; a post with no image at all goes out as text only.
export async function findDraftImage(imagesDir, draftPath) {
  const draft = path.basename(draftPath).match(draftName);
  if (!draft) return null;
  const [, base, version] = draft;
  let best = null;
  for (const [dir, pattern] of [[path.dirname(draftPath), renderedName], [imagesDir, savedName]]) {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const saved = name.match(pattern);
      if (!saved || saved[1] !== base || Number(saved[2]) > Number(version)) continue;
      const info = await lstat(path.join(dir, name));
      if (!info.isFile()) continue;
      const candidate = {
        path: path.join(dir, name), name: `${saved[1]}-v${saved[2]}.${saved[3].toLowerCase()}`,
        version: Number(saved[2]), mtimeMs: info.mtimeMs, size: info.size
      };
      if (!best || candidate.version > best.version || (candidate.version === best.version && candidate.mtimeMs > best.mtimeMs)) {
        best = candidate;
      }
    }
  }
  return best;
}

// LinkedIn takes PNG and JPEG images; the content decides, not the file name.
export async function readImage(image) {
  if (image.size > MAX_IMAGE_BYTES) throw new PublishError(`the image ${image.name} is larger than 10 MB. Nothing was posted.`);
  const bytes = await readFile(image.path);
  const png = bytes.subarray(0, pngSignature.length).equals(pngSignature);
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!png && !jpeg) throw new PublishError(`the image ${image.name} is not a PNG or JPEG file. Nothing was posted.`);
  return bytes;
}
