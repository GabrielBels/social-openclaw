import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import { SvgError, backgroundOf, checkSvg, drawSvg } from "../../../linkedin/publisher/lib/svg.mjs";

// The slide style of SLIDES-SVG.md, the fallback for when image_generate cannot make a post's slides: a square drawn
// at 1080x1080, SOUL.md's colors, Geist and Inter.
export const SLIDE = { viewBox: "0 0 1080 1080", width: 1080, height: 1080, name: "a slide" };
// Marfim, azul, grafite, verde, cobre and white.
export const PALETTE = ["#F6F3EC", "#12324A", "#1E2732", "#0F9D7A", "#B8743C", "#FFFFFF"];
// A slide's background: marfim (*clara* covers and middle slides), azul (*escura* covers and the closing slide), verde
// or cobre (*cor* covers).
export const BACKGROUNDS = ["#F6F3EC", "#12324A", "#0F9D7A", "#B8743C"];
// Inter's static fonts name their family "Inter 18pt".
export const FONT_FAMILIES = ["Geist", "Inter 18pt"];
export const STYLE = {
  canvases: [SLIDE],
  palette: PALETTE,
  backgrounds: BACKGROUNDS,
  backgroundNote: "the marfim, azul, verde or cobre of SLIDES-SVG.md",
  fontFamilies: FONT_FAMILIES,
  fontsDir: fileURLToPath(new URL("../fonts/", import.meta.url)),
  fonts: { defaultFontFamily: "Inter 18pt", sansSerifFamily: "Inter 18pt", serifFamily: "Inter 18pt", monospaceFamily: "Inter 18pt" }
};
// The corner the agent keeps clear for the logo, top left at the slide's margin: 96 on every slide but the cover, whose
// words and logo stay inside the central three quarters of the width that the profile grid keeps.
export const LOGO_BOX = { x: 96, y: 64, width: 260, height: 104 };
export const COVER_LOGO_BOX = { ...LOGO_BOX, x: 135 };
const LOGO_WIDTH = 220;
const BADGE_PADDING = 20;
const brand = file => fileURLToPath(new URL(`../brand/${file}`, import.meta.url));

// The official logo, cropped to its marks: navy wordmark for light backgrounds, white wordmark for dark ones.
function logo(file) {
  const png = readFileSync(brand(file));
  // A PNG's header holds its width and height as big-endian integers at bytes 16 and 20.
  const height = LOGO_WIDTH * png.readUInt32BE(20) / png.readUInt32BE(16);
  return { href: `data:image/png;base64,${png.toString("base64")}`, height };
}

// The logo, drawn on its own and laid over the slide after the checks, so nothing in the agent's SVG (a link, a style
// rule, a comment) can reach it. It sits at the left of its box: the dark variant on azul, and on verde or cobre, whose
// colors are in the mark, the light variant on a marfim badge that fills the box.
export function logoFragment(background, { cover = false } = {}) {
  const dark = background === "#12324A";
  const badge = background === "#0F9D7A" || background === "#B8743C";
  const { href, height } = logo(dark ? "logo-dark.png" : "logo-light.png");
  const { x, y, width, height: boxHeight } = cover ? COVER_LOGO_BOX : LOGO_BOX;
  const left = badge ? x + BADGE_PADDING : x;
  const top = y + (boxHeight - height) / 2;
  return (badge ? `<rect x="${x}" y="${y}" width="${width}" height="${boxHeight}" rx="18" fill="#F6F3EC"/>` : "") +
    `<image x="${left}" y="${top.toFixed(1)}" width="${LOGO_WIDTH}" height="${height.toFixed(1)}" href="${href}"/>`;
}

// What the renderer refuses in a slide's SVG; empty when none.
export function checkSlide(svg) {
  return checkSvg(svg, STYLE);
}

const rgb = color => [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16));

// Whether the drawn slide shows the background it declares in the logo's box, which the agent keeps empty: the box's
// corners and centre. A style rule that repaints the background, or a shape in the box, fails it.
function showsBackground(pixels, background, { x, y, width, height }) {
  const expected = rgb(background).join(",");
  return [[x + 4, y + 4], [x + width - 5, y + 4], [x + 4, y + height - 5], [x + width - 5, y + height - 5], [x + width / 2, y + height / 2]]
    .every(([px, py]) => {
      const at = (Math.round(py) * SLIDE.width + Math.round(px)) * 4;
      return pixels.subarray(at, at + 3).join(",") === expected;
    });
}

// Draws a checked slide with the logo as a JPEG, the only image format Instagram publishes. The cover is the first slide.
export function renderSlide(svg, { cover = false } = {}) {
  const problems = checkSlide(svg);
  if (problems.length > 0) throw new SvgError(problems.join("; "));
  const image = drawSvg(svg, STYLE);
  // resvg's pixels are premultiplied RGBA; each read of `pixels` makes a copy.
  const pixels = image.pixels;
  // JPEG has no alpha: a background with opacity, a transform or a gap would come out grey or black.
  for (let at = 3; at < pixels.length; at += 4) {
    if (pixels[at] !== 255) throw new SvgError("the background must cover the whole canvas, fully opaque: no opacity, transform or gap on it");
  }
  const box = cover ? COVER_LOGO_BOX : LOGO_BOX;
  // checkSlide accepted the declared background, so it is one of BACKGROUNDS.
  const background = backgroundOf(svg, STYLE);
  if (!showsBackground(pixels, background, box)) {
    throw new SvgError(`the logo's box (x ${box.x} to ${box.x + box.width}, y ${box.y} to ${box.y + box.height}) must show only the ` +
      `background, ${background}: keep it empty, and paint the background only through its first <rect>`);
  }
  const logo = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${SLIDE.viewBox}">${logoFragment(background, { cover })}</svg>`,
    { fitTo: { mode: "width", value: SLIDE.width } }).render().pixels;
  // Premultiplied "over": slide = logo + slide × (1 − logo alpha).
  for (let at = 0; at < pixels.length; at += 4) {
    const alpha = logo[at + 3];
    if (alpha === 0) continue;
    for (let channel = at; channel < at + 3; channel++) pixels[channel] = Math.round(logo[channel] + pixels[channel] * (255 - alpha) / 255);
  }
  return jpeg.encode({ data: pixels, width: image.width, height: image.height }, 90).data;
}
