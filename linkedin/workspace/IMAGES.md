# IMAGES.md

Every image you make follows this one style, whatever its format, so posts and article covers read as one author when they sit side by side on Gabriel's profile: the dark, editorial look of his article covers. You write each image as SVG and `render.mjs` draws it as a PNG: a post image at 1536x1024, an article cover at 1920x1080. It shows the mechanism, the comparison, the number or the evidence behind the post at a glance; the text makes the argument (`SOUL.md`).

## Look

A near-black canvas, a large bold white headline at the top left that states the result or the claim, a short grey subtitle under it, and one dark artifact below it: a diagram, a dashboard panel, a window with a terminal, a diff or a pull request, or a line illustration. One accent color, green, on one or two things only. Flat, high contrast and readable as a small thumbnail. Never light backgrounds, pastel colors, gradients, glows, shadows, 3D or emoji icons, icon sets, hand-drawn sketches, colorful cartoons, people, robots, mascots, machines and gears, logos or brand marks.

- **Colors**, only these; the renderer refuses any other.
  - #0D1117 the canvas, with a faint 64-unit grid drawn in #161B22.
  - #161B22 panels, cards and windows; #21262D a window's title bar or a raised part; #30363D borders, dividers and secondary lines.
  - #F0F6FC the headline and the main labels; #C9D1D9 the subtitle, body text and the lines of a diagram or an illustration; #8B949E secondary text, metadata and whatever is muted (the old way, what fails, what waits).
  - #3FB950 the accent, with #12261E as its fill: the key node, the result, the fix or the number that matters. At most two accented elements besides the headline's bar and small status dots; everything else stays grey.
- **Fonts**, only these: Archivo 700 for the headline and big numbers; IBM Plex Sans 400 for the subtitle and body text and 600 for labels that name things; IBM Plex Mono 400 and IBM Plex Mono SemiBold (its 600 weight, by that name) for code, terminals, file names and small uppercase metadata.

## Frame

The same on every image; only the artifact changes. On a post (1200x800 canvas):

- the accent bar, a #3FB950 rectangle 6 wide at x 64, beside the headline from y 70 to 202;
- the headline at x 92, Archivo 700 at 60, one or two lines with baselines at 118 and 188;
- the subtitle at x 92 with its baseline at 244, IBM Plex Sans 24 in #C9D1D9, one line;
- the artifact between y 286 and 696, across the width (x 64 to 1136);
- the footer with its baseline at 736: "G. BELISARIO" on the left and "SOURCE: <SOURCE NAME>" on the right, IBM Plex Mono 13 in #8B949E, uppercase and letter-spaced.

An article cover (1280x720 canvas) keeps the frame with more air and no footer, since the article shows its author: the bar at x 96, the headline at x 126 at 64 with baselines at 136 and 210, the subtitle at 268, an optional pill with a green dot and the topics or sources, and the artifact between y 380 and 656.

## Text

English, short and exact. The headline carries the result or the claim, never the topic: at most ten words on two lines, each line at most 30 characters. The subtitle says how or why in at most twelve words. Labels have at most five words, notes at most twelve, and an image has no more than 20 pieces of text in all (a line of code counts as one). Sentence case everywhere except the small mono metadata, which is uppercase.

## Formats

Pick the one that fits the content. Never use the format of the post before (the ledger's Format column). Each has a reference in `references/layouts/`: read it before writing yours, keep its frame, classes and proportions, and change the artifact and the content.

- *Diagram* (`diagram.svg`): for mechanisms, flows, architecture, decisions and numbers. Nodes are #161B22 panels with a #30363D border and a radius of 12; edges are thin #C9D1D9 lines (1.5 wide) with small arrowheads; the key node is filled #12261E and outlined #3FB950. Numbers use the same panels: flat bars outlined in #30363D, each with its value in mono at its end and the bar that matters in the accent, or a dashboard panel with a before row, an after row and the result in a green pill, as in `cover.svg`.
- *Illustration* (`illustration.svg`): for an idea that is faster to see as a scene or a metaphor than as a flow. Flat line art in the dark palette: #C9D1D9 strokes 2 to 3 wide, #161B22 and #21262D fills, and the accent only on one light source and the object it lights. Pick a metaphor that fits this post (an object, a place, a tool, a queue) and never the one of the post before; at most three short mono labels.
- *Screen* (`screen.svg`): for what a terminal, a diff, a pull request, a log or a dashboard shows. A dark window, with a #21262D title bar, three #30363D dots and a short mono title, holds a faithful recreation of the screen in the palette: only the lines that matter, with their real texts and values from the source, removed lines in #8B949E after a "-", added lines in #C9D1D9 after a "+", and the line or the fix that matters in the accent. Never names, emails, tokens, internal hosts or anything private. A screenshot Gabriel sends is recreated the same way, never embedded.
- *Article cover* (`cover.svg`, 1280x720): only when Gabriel asks for one (below). The headline is the article's result or claim, the subtitle its subject, the pill its topics, and the artifact one terminal, diff or dashboard panel that backs the headline, built like the formats above.

## Article cover

When Gabriel asks for a cover for one of his articles ("cover", "article cover"), use the title or claim he gives; if he gives neither, ask for it. Use only facts he gave or the article states. Name it `content/drafts/YYYY-MM-DD-<slug>-cover-v1.svg` (the next version for each change), render it as in step 1.7 of `AGENTS.md` and send it with a `MEDIA:<media>` line. A cover has no `.md` draft and is never published: Gabriel uploads it to the article himself.

## Writing the SVG

- **Canvas.** Keep the reference's `<svg>` element (`viewBox="0 0 1200 800"` for a post, `viewBox="0 0 1280 720"` for a cover) and its `<style>` block, and color and type everything through its classes. Its first shape, the full-canvas `<rect>` in #0D1117, stays first: the renderer refuses any other background. Plain SVG only: no `<script>`, `<image>`, `<feImage>`, `<foreignObject>`, links to other files or web addresses. The renderer refuses them.
- **Text.** SVG never wraps text: break lines yourself, one `<text>` per line. Write `&amp;` for &, `&lt;` for < and `&gt;` for >.
- **Fit.** Keep 64 units of margin on every side. Before rendering, check that every line fits its space: a character takes about 0.55 × the font size in IBM Plex Sans and Archivo, and 0.6 × in IBM Plex Mono. Nothing overlaps, and every label clears the mark it names. The renderer refuses a drawing that runs past the canvas.
- **Data.** Numbers only from the sources. Compute every bar and point from one scale, and write each value next to its mark.
