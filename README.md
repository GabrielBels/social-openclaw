# Social OpenClaw

An OpenClaw Gateway for social media (`openclaw --profile social`), with two agents, each with its own dedicated Telegram bot. Both agents talk to Gabriel in English.

- **Pitch** (`linkedin`) runs Gabriel's LinkedIn. It researches AI and software engineering news, picks the best item and writes a short engineering note in English, in Gabriel's voice. The image is an SVG it draws in one of the fixed formats (diagram, illustration or screen), all in the same dark identity as Gabriel's article covers, and `render.mjs` turns it into a PNG. When Gabriel asks, it also draws an article cover, which Gabriel uploads to LinkedIn himself. The goal is technical authority across four pillars (AI-assisted engineering, backend/.NET/architecture, LLMs in production and a global engineering career) that opens doors in the US.
- **Showcase** (`instagram`) runs a brand's Instagram. It picks a topic from the brand's pillars, reads the primary source, generates the slides of a carousel (or a single image) in the brand colors and writes the caption in English. Every Instagram post is written in English. The brand, audience, pillars and call to action live in `instagram/workspace/USER.md`, a template to fill in before deploy; the logo and the reference image live in `instagram/publisher/brand/` and `instagram/workspace/brand/`.

Both send the finished post. Gabriel only approves it or asks for changes, and the post goes out through the network's official API after an approval that OpenClaw itself requires.

The Gateway has its own profile, secrets store and service, isolated from any other OpenClaw Gateway on the same machine. Neither agent has access to customer data or to data from inside a product.

## How a post moves

1. **Finished post.** At each agent's scheduled time (OpenClaw store), or when you send "new post" to its bot, the agent picks the topic, generates the images and writes the text. You receive the text exactly as it will go out, with pillar, format, source and file, followed by the images. On Instagram you also receive the words of each slide, to check the accents. On LinkedIn the image is an SVG that `render.mjs` turns into a PNG after you approve the command; the scheduled post runs no commands, so the image arrives when you reply "image". On Instagram, if `image_generate` fails (OpenAI down or at its usage limit), the agent writes the slides as SVG in the brand identity, and you see them when you reply "image" and approve the Instagram `render.mjs`.
2. **Changes.** "shorter", "another image", "swap slide 3" or any other change produces the next version, in a new `content/drafts/YYYY-MM-DD-<slug>-v<n>.md` file that is never overwritten, with new images only for what changed.
3. **Publishing.** You reply "ok". The agent runs the network's publisher with the exact file, and OpenClaw asks for your approval in Telegram with the file path. You reply `/approve <id> allow-once`. Denying or not replying publishes nothing.
   - **LinkedIn:** the publisher uploads the image through the Images API and publishes the post with it.
   - **Instagram:** the publisher checks that the token belongs to the expected account (`INSTAGRAM_USERNAME`), uploads each slide to a private Backblaze B2 bucket and generates a read link valid for one hour, restricted to the image's random name. Instagram fetches the images through those links, and the publisher creates the containers, publishes and deletes the versions uploaded to the bucket.
4. **Record.** The agent returns the post URL and writes date, pillar, format, topic, source and URL to `content/ledger.md` in its workspace.

## Security

- The permanent credentials are protected OpenClaw secrets, each bound to the hosts of its API: LinkedIn to `api.linkedin.com` and `www.linkedin.com`, Instagram to `graph.instagram.com`, B2 to `api.backblazeb2.com`. The code receives the `oc-sent-v2…` sentinel, and the Gateway's outbound proxy swaps it for the real value only on those hosts. The temporary tokens issued by B2 stay only in the publisher's memory, which validates the destinations and refuses redirects. Only the temporary image read access is sent to Meta; credentials reflected in errors are redacted before they reach the chat. Tokens do not appear in the chat, in files or in local logs. The two agents share the store, so every approved command receives the sentinels of all credentials; the host binding and `/approve` are the barriers.
- No operational parameter lives in the code: the IDs, each agent's schedule, the models, the search provider, the image model, the Instagram API version, the expected account and the B2 bucket are `env` entries of the store.
- **LinkedIn:** every 60 days you renew the token. First run `linkedin/scripts/auth.mjs url` in your terminal, open the link and paste the return address there. Then send "renew the token" to the LinkedIn bot and approve the exchange. The link and the code never pass through the agent or the chat.
- **Instagram:** the first token is generated in the Meta app and stored with `instagram/scripts/token.mjs store` in your terminal. Afterwards, send "renew the token" to the Instagram bot (before the 60 days) and approve `token.mjs refresh`, which swaps the token without passing through the chat.
- The agents only have web search and reading, files in their own workspace, `exec` and, on Instagram, image generation. **Every** command asks for your approval (`allow-once` or `deny`; there is no permanent approval). Each agent has only the intended commands: its publisher with a file from `content/drafts/`, its token command with no arguments and its `render.mjs`: on LinkedIn with an SVG from `content/drafts/`, on Instagram with a slide list (`.slides.txt`) from `content/drafts/`. Deny anything else.
- The publishers and scripts live outside the agents' workspaces, so the agents cannot change them.
- The agents run on OpenClaw's own runtime, with Code Mode off. The Codex harness is off, because its native tools would not go through `/approve`.
- The approvals registry has floors (`security`, `ask: always`, `askFallback: deny`) that not even a `/exec security=full ask=off` message can loosen.
- Scheduled jobs have no `exec`, and automation approvals never reach the chat. That is why publishing always starts with an "ok" from you in the conversation.
- Agents have no browser. No unofficial network skills.

## Documents

- Design: [LinkedIn](docs/plans/2026-10-07-linkedin-social-agent-design.md), [B2 storage](docs/plans/2026-10-15-instagram-backblaze-design.md) and [Instagram SVG slides](docs/plans/2026-11-05-instagram-svg-fallback-design.md)
- [Operations guide](docs/operations.md): setup, migration of the `linkedin` profile, deploy, tokens and troubleshooting

## Tests

```bash
npm ci
node --test
```

Needs Node ≥ 22.
