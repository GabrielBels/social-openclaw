import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import jpeg from "jpeg-js";
import { BACKGROUNDS, FONT_FAMILIES, PALETTE, checkSlide, renderSlide } from "../../instagram/publisher/lib/slide-svg.mjs";
import { run } from "../../instagram/publisher/render.mjs";

const layouts = ["cover", "rule", "list", "comparison", "closing"];
const reference = name => readFileSync(new URL(`../../instagram/workspace/references/layouts/${name}.svg`, import.meta.url), "utf8");
const svg = (body, background = "#F6F3EC") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080"><rect width="1080" height="1080" fill="${background}"/>${body}</svg>`;
const post = "2026-10-12-appeal-deadline";
const isJpeg = bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
// The color of one pixel of a JPEG, as [r, g, b].
const pixel = (bytes, x, y) => {
  const image = jpeg.decode(bytes, { useTArray: true });
  const at = (y * image.width + x) * 4;
  return [image.data[at], image.data[at + 1], image.data[at + 2]];
};
const near = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) <= 12);
const hex = color => [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16));

async function workspace(t, { slides = [`${post}-v1-1.jpg | Cover`, `${post}-v1-2.jpg | Rule`], files = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "instagram-render-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "content", "drafts"), { recursive: true });
  await writeFile(path.join(root, "content", "drafts", `${post}-v1.md`), "Caption");
  await writeFile(path.join(root, "content", "drafts", `${post}-v1.slides.txt`), slides.join("\n"));
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, "content", "drafts", file), content);
  return root;
}

async function render(root, argv = [`content/drafts/${post}-v1.slides.txt`]) {
  let out = "";
  let err = "";
  const code = await run({ argv, workspaceRoot: root, stdout: { write: text => { out += text; } }, stderr: { write: text => { err += text; } } });
  return { code, out: out && JSON.parse(out), err: err && JSON.parse(err) };
}

const drafts = async root => (await readdir(path.join(root, "content", "drafts"))).sort();

test("every reference layout passes the checker and draws as a 1080x1080 JPEG", () => {
  for (const name of layouts) {
    assert.deepEqual(checkSlide(reference(name)), [], name);
    const bytes = renderSlide(reference(name), { cover: name === "cover" });
    assert.ok(isJpeg(bytes), name);
    const image = jpeg.decode(bytes);
    assert.deepEqual([image.width, image.height], [1080, 1080], name);
  }
});

test("draws each listed slide's SVG as a JPEG beside it, and prints them in carousel order", async t => {
  const root = await workspace(t, { files: { [`${post}-v1-1.svg`]: reference("cover"), [`${post}-v1-2.svg`]: reference("rule") } });
  const { code, out } = await render(root);
  assert.equal(code, 0);
  const dir = await realpath(path.join(root, "content", "drafts"));
  assert.deepEqual(out, {
    status: "rendered", rendered: 2, slides: [
      { slide: 1, image: `content/drafts/${post}-v1-1.jpg`, media: path.join(dir, `${post}-v1-1.jpg`) },
      { slide: 2, image: `content/drafts/${post}-v1-2.jpg`, media: path.join(dir, `${post}-v1-2.jpg`) }
    ]
  });
  for (const slide of out.slides) assert.ok(isJpeg(await readFile(slide.media)));
});

test("the renderer adds the logo: on the cover inside the grid crop, elsewhere at the margin, on a badge over green or copper", () => {
  // A pixel left of the cover's logo box stays background; the box's first column is logo or badge.
  const ivory = hex("#F6F3EC");
  const plain = renderSlide(svg(""), { cover: true });
  assert.ok(near(pixel(plain, 110, 116), ivory));
  const slide = renderSlide(svg(""));
  const cover = renderSlide(svg(""), { cover: true });
  assert.ok(!slide.equals(cover), "the logo moves with the margin");
  for (const background of ["#0F9D7A", "#B8743C"]) {
    const badge = renderSlide(svg("", background), { cover: true });
    assert.ok(near(pixel(badge, 140, 70), ivory), background);
    assert.ok(near(pixel(badge, 120, 70), hex(background)), background);
  }
  const navy = renderSlide(svg("", "#12324A"), { cover: true });
  assert.ok(near(pixel(navy, 140, 70), hex("#12324A")), "no badge on navy");
});

test("the agent's SVG cannot hide or move the logo: it is laid over the drawn slide", () => {
  const plain = renderSlide(svg("", "#12324A"));
  assert.deepEqual(renderSlide(svg("<style>image{display:none}</style>", "#12324A")), plain);
  assert.deepEqual(renderSlide(`${svg("", "#12324A")}<!-- </svg> -->`), plain);
  // The logo's box differs from plain navy because the logo is in it.
  const image = jpeg.decode(plain, { useTArray: true });
  let changed = 0;
  for (let y = 64; y < 168; y++) for (let x = 96; x < 356; x++) {
    const at = (y * 1080 + x) * 4;
    if (!near([image.data[at], image.data[at + 1], image.data[at + 2]], hex("#12324A"))) changed++;
  }
  assert.ok(changed > 1000, `the logo is drawn (${changed} pixels)`);
});

test("the drawn background must be opaque and in a house color, with the logo's box left empty", () => {
  const canvas = attributes => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080"><rect width="1080" height="1080" ${attributes}/></svg>`;
  for (const [bad, problem] of [
    [canvas('fill="#F6F3EC" opacity=".6"'), /fully opaque/],
    [canvas('fill="#F6F3EC" transform="scale(.5)"'), /fully opaque/],
    [svg("<style>rect{fill:#1E2732}</style>"), /the logo's box \(x 96 to 356, y 64 to 168\) must show only the background/],
    [svg('<rect x="96" y="64" width="260" height="104" fill="#12324A"/>'), /keep it empty/]
  ]) {
    assert.deepEqual(checkSlide(bad), [], "the markup alone passes");
    assert.throws(() => renderSlide(bad), problem);
  }
});

test("every listed slide needs an SVG or a JPEG already drawn from one, so the carousel has one look", async t => {
  const mixed = await workspace(t, { files: { [`${post}-v1-2.svg`]: reference("rule") } });
  const { code, err } = await render(mixed);
  assert.equal(code, 1);
  assert.match(err.message, /^nothing was rendered; these slides have no SVG in content\/drafts\/: 1 \(2026-10-12-appeal-deadline-v1-1\.svg\)\. /);
  assert.deepEqual(await drafts(mixed), [`${post}-v1-2.svg`, `${post}-v1.md`, `${post}-v1.slides.txt`]);
  const none = await render(await workspace(t));
  assert.match(none.err.message, /1 \(2026-10-12-appeal-deadline-v1-1\.svg\), 2 \(2026-10-12-appeal-deadline-v1-2\.svg\)/);
  // A revision keeps the slides an earlier version drew and draws only its own.
  const revision = await workspace(t, {
    slides: [`${post}-v1-1.jpg | Cover`, `${post}-v1-2.jpg | Rule`],
    files: { [`${post}-v1-1.jpg`]: renderSlide(reference("cover"), { cover: true }), [`${post}-v1-2.svg`]: reference("rule") }
  });
  const kept = await render(revision);
  assert.equal(kept.code, 0, JSON.stringify(kept.err));
  assert.equal(kept.out.rendered, 1);
});

test("one bad slide leaves every slide undrawn, and the message names each problem", async t => {
  const root = await workspace(t, {
    files: { [`${post}-v1-1.svg`]: reference("cover"), [`${post}-v1-2.svg`]: svg('<image href="/home/openclaw/x.png"/><text fill="#FF0000">x</text>') }
  });
  const { code, err } = await render(root);
  assert.equal(code, 1);
  assert.equal(err.status, "rejected");
  assert.match(err.message, /^nothing was rendered; fix slide 2 \(2026-10-12-appeal-deadline-v1-2\.svg\): /);
  assert.match(err.message, /an <image>/);
  assert.match(err.message, /#FF0000 is not in the palette/);
  assert.deepEqual(await drafts(root), [`${post}-v1-1.svg`, `${post}-v1-2.svg`, `${post}-v1.md`, `${post}-v1.slides.txt`]);
});

test("a drawn slide is never redrawn: running again reports it, and a changed slide is the next version", async t => {
  const root = await workspace(t, { files: { [`${post}-v1-1.svg`]: reference("cover"), [`${post}-v1-2.svg`]: reference("rule") } });
  assert.equal((await render(root)).code, 0);
  const first = await readFile(path.join(root, "content", "drafts", `${post}-v1-1.jpg`));
  await writeFile(path.join(root, "content", "drafts", `${post}-v1-1.svg`), reference("list"));
  const again = await render(root);
  assert.equal(again.code, 0);
  assert.equal(again.out.rendered, 0);
  assert.deepEqual(again.out.slides.map(slide => slide.slide), [1, 2]);
  assert.deepEqual(await readFile(path.join(root, "content", "drafts", `${post}-v1-1.jpg`)), first);
});

test("refuses a drawing past the canvas, a canvas or background outside the style, and fonts it does not bundle", () => {
  assert.throws(() => renderSlide(svg('<text x="96" y="400" font-size="90" font-family="Geist">A title far too long to fit on a single line</text>')),
    /past the 1080x1080 canvas/);
  for (const [bad, problem] of [
    ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800"></svg>', /viewBox="0 0 1080 1080" \(a slide\)/],
    [svg("", "#1E2732"), /must be filled #F6F3EC, #12324A, #0F9D7A or #B8743C/],
    [svg("", "#0D1117"), /#0D1117 is not in the palette/],
    [svg("<text font-family='IBM Plex Sans'>x</text>"), /IBM Plex Sans is not available \(Geist, Inter 18pt\)/],
    [svg('<use href="other.svg#a"/>'), /links outside the file/],
    [svg("<script>alert(1)</script>"), /<script>/],
    // A namespace prefix, ASCII or not, names the same element and attribute to resvg.
    [svg('<s:image xmlns:s="http://www.w3.org/2000/svg" xmlns:\u00e9="http://www.w3.org/1999/xlink" \u00e9:href="/home/openclaw/x.png"/>'), /<image>/],
    [svg('<s:image xmlns:s="http://www.w3.org/2000/svg" xmlns:\u00e9="http://www.w3.org/1999/xlink" \u00e9:href="/home/openclaw/x.png"/>'), /links outside the file/]
  ]) {
    assert.ok(checkSlide(bad).some(found => problem.test(found)), `${problem}: ${checkSlide(bad).join("; ")}`);
  }
  assert.deepEqual(BACKGROUNDS.filter(color => !PALETTE.includes(color)), []);
});

test("takes exactly one slide list directly under content/drafts/, beside its draft", async t => {
  const root = await workspace(t, { files: { [`${post}-v1-1.svg`]: reference("cover") } });
  await writeFile(path.join(root, "outside-v1.slides.txt"), `${post}-v1-1.jpg | Cover`);
  for (const [argv, message] of [
    [[], /^usage: render\.mjs/], [[`content/drafts/${post}-v1.slides.txt`, "--out"], /^usage: render\.mjs/],
    [[`content/drafts/${post}-v1.md`], /^usage: render\.mjs/], [[`content/drafts/${post}-v1-1.svg`], /^usage: render\.mjs/],
    [["content/drafts/2026-10-12-missing-v1.slides.txt"], /draft not found/],
    [["outside-v1.slides.txt"], /draft not found|directly under content\/drafts/],
    [[`content/drafts/../../${post}-v1.slides.txt`], /draft not found|directly under content\/drafts/]
  ]) {
    const { code, err } = await render(root, argv);
    assert.equal(code, 1, argv.join(" "));
    assert.match(err.message, message, argv.join(" "));
  }
  assert.deepEqual(await drafts(root), [`${post}-v1-1.svg`, `${post}-v1.md`, `${post}-v1.slides.txt`]);
});

test("an SVG or a JPEG that is a symlink is never drawn or counted", { skip: process.platform === "win32" }, async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, "elsewhere.svg"), reference("cover"));
  await symlink(path.join(root, "elsewhere.svg"), path.join(root, "content", "drafts", `${post}-v1-1.svg`));
  await writeFile(path.join(root, "elsewhere.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  await symlink(path.join(root, "elsewhere.jpg"), path.join(root, "content", "drafts", `${post}-v1-2.jpg`));
  const { code, err } = await render(root);
  assert.equal(code, 1);
  assert.match(err.message, /these slides have no SVG in content\/drafts\/: 1 \(2026-10-12-appeal-deadline-v1-1\.svg\), 2 \(2026-10-12-appeal-deadline-v1-2\.svg\)/);
});

test("each family and weight the references use draws with its own face, not a fallback", () => {
  const sample = (family, weight) => renderSlide(svg(
    `<text x="96" y="600" font-size="60" font-family="${family}" font-weight="${weight}" fill="#1E2732">Deadline 30 days action</text>`
  ));
  const faces = [["Geist", 700], ["Geist", 600], ["Inter 18pt", 400], ["Inter 18pt", 600]];
  assert.equal(new Set(faces.map(([family, weight]) => sample(family, weight).toString("base64"))).size, faces.length);
});

test("the bundled fonts cover every family the checker allows, with their licenses, and both logos are there", () => {
  const fonts = readdirSync(new URL("../../instagram/publisher/fonts/", import.meta.url));
  for (const family of FONT_FAMILIES) {
    assert.ok(fonts.some(file => file.replaceAll("_", " ").startsWith(family) && file.endsWith(".ttf")), family);
  }
  for (const license of ["OFL-Geist.txt", "OFL-Inter.txt"]) assert.ok(fonts.includes(license), license);
  const brand = readdirSync(new URL("../../instagram/publisher/brand/", import.meta.url));
  for (const logo of ["logo-light.png", "logo-dark.png"]) assert.ok(brand.includes(logo), logo);
});
