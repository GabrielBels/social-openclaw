import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

// The two canvases IMAGES.md names: a post image, saved at LinkedIn's 3:2 post size, and an article cover, saved at
// the 16:9 size LinkedIn recommends for covers. The viewBox tells them apart.
export const CANVASES = [
  { viewBox: "0 0 1200 800", width: 1536, height: 1024, name: "a post" },
  { viewBox: "0 0 1280 720", width: 1920, height: 1080, name: "an article cover" }
];
export const MAX_SVG_BYTES = 256 * 1024;
// The colors of IMAGES.md, in its order: the canvas, two panel shades, the line color, three greys for text, the accent
// green and its tint.
export const PALETTE = ["#0D1117", "#161B22", "#21262D", "#30363D", "#8B949E", "#C9D1D9", "#F0F6FC", "#3FB950", "#12261E"];
// The near-black canvas the whole identity rests on. The palette keeps light greys for text, so it is checked apart.
export const BACKGROUND = PALETTE[0];
// The families in fonts/; a name outside them would silently fall back to another face. IBM Plex Mono's 600 weight
// names itself "IBM Plex Mono SemiBold", so it is matched by that name only.
export const FONT_FAMILIES = ["Archivo", "IBM Plex Sans", "IBM Plex Mono", "IBM Plex Mono SemiBold"];

// What an image may use: its canvases, its colors, the colors its background may have (`backgroundNote` names them for
// the agent), its font families, the folder that holds those fonts, and the families generic names draw with.
// LinkedIn's style is the default; the Instagram renderer passes its own.
export const LINKEDIN_STYLE = {
  canvases: CANVASES,
  palette: PALETTE,
  backgrounds: [BACKGROUND],
  backgroundNote: "the near-black background",
  fontFamilies: FONT_FAMILIES,
  fontsDir: fileURLToPath(new URL("../fonts/", import.meta.url)),
  fonts: { defaultFontFamily: "IBM Plex Sans", sansSerifFamily: "IBM Plex Sans", serifFamily: "IBM Plex Sans", monospaceFamily: "IBM Plex Mono" }
};
const genericFamilies = ["sans-serif", "serif", "monospace"];
const colorWords = ["none", "currentcolor", "inherit"];

export class SvgError extends Error {}

// Attribute values may be quoted either way, and a quoted value may hold a `>`.
const tags = svg => [...svg.matchAll(/<[A-Za-z](?:[^>"']|"[^"]*"|'[^']*')*>/g)].map(match => match[0]);
const attributeValues = (text, names) =>
  [...text.matchAll(new RegExp(`\\s(?:${names})\\s*=\\s*(["'])(.*?)\\1`, "gi"))].map(match => match[2]);
const cssBlocks = svg => [
  ...[...svg.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]),
  ...tags(svg).flatMap(tag => attributeValues(tag, "style"))
];
const either = values => values.length === 1 ? values[0] : `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`;

function colorProblem(value, style) {
  const color = value.trim().replace(/\s*!important$/i, "");
  if (colorWords.includes(color.toLowerCase()) || /^url\(\s*#[^)]+\)$/.test(color)) return null;
  if (style.palette.includes(color.toUpperCase())) return null;
  return `the color ${color} is not in the palette (${style.palette.join(", ")})`;
}

function fontProblem(value, style) {
  const names = value.split(",").map(name => name.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const unknown = names.filter(name => !style.fontFamilies.includes(name) && !genericFamilies.includes(name));
  return unknown.length === 0 ? null : `the font ${unknown.join(", ")} is not available (${style.fontFamilies.join(", ")})`;
}

// The fill a tag ends up with, as CSS decides it: its style attribute, then the last <style> rule among its classes,
// then its fill attribute.
function effectiveFill(svg, tag) {
  const style = attributeValues(tag, "style").map(css => css.match(/(?<![\w-])fill\s*:\s*([^;]+)/i)?.[1]).find(Boolean);
  if (style) return style;
  const classes = (attributeValues(tag, "class")[0] ?? "").split(/\s+/).filter(Boolean);
  let fromClass;
  for (const [, selectors, block] of [...svg.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .flatMap(match => [...match[1].matchAll(/([^{}]+)\{([^}]*)\}/g)])) {
    const fill = block.match(/(?<![\w-])fill\s*:\s*([^;]+)/i)?.[1];
    if (fill && selectors.split(",").some(selector => classes.includes(selector.trim().replace(/^\./, "")))) fromClass = fill;
  }
  return fromClass ?? attributeValues(tag, "fill")[0];
}

// The first shape that covers the canvas, and the fill it ends up with (upper case), or undefined when there is none.
function backgroundShape(svg, canvas) {
  const [, , width, height] = canvas.viewBox.split(" ");
  const covers = (tag, name, size) => [size, "100%"].includes(attributeValues(tag, name)[0]?.trim());
  const atOrigin = (tag, name) => Number(attributeValues(tag, name)[0] ?? 0) === 0;
  const shape = tags(svg).find(tag => /^<rect\b/i.test(tag) && covers(tag, "width", width) && covers(tag, "height", height) &&
    atOrigin(tag, "x") && atOrigin(tag, "y"));
  return shape && { fill: effectiveFill(svg, shape)?.trim().replace(/\s*!important$/i, "").toUpperCase() };
}

// Every image starts with a shape that covers its canvas in one of the style's backgrounds, so no image can come out
// on another canvas.
function backgroundProblem(svg, canvas, style) {
  const [, , width, height] = canvas.viewBox.split(" ");
  const shape = backgroundShape(svg, canvas);
  if (!shape) return `the image must start with a <rect width="${width}" height="${height}"> filled ${either(style.backgrounds)}`;
  return style.backgrounds.includes(shape.fill) ? null
    : `the first shape that covers the canvas must be filled ${either(style.backgrounds)}, ${style.backgroundNote}`;
}

// The canvas an SVG's root element names, or undefined when it names none of the style's.
export function canvasOf(svg, style = LINKEDIN_STYLE) {
  const root = svg.match(/<svg\b[^>]*>/);
  return root ? style.canvases.find(canvas => root[0].includes(`viewBox="${canvas.viewBox}"`)) : undefined;
}

// The background color (upper case) an SVG declares: the fill of its first full-canvas shape.
export function backgroundOf(svg, style = LINKEDIN_STYLE) {
  const canvas = canvasOf(svg, style);
  return canvas && backgroundShape(svg, canvas)?.fill;
}

// What the renderer refuses before drawing: anything that reaches outside the file (scripts, images, links, entities),
// a canvas, a background, colors or fonts outside the style. Returns the problems, empty when none. resvg draws any
// image file an absolute link names, so this check is what keeps the image inside the SVG.
export function checkSvg(svg, style = LINKEDIN_STYLE) {
  const problems = new Set();
  if (Buffer.byteLength(svg) > MAX_SVG_BYTES) problems.add(`the SVG is larger than ${MAX_SVG_BYTES / 1024} KB`);
  const canvas = canvasOf(svg, style);
  if (!/<svg\b[^>]*>/.test(svg)) problems.add("there is no <svg> element");
  else if (!canvas) {
    problems.add(`the <svg> element must have ${style.canvases.map(c => `viewBox="${c.viewBox}" (${c.name})`).join(" or ")}`);
  } else {
    const problem = backgroundProblem(svg, canvas, style);
    if (problem) problems.add(problem);
  }
  // Elements are matched whatever their namespace prefix (`<s:image>` is an <image> when `s` names the SVG
  // namespace), and no prefix but `xlink` may be declared.
  for (const [pattern, what] of [
    [/<!DOCTYPE|<!ENTITY/i, "a DOCTYPE or an entity"], [/<(?:[^\s/>:]+:)?script\b/i, "a <script>"],
    [/<(?:[^\s/>:]+:)?foreignObject\b/i, "a <foreignObject>"], [/<(?:[^\s/>:]+:)?image\b/i, "an <image>"],
    [/<(?:[^\s/>:]+:)?feImage\b/i, "an <feImage>"], [/@import/i, "an @import"],
    [/\sxmlns:(?!xlink\s*=)/i, "a namespace prefix other than xlink"]
  ]) {
    if (pattern.test(svg)) problems.add(`it contains ${what}`);
  }
  // Any quoting and any namespace prefix (`href`, `xlink:href`, `é:href`), and `url(…)` in attributes or CSS.
  for (const [, , value] of svg.matchAll(/[\s"'](?:[^\s"'=<>:]+:)?href\s*=\s*(["'])(.*?)\1/gi)) {
    if (!value.startsWith("#")) problems.add(`it links outside the file (${value})`);
  }
  for (const [, value] of svg.matchAll(/url\(\s*["']?([^)"']*)/gi)) {
    if (!value.startsWith("#")) problems.add(`it links outside the file (${value})`);
  }
  for (const tag of tags(svg)) {
    if (/\son[a-z]+\s*=/i.test(tag)) problems.add("it contains an event attribute");
    for (const value of attributeValues(tag, "fill|stroke|stop-color|flood-color|lighting-color|color")) {
      const problem = colorProblem(value, style);
      if (problem) problems.add(problem);
    }
    for (const value of attributeValues(tag, "font-family")) {
      const problem = fontProblem(value, style);
      if (problem) problems.add(problem);
    }
  }
  for (const css of cssBlocks(svg)) {
    for (const [, value] of css.matchAll(/(?<![\w-])(?:fill|stroke|stop-color|flood-color|lighting-color|color)\s*:\s*([^;}]+)/gi)) {
      const problem = colorProblem(value, style);
      if (problem) problems.add(problem);
    }
    for (const [, value] of css.matchAll(/(?<![\w-])font-family\s*:\s*([^;}]+)/gi)) {
      const problem = fontProblem(value, style);
      if (problem) problems.add(problem);
    }
  }
  return [...problems];
}

// Draws a checked SVG at its canvas's size, with the style's bundled fonts only, so it looks the same on every machine.
// A drawing that runs past the canvas, usually a line of text longer than its space, would come out cropped.
export function drawSvg(svg, style = LINKEDIN_STYLE) {
  const canvas = canvasOf(svg, style);
  if (!canvas) throw new SvgError(`the <svg> element names no canvas of the style (${style.canvases.map(c => c.viewBox).join(", ")})`);
  let names = [];
  try {
    names = readdirSync(style.fontsDir);
  } catch { /* reported below */ }
  const fontFiles = names.filter(name => name.endsWith(".ttf")).map(name => path.join(style.fontsDir, name));
  if (fontFiles.length === 0) throw new SvgError(`no fonts in ${style.fontsDir}; the image would have no text`);
  let resvg;
  try {
    resvg = new Resvg(svg, { fitTo: { mode: "width", value: canvas.width }, font: { loadSystemFonts: false, fontFiles, ...style.fonts } });
  } catch (error) {
    throw new SvgError(`the SVG could not be drawn: ${error.message}`);
  }
  // In viewBox units, whatever fitTo scales the output to.
  const [, , canvasWidth, canvasHeight] = canvas.viewBox.split(" ").map(Number);
  const box = resvg.getBBox();
  if (box && (box.x < 0 || box.y < 0 || box.x + box.width > canvasWidth || box.y + box.height > canvasHeight)) {
    throw new SvgError(`something runs past the ${canvasWidth}x${canvasHeight} canvas (it reaches ${Math.round(box.x + box.width)}x` +
      `${Math.round(box.y + box.height)}); shorten or break the longest line, or move it inside`);
  }
  const image = resvg.render();
  if (image.width !== canvas.width || image.height !== canvas.height) {
    throw new SvgError(`the image came out ${image.width}x${image.height}, not ${canvas.width}x${canvas.height}`);
  }
  return image;
}

// A checked SVG drawn as a PNG.
export function renderSvg(svg, style = LINKEDIN_STYLE) {
  return drawSvg(svg, style).asPng();
}
