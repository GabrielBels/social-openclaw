# Weekly editorial procedure

## Calendar and identity

The single scheduled job starts Monday, Wednesday and Friday at 09:00 America/Sao_Paulo. Use the scheduled calendar date in that timezone, not UTC or the order in which runs happened:

| Day | Execution | Default format |
|---|---|---|
| Monday | 1 | carousel-educational |
| Wednesday | 2 | carousel-practical |
| Friday | 3 | carousel-educational |

The week is its Monday date. The execution identity is `<week>-<1|2|3>`, for example `2026-10-19-1`. Friday 2026-10-16 is `2026-10-12-3`; a missed Monday never turns Friday into execution 1. A preview can name a planned execution date explicitly. No other identity exists: an extra post has none (see Extra post).

The default format is a suggestion, not a rule. When Gabriel asks for another format (educational or practical carousel) on an execution day, use it for that execution under the same identity; for a carousel without a type, choose educational or practical. Never refuse a format because of the weekday.

Read `content/ledger.md`, `content/editorial/<week>.json` and the brand facts `USER.md` names before choosing content. Plan the three complementary topics together. Consult at least the last 30 days of both published and planned content. Do not recycle recently used advice under a different title.

## Extra post

A post Gabriel asks for on a day without an execution (Tuesday, Thursday or the weekend), or after that day's execution is published, is an extra post:

- It is a carousel or a single image.
- Date the draft with the day of the request. Save no `.editorial.json` for any of its versions, and leave the weekly records unchanged. In the review message, write "Extra post" where the execution ID goes.
- The publisher identifies it by the draft's file name, so it refuses only the same file twice. Before publishing, check the ledger: if it already lists this extra post, give its URL and do not publish again.
- After publication, its ledger line is its only record.

## Weekly record

Use one JSON record per week. Preserve existing executions and fields when updating it:

```json
{
  "week": "2026-10-19",
  "executions": [{
    "id": "2026-10-19-1", "date": "2026-10-19", "slot": 1,
    "format": "carousel-educational", "cover": "light", "topic": "A concrete operational problem",
    "status": "planned", "sources": [], "draft": null,
    "files": [], "publishedUrl": null, "pending": []
  }]
}
```

Statuses are `planned`, `generating`, `awaiting_review`, `published`, `not_posted` and `unknown`. `awaiting_review` is an editorial review state, not proof that every asynchronous image has finished. Keep the slide index as the authoritative mapping from numbered logical JPEG names to provider-generated images. Files include the caption, slide index, editorial metadata and numbered image names. Record sources by document/section, date and URL when available.

On rerun, reuse the same execution and its saved draft, version and artifacts. Never restart image generation while a task is pending. Use its existing image-generation status/receipt to resume missing work. A complete saved carousel is resent for review without generating it again. A published record returns its URL and does not request publication. An uncertain publication stops for manual Instagram verification. Adjustments create a new version under the same execution identity.

## Sources and editorial direction

Teach what to compare, why a difference matters and the next action. Prefer the brand facts `USER.md` names, with their limitations. Documentation proves documented behavior only. Read the primary source in full for any regulatory, legal or industry requirement; name the authority, rule, date, scope and exceptions. If no primary source confirms the rule, choose another topic.

Never present a forecast as a result, a promise as a guarantee or a pending step as done. Do not claim results, savings or features not backed by the brand's sources. Use only expressly labeled fictitious examples, such as "Fictitious example, illustrative values"; fictitious values are not product results or client evidence.

## Carousel delivery

Produce 4–6 slides: a concrete question/problem, one main idea per slide, an applicable example/checklist/sequence and the call to action. Use `brand/reference.png` as an image reference in every generation call; preserve its logo, palette and geometric sans-serif typography, never its composition. Read `brand/README.md`. Never generate a software interface or imitate a screenshot.

Choose the cover background following Covers in `SOUL.md` and save it as the execution's `cover` (`dark`, `light` or `color`). Plan the week's carousels with different covers.

Save the complete caption, slide list and `<draft-stem>.editorial.json` before generation. The metadata contains `executionId` and the execution's exact `format`. Save the weekly record with the draft, planned numbered image filenames and `awaiting_review` status before invoking asynchronous generation. Each revision retains the same executionId. Queue every distinct slide request in the parent turn, using a batch tool call if available. A pending task only prevents repeating that same slide; background completion cannot generate remaining slides or update files.

End the caption and the last slide with exactly the call to action in `USER.md`. Hashtags follow the caption CTA. Check spelling, small-screen readability and image numbering. Deliver caption, source list, per-slide alt text and numbered final images. Until all images arrive, describe them as generating, not complete. Do not publish from this routine.
