#!/home/openclaw/.openclaw/tools/node/bin/node
// Draws one image from the SVG the agent wrote, as a PNG next to it: a post's image, which publish.mjs posts with its
// draft, or an article cover, which Gabriel uploads himself:
// render.mjs content/drafts/<file>.svg
// It prints one JSON line: the PNG's workspace path and its full path, which the agent attaches to its reply
// (stdout, exit 0), or what to fix (stderr, exit 1). An existing PNG is never replaced: a changed image is the next
// version, so the image Gabriel approved is the one that gets posted.
// Like publish.mjs, it is installed outside the agent's workspace, and the workspace it reads is fixed.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DraftError, resolveDraft } from "./lib/draft.mjs";
import { SvgError, canvasOf, checkSvg, renderSvg } from "./lib/svg.mjs";

const defaultWorkspaceRoot = "/home/openclaw/.openclaw-social/workspace-linkedin";
const usage = "usage: render.mjs <content/drafts/<file>.svg>";

export async function run({
  argv = process.argv.slice(2),
  workspaceRoot = defaultWorkspaceRoot,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  try {
    if (argv.length !== 1) throw new DraftError(usage);
    const svgPath = await resolveDraft(workspaceRoot, argv[0], { extension: ".svg", usage });
    const svg = await readFile(svgPath, "utf8");
    const problems = checkSvg(svg);
    if (problems.length > 0) throw new SvgError(`nothing was rendered; fix the SVG: ${problems.join("; ")}`);
    const png = renderSvg(svg);
    const pngPath = svgPath.replace(/\.svg$/, ".png");
    try {
      await writeFile(pngPath, png, { flag: "wx" });
    } catch (error) {
      if (error.code === "EEXIST") throw new SvgError(`${path.basename(pngPath)} already exists; a changed image is the next version`);
      throw error;
    }
    const image = `content/drafts/${path.basename(pngPath)}`;
    const { width, height } = canvasOf(svg);
    stdout.write(`${JSON.stringify({ status: "rendered", image, media: pngPath, width, height })}\n`);
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
