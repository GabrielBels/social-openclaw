# Instagram SVG slide fallback

> Design date: 2026-11-05

## Overview

Instagram slides come from `image_generate`, whose only model is `SOCIAL_IMAGE_MODEL` (`openai/gpt-image-2`). When OpenAI is down or the ChatGPT account reaches its usage limit, a post arrives without slides and cannot be published. The fallback lets the agent write each slide as SVG in the brand's identity; a renderer outside the workspace draws it as a 1080x1080 JPEG with the official logo, and the publisher posts it like a generated slide. `image_generate` stays the primary path.

## Decisions

- **Fallback only.** The agent writes SVG slides only when `image_generate` fails for a post, or when Gabriel asks for them ("slides em svg").
- **One look per carousel.** Once the fallback starts, every slide of that version is written as SVG, including slides that `image_generate` did make, so a carousel never mixes the two styles.
- **JPEG through `jpeg-js` 0.4.4.** Instagram publishes JPEG only, resvg encodes PNG only, and the WSL host has no ffmpeg or ImageMagick. `jpeg-js` is pure JavaScript with no dependencies (76 KB, BSD-3-Clause). It has had no release since 2022; its known CVEs are in the decoder, fixed in 0.4.4, and only the encoder is used. Pinned exactly in `package.json` and the lockfile.
- **The renderer places the logo.** The agent's SVG still cannot contain `<image>` or any link, whatever the namespace prefix. After the checks pass, the renderer draws the slide, refuses it unless the canvas is fully opaque and the logo's box shows only one of the backgrounds, then draws the brand's logo (`instagram/publisher/brand/`) on its own and lays it over the pixels, so nothing in the agent's file can hide or move it. The agent only keeps that box clear.
- **Shared checks.** `linkedin/publisher/lib/svg.mjs` takes a style (canvases, palette, allowed backgrounds, font families and directory). The LinkedIn style stays its default, so LinkedIn's behavior and tests do not change; the Instagram renderer passes its own style.

## Style

- **Canvas:** `viewBox="0 0 1080 1080"`, drawn at 1080x1080.
- **Palette:** the colors of `SOUL.md` only: marfim #F6F3EC, azul #12324A, grafite #1E2732, verde #0F9D7A, cobre #B8743C and white #FFFFFF.
- **Background:** the first full-canvas `<rect>` is marfim, azul, verde or cobre, which covers the cover backgrounds *clara*, *escura* and *cor*, the azul closing slide and marfim middle slides.
- **Fonts:** Geist for titles and Inter for body text. The static TTF files and their OFL licenses live in `instagram/publisher/fonts/`; Inter's static files name their family `Inter 18pt`.
- **Logo box:** the top-left corner, y 64 to 168: x 135 to 395 on the cover, inside the central three quarters, and x 96 to 356 on the other slides, at their margin. The light or dark logo variant follows the background; on verde and cobre the light one sits on a marfim badge, since both colors are in the mark. The logos are the brand's own, cropped to their marks (`instagram/publisher/brand/README.md`).
- **Layouts:** one reference SVG per layout family under `instagram/workspace/references/layouts/`: capa, regra/prazo/mito ou fato, lista (checklist and passo a passo), comparação and fechamento. They encode the margins, the grid-crop zone, the pagination corner and the type sizes of `SOUL.md`.

## Flow

1. **Post (step 1.7 of the workspace `AGENTS.md`).** If an `image_generate` call fails in the parent turn (usage or rate limit, provider error, failed sign-in), the agent stops calling it for that post and writes `content/drafts/<slide stem>.svg` for every slide in the list. The slide list keeps its `.jpg` names. The message ends with "A OpenAI não gerou as imagens; os slides saíram em SVG. Responda \"imagem\" para vê-los." Step 1 still runs no command, scheduled runs included.
2. **Failure in a background completion.** A completion cannot write files, so it only reports that the slide failed and ends with "Responda \"slides em svg\" para fazer os slides em SVG." That reply writes the SVGs for the newest draft as in 1.
3. **"imagem".** The agent runs `instagram/publisher/render.mjs content/drafts/<draft>.slides.txt` and waits for `/approve`. Every listed slide must have an SVG or a JPEG already drawn from one; otherwise nothing is drawn and the message names the missing slides. The renderer checks and draws every slide that has an SVG and no JPEG, then writes the JPEGs to `content/drafts/` (never replacing a file); one bad SVG leaves them all undrawn. It prints one JSON line with each slide's `media` path, which the agent sends as `MEDIA:` lines, or `rejected` with what to fix.
4. **Adjust.** A changed slide is the next version's SVG (`…-v2-3.svg`), rendered with "imagem" as in 3.
5. **Publish.** `findSlideImages` takes a rendered JPEG in `content/drafts/` named exactly as the slide (a regular file, never a link) and otherwise the media store's `image_generate` result. The rest of publication is unchanged.

## Changes

- `linkedin/publisher/lib/svg.mjs`: style parameter, JPEG output through `jpeg-js` for the Instagram style, logo placement.
- `instagram/publisher/render.mjs` and `instagram/publisher/lib/slide-svg.mjs` (the style, the logo and the JPEG), `instagram/publisher/lib/slides.mjs` (rendered slides first), `instagram/publisher/fonts/`, `instagram/publisher/brand/`.
- `scripts/sync-wsl.ps1`: marks the Instagram renderer executable when the revision has it.
- `instagram/workspace/`: `SLIDES-SVG.md` (the style above and how to write the SVG), the reference layouts, the Fallback bullet in `SOUL.md` (a failed `image_generate`, the "imagem" and "slides em svg" requests, and changes to a version drawn as SVG), and in `AGENTS.md` the ground rule on commands and a pointer in step 2.3.
- `instagram/workspace/skills/instagram-publisher/SKILL.md`: its ban on other commands is scoped to publishing, as LinkedIn's is.
- `config/exec-approvals.json`: the Instagram allowlist adds `render.mjs` with `^content/drafts/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*-v[0-9]+[.]slides[.]txt$`.
- `package.json` and `package-lock.json`: `jpeg-js` 0.4.4.
- `docs/operations.md` (the Instagram section and the "post arrives without its images" row) and `README.md`.

## Testing

- `test/instagram/render.test.mjs`: a reference layout renders to a 1080x1080 JPEG with the logo; the renderer refuses `<image>`, links, scripts, colors, fonts and backgrounds outside the style and text past the canvas; it never replaces a JPEG; one bad slide leaves every slide unrendered; an argument outside `content/drafts/` or a link is refused.
- `test/instagram/slides.test.mjs`: a rendered slide wins over the media store; a link named as a slide is refused; a slide with neither still names `image_generate`.
- `test/instagram/workspace.test.mjs` and `test/config.test.mjs`: the fallback rules, the two requests and the allowlist entry.
- `test/linkedin/render.test.mjs` passes unchanged.
- The full suite runs once on Windows after the diff is frozen; the deploy runs it again in WSL.

## Acceptance Criteria

- [ ] With `image_generate` failing, a carousel draft arrives with SVG slides and the "imagem" instruction, and its scheduled run executes no command.
- [ ] "imagem" asks for one approval and delivers every slide as a 1080x1080 JPEG with the official logo.
- [ ] The publisher posts rendered slides with the existing approval, and a post made by `image_generate` publishes as before.
- [ ] LinkedIn's renderer output and tests are unchanged.

## Not Proven (verify first during implementation)

- Whether a usage-limit failure reaches the parent turn or only the background completion. Both paths are covered.
- That the agent follows `SLIDES-SVG.md` on a real failure, and the look of the slides it writes; the reference layouts were checked visually.
- A live publication of a `jpeg-js` JPEG on Instagram; checked on the first fallback post.

## Out of Scope

- Another image provider as `mediaModels.image` fallback.
- SVG as the primary slide path, and Reels.
