# SLIDES-SVG.md

When `image_generate` cannot make a post's slides, you write each slide as SVG and `render.mjs` draws it as a 1080x1080 JPEG with the brand's logo. The words, layouts, covers, pagination, alt text and every other rule of `SOUL.md` stay the same; only how the slide is drawn changes.

## When

- **A failure in this turn.** In step 1.7 or 2.3 of `AGENTS.md`, an `image_generate` call that fails with a usage or rate limit, a provider error or a failed sign-in ends image generation for that version: make no other call and write every slide of the version as SVG, including slides it already generated, so the carousel has one look. A slide that is only pending has not failed.
- **A failure in a background completion.** A completion cannot write files: it says which slide failed and ends with "Reply \"svg slides\" to draw the slides as SVG."
- **"svg slides".** Gabriel's reply writes the SVGs for the newest draft, as below.

Every slide its list names is then drawn from SVG. A revision's list that keeps slides of an earlier version cannot be changed: save the next version instead, with the same caption and a list whose every slide is named after it, and write all of them as SVG.

## Frame

- **Canvas.** Keep the reference's `<svg>` element (`viewBox="0 0 1080 1080"`) and its `<style>` block, and color and type everything through its classes. Its first shape, the full-canvas `<rect>`, stays first and is ivory, navy, green or copper, fully opaque, with no `opacity` or `transform`: the renderer refuses any other background, and any slide where the canvas shows through.
- **Logo.** The renderer draws the brand's logo at the top left, in x 135 to 395 on the cover and x 96 to 356 on the other slides, y 64 to 168, on an ivory badge when the background is green or copper. Keep that box empty, showing only the background: the renderer refuses a slide that draws in it. Never draw a logo, a mark or the brand's name as a wordmark yourself.
- **Page number.** "k/n" at the top right, right-aligned at x 945 on the cover and x 984 on the other slides, baseline 126, as in the references. A single-image post has none.
- **Margins.** 96 on every side. On the cover, every word stays between x 135 and x 945, the part the profile grid keeps; only background shapes reach the edges.
- **Backgrounds.** Middle slides on ivory, the last slide on navy with white text, and the cover *dark* (navy, white title), *light* (ivory, navy title) or *color* (green or copper, white title, no subtitle), rotating as `SOUL.md` says.

## Colors and type

- **Colors**, only these; the renderer refuses any other: ivory #F6F3EC, navy #12324A, graphite #1E2732, green #0F9D7A, copper #B8743C and white #FFFFFF. White cards with a radius of 24 to 28 on ivory; titles in navy; body text in graphite; what to do in green; risks and deadlines in copper. Soften text and shapes with `opacity` only (.6 to .85), never with another color, and never the background.
- **Fonts**, only these: Geist 700 for titles and big numbers and Geist 600 for card headers (classes `t-title` and `t-semi`); Inter 400 for body text and Inter 600 for labels, page numbers and the call to action (`t-body` and `t-bodyb`). Their family names are `Geist` and `Inter 18pt`.
- **Sizes.** Cover title 96 to 104 on two lines, cover subtitle 36 to 40; slide titles 60 to 68; body text 32 to 36; nothing under 26.

## Layouts

Each has a reference in `references/layouts/`: read it before writing yours, keep its frame, classes and proportions, and change the content. Their words are placeholders: never reuse them.

- *Cover* (`cover.svg`): the title, the optional subtitle and one large focal element from the content, drawn in shapes (a number of days, check marks, two columns, a question mark, a line icon).
- *Rule*, *Deadline* and *Myth or fact* (`rule.svg`): a pill naming the layout ("RULE", "DEADLINE", "MYTH OR FACT"), the rule in large type and a white note card with a colored bar. *Deadline* puts the number of days in Geist 700 at 200 to 240 in copper, with what it applies to under it; *Myth or fact* puts the claim in the pill's place and the answer, "Myth" in copper or "Fact" in green, in the card.
- *Checklist* and *Steps* (`list.svg`): three to five white rows, each a green check circle (a checklist) or a navy circle with the step's number in white Geist 600 (steps), and one line of text.
- *Comparison* (`comparison.svg`): two white cards, the risky or wrong side under a copper header and the right one under a green header.
- *Closing* (`closing.svg`): on navy, the summary in white and the call to action, exactly as `USER.md` gives it, in a green pill.

## Writing the SVG

- **Name.** `content/drafts/<slide>.svg`: the slide's planned name with `.svg` in place of `.jpg` (`YYYY-MM-DD-<slug>-v1-2.svg` for `YYYY-MM-DD-<slug>-v1-2.jpg`). The slide list stays as saved, with its `.jpg` names.
- **Plain SVG only.** No `<script>`, `<image>`, `<feImage>`, `<foreignObject>`, links to other files or web addresses. The renderer refuses them.
- **Text.** SVG never wraps text: break lines yourself, one `<text>` per line, spelled correctly. Write `&amp;` for &, `&lt;` for < and `&gt;` for >. Label a fictitious example on its slide.
- **Fit.** Before rendering, check that every line fits its space: a character takes about 0.6 × the font size in Geist 700 and 0.53 × in Inter. Nothing overlaps, and nothing enters the logo's box. The renderer refuses a drawing that runs past the canvas.

## Sending and rendering

Send the draft as in step 1.8 of `AGENTS.md`, but end with "OpenAI did not generate the images, so the slides were drawn as SVG. Reply \"image\" to see them." in place of the request for approval: Gabriel approves only slides he has seen.

When he answers "image", run exactly this, with the real file name, and wait for his `/approve` in Telegram:

```bash
/home/openclaw/.openclaw-social/social-openclaw/instagram/publisher/render.mjs content/drafts/<file>.slides.txt
```

- `"status": "rendered"`: send one `MEDIA:<media>` line for each entry of `slides`, in order, then "Reply ok to publish, or say what to change." The publisher posts exactly these JPEGs.
- `"status": "rejected"`: nothing was drawn. Write or fix the SVGs its `message` names and run it once more.
- Denied, or no answer: nothing was drawn. Say so.

A drawn slide is never redrawn: a change is the next version, with its changed slides as new SVGs, rendered with "image" again.
