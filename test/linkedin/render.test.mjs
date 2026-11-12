import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FONT_FAMILIES, checkSvg, renderSvg } from "../../linkedin/publisher/lib/svg.mjs";
import { run } from "../../linkedin/publisher/render.mjs";

const reference = readFileSync(new URL("../../linkedin/workspace/references/layouts/diagram.svg", import.meta.url), "utf8");
const cover = readFileSync(new URL("../../linkedin/workspace/references/layouts/cover.svg", import.meta.url), "utf8");
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800">${body}</svg>`;
const name = "2026-10-30-prompt-cache-v1";

async function workspace(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "linkedin-render-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "content", "drafts"), { recursive: true });
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, "content", "drafts", file), content);
  return root;
}

async function render(root, argv) {
  let out = "";
  let err = "";
  const code = await run({ argv, workspaceRoot: root, stdout: { write: text => { out += text; } }, stderr: { write: text => { err += text; } } });
  return { code, out: out && JSON.parse(out), err: err && JSON.parse(err) };
}

const drafts = async root => (await readdir(path.join(root, "content", "drafts"))).sort();

test("draws a draft's SVG as a 1536x1024 PNG next to it, and prints where it is", async t => {
  const root = await workspace(t, { [`${name}.svg`]: reference });
  const { code, out } = await render(root, [`content/drafts/${name}.svg`]);
  assert.equal(code, 0);
  const media = path.join(await realpath(path.join(root, "content", "drafts")), `${name}.png`);
  assert.deepEqual(out, { status: "rendered", image: `content/drafts/${name}.png`, media, width: 1536, height: 1024 });
  const png = await readFile(media);
  assert.ok(png.subarray(0, 8).equals(pngSignature));
  // A PNG's header holds its width and height as big-endian integers at bytes 16 and 20.
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1536, 1024]);
});

test("draws an article cover's 1280x720 SVG as a 1920x1080 PNG", async t => {
  const file = "2026-11-05-retry-keys-cover-v1";
  const root = await workspace(t, { [`${file}.svg`]: cover });
  const { code, out } = await render(root, [`content/drafts/${file}.svg`]);
  assert.equal(code, 0);
  assert.deepEqual([out.width, out.height], [1920, 1080]);
  const png = await readFile(out.media);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1920, 1080]);
});

test("refuses a cover drawing past its 1280x720 canvas, and takes one that only passes x 1200", () => {
  const coverSvg = body => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#0D1117"/>${body}</svg>`;
  assert.ok(renderSvg(coverSvg('<rect x="1200" y="10" width="60" height="20" fill="#3FB950"/>')).subarray(0, 8).equals(pngSignature));
  assert.throws(() => renderSvg(coverSvg('<rect x="1240" y="10" width="60" height="20" fill="#3FB950"/>')), /past the 1280x720 canvas/);
});

test("never replaces an image already drawn: a changed image is the next version", async t => {
  const root = await workspace(t, { [`${name}.svg`]: reference });
  assert.equal((await render(root, [`content/drafts/${name}.svg`])).code, 0);
  const first = await readFile(path.join(root, "content", "drafts", `${name}.png`));
  const again = await render(root, [`content/drafts/${name}.svg`]);
  assert.equal(again.code, 1);
  assert.equal(again.err.status, "rejected");
  assert.match(again.err.message, /already exists; a changed image is the next version/);
  assert.deepEqual(await readFile(path.join(root, "content", "drafts", `${name}.png`)), first);
});

test("refuses an SVG that breaks the house rules, says what to fix and draws nothing", async t => {
  const root = await workspace(t, { [`${name}.svg`]: svg('<rect width="10" height="10" fill="#FF0000"/><script>alert(1)</script>') });
  const { code, err } = await render(root, [`content/drafts/${name}.svg`]);
  assert.equal(code, 1);
  assert.equal(err.status, "rejected");
  assert.match(err.message, /^nothing was rendered; fix the SVG: /);
  assert.match(err.message, /<script>/);
  assert.match(err.message, /#FF0000 is not in the palette/);
  assert.deepEqual(await drafts(root), [`${name}.svg`]);
});

test("refuses SVG that is not well-formed, and draws nothing", async t => {
  const root = await workspace(t, { [`${name}.svg`]: svg('<rect width="1200" height="800" fill="#0D1117"/><rect') });
  const { code, err } = await render(root, [`content/drafts/${name}.svg`]);
  assert.equal(code, 1);
  assert.match(err.message, /could not be drawn/);
  assert.deepEqual(await drafts(root), [`${name}.svg`]);
});

test("refuses a drawing that runs past the canvas, which would come out cropped, and draws nothing", async t => {
  const longTitle = "A title far too long for one line, which runs well past the right edge of the canvas";
  const root = await workspace(t, {
    [`${name}.svg`]: svg(`<rect width="1200" height="800" fill="#0D1117"/><text x="64" y="100" font-size="60" fill="#F0F6FC">${longTitle}</text>`)
  });
  const { code, err } = await render(root, [`content/drafts/${name}.svg`]);
  assert.equal(code, 1);
  assert.match(err.message, /^something runs past the 1200x800 canvas \(it reaches \d+x800\); shorten or break the longest line/);
  assert.deepEqual(await drafts(root), [`${name}.svg`]);
});

test("takes exactly one .svg file directly under content/drafts/", async t => {
  const root = await workspace(t, { [`${name}.svg`]: reference, [`${name}.md`]: "post" });
  await writeFile(path.join(root, "outside-v1.svg"), reference);
  for (const [argv, message] of [
    [[], /^usage: render\.mjs/], [[`content/drafts/${name}.svg`, "--out"], /^usage: render\.mjs/],
    [[`content/drafts/${name}.md`], /must be a \.svg file/], [["content/drafts/missing-v1.svg"], /draft not found/],
    [["outside-v1.svg"], /directly under content\/drafts/], [["content/drafts/../../outside-v1.svg"], /directly under content\/drafts/]
  ]) {
    const { code, err } = await render(root, argv);
    assert.equal(code, 1, argv.join(" "));
    assert.match(err.message, message, argv.join(" "));
  }
  assert.deepEqual(await drafts(root), [`${name}.md`, `${name}.svg`]);
});

test("refuses a symlink in content/drafts/ that points outside it", { skip: process.platform === "win32" }, async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, "outside-v1.svg"), reference);
  await symlink(path.join(root, "outside-v1.svg"), path.join(root, "content", "drafts", `${name}.svg`));
  const { code, err } = await render(root, [`content/drafts/${name}.svg`]);
  assert.equal(code, 1);
  assert.match(err.message, /directly under content\/drafts/);
});

test("the checker accepts the house style and refuses whatever reaches outside the file", () => {
  assert.deepEqual(checkSvg(reference), []);
  assert.deepEqual(checkSvg(cover), []);
  assert.deepEqual(checkSvg(svg('<rect width="1200" height="800" fill="#0d1117" stroke="none"/><rect fill="url(#grid)"/><use href="#a"/>')), []);
  assert.deepEqual(checkSvg(svg('<style>.bg{fill:#0D1117}</style><rect width="100%" height="100%" class="bg"/>')), []);
  for (const [bad, problem] of [
    ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"></svg>', /viewBox="0 0 1200 800"/],
    ["<g/>", /no <svg> element/],
    [`<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${svg("<text>&x;</text>")}`, /DOCTYPE or an entity/],
    [svg("<script>fetch('https://example.com')</script>"), /<script>/],
    [svg('<image href="file:///etc/passwd"/>'), /<image>/],
    [svg("<foreignObject><div/></foreignObject>"), /<foreignObject>/],
    [svg('<use href="other.svg#a"/>'), /links outside the file \(other\.svg#a\)/],
    [svg('<a xlink:href="https://example.com"><text>x</text></a>'), /links outside the file/],
    // resvg draws a local image file from an absolute href, whatever the quoting or the prefix.
    [svg("<filter id=\"f\"><feImage href='/home/openclaw/photo.png'/></filter>"), /<feImage>/],
    [svg("<filter id=\"f\"><feImage href='/home/openclaw/photo.png'/></filter>"), /links outside the file \(\/home\/openclaw\/photo\.png\)/],
    // A prefix bound to the SVG or XLink namespace names the same element or attribute, ASCII or not.
    [svg('<s:image xmlns:s="http://www.w3.org/2000/svg" ü:href="/home/openclaw/photo.png"/>'), /<image>/],
    [svg('<s:image xmlns:s="http://www.w3.org/2000/svg" ü:href="/home/openclaw/photo.png"/>'), /links outside the file \(\/home\/openclaw\/photo\.png\)/],
    [svg('<g xmlns:ü="http://www.w3.org/1999/xlink"/>'), /namespace prefix other than xlink/],
    [svg("<x:script xmlns:x=\"http://www.w3.org/2000/svg\">alert(1)</x:script>"), /<script>/],
    [svg('<x:foreignObject/><x:feImage/>'), /<foreignObject>/],
    [svg('<x:foreignObject/><x:feImage/>'), /<feImage>/],
    [svg("<use href='other.svg#a'/>"), /links outside the file \(other\.svg#a\)/],
    [svg('<use xmlns:x="http://www.w3.org/1999/xlink" x:href="other.svg#a"/>'), /links outside the file \(other\.svg#a\)/],
    [svg('<use data-note=">" href="other.svg#a"/>'), /links outside the file \(other\.svg#a\)/],
    [svg('<rect filter="url(other.svg#f)"/>'), /links outside the file \(other\.svg#f\)/],
    [svg("<rect fill='#FF0000'/>"), /#FF0000 is not in the palette/],
    // The light house style the dark one replaced: an ivory canvas and its serif captions.
    [svg('<rect width="1200" height="800" fill="#F6F3EC"/>'), /#F6F3EC is not in the palette/],
    [svg("<text font-family='Source Serif 4'>x</text>"), /Source Serif 4 is not available/],
    // A light canvas painted with the text greys the palette keeps, by attribute, class or style, or no canvas at all.
    [svg('<rect width="1200" height="800" fill="#F0F6FC"/>'), /first shape that covers the canvas must be filled #0D1117/],
    [svg('<style>.bg{fill:#C9D1D9}</style><rect width="1200" height="800" class="bg"/>'), /must be filled #0D1117/],
    [svg('<rect width="1200" height="800" fill="#0D1117" style="fill:#F0F6FC"/>'), /must be filled #0D1117/],
    [svg('<text x="64" y="100">no canvas</text>'), /must start with a <rect width="1200" height="800"> filled #0D1117/],
    [svg("<rect style='stroke:red'/>"), /red is not in the palette/],
    [svg("<text font-family='Comic Sans MS'>x</text>"), /Comic Sans MS is not available/],
    [svg('<text data-note=">" fill="#FF0000">x</text>'), /#FF0000 is not in the palette/],
    [svg('<rect style="fill:url(https://example.com/a.png)"/>'), /links outside the file/],
    [svg("<style>@import url(https://example.com/a.css);</style>"), /@import/],
    [svg('<rect onload="alert(1)"/>'), /event attribute/],
    [svg('<rect fill="#FF0000"/>'), /#FF0000 is not in the palette/],
    [svg("<style>.a{stroke:red}</style>"), /red is not in the palette/],
    [svg('<text font-family="Comic Sans MS">x</text>'), /Comic Sans MS is not available/],
    [svg("<style>.a{font-family:'Inter', sans-serif}</style>"), /Inter is not available/],
    [svg(`<!--${"x".repeat(300 * 1024)}-->`), /larger than 256 KB/]
  ]) {
    assert.ok(checkSvg(bad).some(found => problem.test(found)), `${problem}: ${checkSvg(bad).join("; ")}`);
  }
});

test("each family and weight the references use draws with its own face, not a fallback", () => {
  const sample = (family, weight) => renderSvg(svg(
    `<rect width="1200" height="800" fill="#0D1117"/><text x="64" y="200" font-size="60" font-family="${family}" font-weight="${weight}" fill="#F0F6FC">TTL 5 MIN 12.5x</text>`
  ));
  const faces = [["Archivo", 700], ["IBM Plex Sans", 400], ["IBM Plex Sans", 600], ["IBM Plex Mono", 400], ["IBM Plex Mono SemiBold", 600]];
  const drawn = faces.map(([family, weight]) => sample(family, weight).toString("base64"));
  assert.equal(new Set(drawn).size, faces.length);
});

test("the bundled fonts cover every family the checker allows, with their licenses", () => {
  const fonts = readdirSync(new URL("../../linkedin/publisher/fonts/", import.meta.url));
  for (const family of FONT_FAMILIES) {
    assert.ok(fonts.some(file => file.replace("-", "").startsWith(family.replaceAll(" ", "")) && file.endsWith(".ttf")), family);
  }
  for (const license of ["OFL-IBMPlex.txt", "OFL-Archivo.txt"]) assert.ok(fonts.includes(license), license);
});
