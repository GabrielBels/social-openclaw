#!/home/openclaw/.openclaw/tools/node/bin/node
// Draws a draft's SVG slides (SLIDES-SVG.md), the fallback for when image_generate cannot make them:
// render.mjs content/drafts/<file>.slides.txt
// For each slide the list names, `<slide>.svg` in content/drafts/ becomes `<slide>.jpg` beside it, with the logo. Every
// listed slide must have an SVG or a JPEG already drawn from one, so the carousel has one look and Gabriel sees all of
// it. Every SVG is checked and drawn before anything is written, so one bad slide leaves them all undrawn. An existing
// JPEG is never replaced: a changed slide is the next version, so the slides Gabriel approved are the ones that get
// posted.
// It prints one JSON line: each drawn slide's workspace path and full path, which the agent attaches to its reply
// (stdout, exit 0), or what to fix (stderr, exit 1).
// Like publish.mjs, it is installed outside the agent's workspace, and the workspace it reads is fixed.
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { SvgError } from "../../linkedin/publisher/lib/svg.mjs";
import { DraftError, resolveDraft } from "./lib/draft.mjs";
import { renderSlide } from "./lib/slide-svg.mjs";
import { readSlides } from "./lib/slides.mjs";

const defaultWorkspaceRoot = "/home/openclaw/.openclaw-social/workspace-instagram";
const usage = "usage: render.mjs <content/drafts/<file>.slides.txt>";

const regularFile = async file => (await lstat(file).catch(() => null))?.isFile() ?? false;

export async function run({
  argv = process.argv.slice(2),
  workspaceRoot = defaultWorkspaceRoot,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  try {
    if (argv.length !== 1 || typeof argv[0] !== "string" || !argv[0].endsWith(".slides.txt")) throw new DraftError(usage);
    // The list belongs to the draft beside it, which names the post and its version.
    const draftPath = await resolveDraft(workspaceRoot, argv[0].replace(/\.slides\.txt$/, ".md"));
    const drafts = path.dirname(draftPath);
    const slides = await readSlides(draftPath);
    const drawn = [];
    const pending = [];
    const missing = [];
    const problems = [];
    for (const [index, slide] of slides.entries()) {
      const jpegPath = path.join(drafts, slide.name);
      const svgPath = jpegPath.replace(/\.jpg$/, ".svg");
      if (await regularFile(jpegPath)) drawn.push({ position: index + 1, path: jpegPath });
      else if (await regularFile(svgPath)) {
        try {
          pending.push({ position: index + 1, path: jpegPath, bytes: renderSlide(await readFile(svgPath, "utf8"), { cover: index === 0 }) });
        } catch (error) {
          if (!(error instanceof SvgError)) throw error;
          problems.push(`slide ${index + 1} (${path.basename(svgPath)}): ${error.message}`);
        }
      } else missing.push(`${index + 1} (${path.basename(svgPath)})`);
    }
    if (missing.length > 0) {
      throw new SvgError(`nothing was rendered; these slides have no SVG in content/drafts/: ${missing.join(", ")}. ` +
        "Write every slide of the list as SLIDES-SVG.md says");
    }
    if (problems.length > 0) throw new SvgError(`nothing was rendered; fix ${problems.join("; ")}`);
    for (const slide of pending) {
      try {
        await writeFile(slide.path, slide.bytes, { flag: "wx" });
      } catch (error) {
        const name = path.basename(slide.path);
        if (error.code === "EEXIST") throw new SvgError(`${name} already exists; a changed slide is the next version`);
        throw new SvgError(`${name} could not be written (${error.code ?? "unknown error"}); the slides before it were drawn, run it once more`);
      }
    }
    const result = [...drawn, ...pending].sort((a, b) => a.position - b.position)
      .map(slide => ({ slide: slide.position, image: `content/drafts/${path.basename(slide.path)}`, media: slide.path }));
    stdout.write(`${JSON.stringify({ status: "rendered", rendered: pending.length, slides: result })}\n`);
    return 0;
  } catch (error) {
    const known = error instanceof DraftError || error instanceof SvgError;
    stderr.write(`${JSON.stringify({ status: "rejected", message: known ? error.message : "render failed unexpectedly" })}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run();
}
