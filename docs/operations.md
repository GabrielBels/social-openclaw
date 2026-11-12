# Operations guide

How to set up, deploy and run the social Gateway and its two agents, `linkedin` and `instagram`. Start with the [README](../README.md); the reasons behind each choice are in the designs ([LinkedIn](plans/2026-10-07-linkedin-social-agent-design.md), [B2 storage](plans/2026-10-15-instagram-backblaze-design.md), [Instagram SVG slides](plans/2026-11-05-instagram-svg-fallback-design.md)). Before the first deploy, fill in `instagram/workspace/USER.md` and add the brand's `instagram/workspace/brand/reference.png` and logos in `instagram/publisher/brand/`.

## Environment

| What | Where |
|---|---|
| WSL distribution and user | `OpenClawGateway`, user `openclaw` |
| OpenClaw | `2026.9.8`, a CLI that other Gateways on the host may share |
| Profile | `social`: every command is `openclaw --profile social …` |
| Agents | `linkedin` (Pitch), `instagram` (Showcase) and `main` (inert: OpenClaw will not delete it) |
| State dir and config | `~/.openclaw-social/`, `~/.openclaw-social/openclaw.json` |
| Agent workspaces | `~/.openclaw-social/workspace-linkedin`, `~/.openclaw-social/workspace-instagram` |
| Installed repo copy (publishers, token scripts, tests) | `~/.openclaw-social/social-openclaw`, outside both workspaces |
| Telegram | one bot per agent: the LinkedIn bot (account `linkedin`) and the Instagram bot (account `instagram`) |
| Service | `openclaw-gateway-social.service` (systemd user unit) |
| Gateway port | `18289`, loopback only (the fleet uses `18789`; the old `linkedin` profile used `18489`) |
| Node | `/home/openclaw/.openclaw/tools/node/bin/node` (the bundled one) |

The fleet Gateway (`openclaw-gateway.service`, `~/.openclaw/`) is never touched by anything here.

**OpenClaw store entries.** Every operator value and parameter lives here; none is kept in code, files or Git. `env` entries are readable and reach exec as variables; protected (`secret`) entries are write-only and reach exec only as sentinels, substituted by the egress proxy for their allowed hosts.

| Scope | Entry | Kind |
|---|---|---|
| Gateway | `SOCIAL_GATEWAY_TOKEN` | secret, no host: the Gateway's own access token |
| Gateway | `SOCIAL_TELEGRAM_USER_ID` | env: Gabriel's numeric Telegram id, for both bots |
| Gateway | `SOCIAL_WEB_SEARCH_PROVIDER`, `SOCIAL_IMAGE_MODEL`, `SOCIAL_IMAGE_RESPONSES_MODEL` | env |
| LinkedIn | `LINKEDIN_TELEGRAM_BOT_TOKEN` | secret, `api.telegram.org` |
| LinkedIn | `LINKEDIN_MODEL`, `LINKEDIN_FALLBACK_MODEL`, `LINKEDIN_THINKING`, `LINKEDIN_SCOUT_CRON`, `LINKEDIN_SCOUT_TZ` | env |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_REDIRECT_URI`, `LINKEDIN_API_VERSION` | env |
| LinkedIn | `LINKEDIN_CLIENT_SECRET` | secret, `www.linkedin.com`, stored form-encoded by its helper |
| LinkedIn | `LINKEDIN_ACCESS_TOKEN` | secret, `api.linkedin.com` and `www.linkedin.com` |
| Instagram | `INSTAGRAM_TELEGRAM_BOT_TOKEN` | secret, `api.telegram.org` |
| Instagram | `INSTAGRAM_MODEL`, `INSTAGRAM_FALLBACK_MODEL`, `INSTAGRAM_THINKING`, `INSTAGRAM_POST_CRON`, `INSTAGRAM_POST_TZ` | env |
| Instagram | `INSTAGRAM_USERNAME`, `INSTAGRAM_API_VERSION` | env |
| Instagram | `INSTAGRAM_ACCESS_TOKEN` | secret, `graph.instagram.com` |
| Instagram | `INSTAGRAM_B2_BUCKET_ID`, `INSTAGRAM_B2_BUCKET_NAME` | env |
| Instagram | `INSTAGRAM_B2_BASIC_AUTH` | secret, `api.backblazeb2.com`, complete Basic header stored by the operator helper |

The two agents share this store: every approved command receives the sentinels of every secret above. A stored credential is usable only on its own hosts, and only by a command Gabriel approved. B2 authorization and upload tokens stay only in the trusted publisher's process memory; the publisher validates the B2 destinations and refuses redirects before sending them.

## Setup (operator only)

These steps create accounts and handle credentials, so Gabriel does them himself, in a WSL terminal (`wsl -d OpenClawGateway -u openclaw`). Never paste a token or secret into a chat, an AI session or a file. Where a step says "type it at the prompt", run the command, type or paste the value, then press `Enter` and `Ctrl-D`.

The setup runs in three phases. While the first one runs, the old `linkedin` profile keeps working; the Telegram bot of the LinkedIn agent moves to the new Gateway in phase 2.

### Phase 1: the new profile, next to the old one

1. Create the profile and its service:

   ```bash
   openclaw --profile social setup --baseline
   openclaw --profile social config set gateway.port 18289
   openclaw --profile social config set gateway.bind loopback
   openclaw --profile social config set browser.enabled false
   openclaw --profile social config validate
   openclaw --profile social gateway install --port 18289
   ```

2. Give the Gateway its own access token as a protected secret (a new random value, never printed). The first deploy points `gateway.auth.token` at it:

   ```bash
   openssl rand -hex 32 | openclaw --profile social secrets store set SOCIAL_GATEWAY_TOKEN --kind secret --value-file -
   ```

3. Install the web search plugin and store the shared values. Parallel Search (Free) needs no key and answers through an API; DuckDuckGo answered with a bot challenge after a few runs. Choose the provider only through this entry, never in the dashboard's **Settings → Search**: the deploy owns `tools` and would undo it. With the OpenAI sign-in of phase 2, `openai/gpt-image-2` needs no key. On that ChatGPT sign-in, `image_generate` draws through a Codex responses model: OpenClaw's default first, then `SOCIAL_IMAGE_RESPONSES_MODEL` when the account does not offer the default. It must be an `openai/<model>` id that `openclaw --profile social models list --agent instagram --all` lists for the sign-in:

   ```bash
   openclaw --profile social plugins install clawhub:@openclaw/parallel-plugin
   openclaw --profile social secrets store set SOCIAL_WEB_SEARCH_PROVIDER --kind env --value 'parallel-free'
   openclaw --profile social secrets store set SOCIAL_IMAGE_MODEL --kind env --value 'openai/gpt-image-2'
   openclaw --profile social secrets store set SOCIAL_IMAGE_RESPONSES_MODEL --kind env --value 'openai/<model>'
   openclaw --profile social secrets store set SOCIAL_TELEGRAM_USER_ID --kind env --value '<your numeric Telegram id>'
   ```

4. Store each agent's model, its Claude fallback model, thinking level and schedule. `openclaw --profile linkedin models list --agent linkedin --all` lists the model ids the sign-in can use, and `--provider anthropic` the Claude ones; the fallback must be an `anthropic/<model>` id, which runs on the Anthropic API key of phase 2. The level is one of OpenClaw's `thinkingDefault` values (`low`, `medium`, `high`, …) and applies to both models. For the LinkedIn post on Monday and Thursday at 09:30 and the Instagram post on Monday, Wednesday and Friday at 09:00, in São Paulo:

   ```bash
   openclaw --profile social secrets store set LINKEDIN_MODEL --kind env --value '<provider/model>'
   openclaw --profile social secrets store set LINKEDIN_FALLBACK_MODEL --kind env --value 'anthropic/<model>'
   openclaw --profile social secrets store set LINKEDIN_THINKING --kind env --value '<level>'
   openclaw --profile social secrets store set LINKEDIN_SCOUT_CRON --kind env --value '30 9 * * 1,4'
   openclaw --profile social secrets store set LINKEDIN_SCOUT_TZ --kind env --value 'America/Sao_Paulo'
   openclaw --profile social secrets store set INSTAGRAM_MODEL --kind env --value '<provider/model>'
   openclaw --profile social secrets store set INSTAGRAM_FALLBACK_MODEL --kind env --value 'anthropic/<model>'
   openclaw --profile social secrets store set INSTAGRAM_THINKING --kind env --value '<level>'
   openclaw --profile social secrets store set INSTAGRAM_POST_CRON --kind env --value '0 9 * * 1,3,5'
   openclaw --profile social secrets store set INSTAGRAM_POST_TZ --kind env --value 'America/Sao_Paulo'
   ```

5. Copy the LinkedIn values that are not secret from the old profile's store, each with its own value:

   ```bash
   openclaw --profile linkedin secrets store get LINKEDIN_CLIENT_ID --json
   openclaw --profile social secrets store set LINKEDIN_CLIENT_ID --kind env --value '<value>'
   ```

   Do the same for `LINKEDIN_REDIRECT_URI` and `LINKEDIN_API_VERSION`.

6. The Telegram bots. Keep the LinkedIn bot: in `@BotFather`, `/mybots`, pick it, **API Token**. Create the Instagram bot with `/newbot`. Store each token as a protected secret by typing it at the prompt; the config points each Telegram account at its own entry, so neither is ever plaintext in `openclaw.json`:

   ```bash
   openclaw --profile social secrets store set LINKEDIN_TELEGRAM_BOT_TOKEN --kind secret --allow-host api.telegram.org --value-file -
   openclaw --profile social secrets store set INSTAGRAM_TELEGRAM_BOT_TOKEN --kind secret --allow-host api.telegram.org --value-file -
   ```

   Storing the LinkedIn bot's token does not move the bot yet: the new Gateway polls it only after the first deploy.

7. The Instagram values (see [Instagram](#instagram) below for where each comes from): `INSTAGRAM_USERNAME`, `INSTAGRAM_API_VERSION`, `INSTAGRAM_B2_BUCKET_ID`, `INSTAGRAM_B2_BUCKET_NAME` and `INSTAGRAM_B2_BASIC_AUTH`. The deploy does not need them, only the Instagram publisher does, so they can wait until the Meta app and the bucket exist.

### Phase 2: the switch

1. Stop the old Gateway, so the LinkedIn bot has a single poller:

   ```bash
   systemctl --user disable --now openclaw-gateway-linkedin.service
   ```

2. Carry over the LinkedIn agent's runtime files. Its drafts' images too, if a draft is still waiting to be published:

   ```bash
   mkdir -p ~/.openclaw-social/workspace-linkedin ~/.openclaw-social/media/tool-image-generation
   cp -a ~/.openclaw-linkedin/workspace/content ~/.openclaw-social/workspace-linkedin/
   cp -a ~/.openclaw-linkedin/media/tool-image-generation/. ~/.openclaw-social/media/tool-image-generation/
   ```

   Do not copy `state/`: the LinkedIn token stays in the old store (protected entries cannot be read), so step 6 renews it and writes `state/linkedin-account.json` again.

3. Deploy from Windows ([Deploy](#deploy)). It creates both workspaces, installs the publishers and applies the config, which starts both bots.
4. Sign in to the models, once per agent: each has its own auth store. The OpenAI sign-in serves the primary model; the Anthropic API key (from the [Anthropic Console](https://console.anthropic.com/), pasted at the command's prompt) serves the fallback:

   ```bash
   openclaw --profile social models auth login --provider openai --agent linkedin --device-code
   openclaw --profile social models auth login --provider openai --agent instagram --device-code
   openclaw --profile social models auth paste-api-key --provider anthropic --agent linkedin
   openclaw --profile social models auth paste-api-key --provider anthropic --agent instagram
   openclaw --profile social models status --agent linkedin
   openclaw --profile social models status --agent instagram
   ```

   The agents run on OpenClaw's own runtime, pinned in the config (`agentRuntime: openclaw`) for the primary and the fallback, not on the Codex harness or the Claude CLI. Keep the `codex` plugin disabled on this profile: on the Codex harness, native Codex tools would not go through `/approve`.

   When the primary fails with a failover error (rate or usage limit, overload, server error, failed sign-in), OpenClaw first retries it, then answers with the fallback, scheduled posts included, and returns to the primary once it recovers. An explicit `/model` choice in a chat is strict and never falls back.
5. Store the LinkedIn app's client secret with its helper, typing or pasting it at the hidden prompt (from the app's **Auth** tab). The helper stores it form-encoded, because the egress proxy inserts stored values byte for byte into the token request's form body; the dashboard would store it as pasted, and LinkedIn would refuse the exchange:

   ```bash
   ~/.openclaw-social/social-openclaw/linkedin/scripts/store-client-secret.mjs
   ```

6. Renew the LinkedIn token: [LinkedIn token](#linkedin-token-now-and-every-60-days).
7. Store the Instagram token: [Instagram token](#instagram-token).
8. Check:

   ```bash
   openclaw --profile social secrets audit --check
   openclaw --profile social channels status
   ```

   Send "oi" to each bot: each agent answers in its own bot. With an OAuth model sign-in, `secrets audit --check` exits 1 on the `LEGACY_RESIDUE` finding alone (the OAuth credentials in each agent's auth store), as on the old profile.

### Phase 3: the old profile

Keep `~/.openclaw-linkedin` until both agents have published from the new Gateway: re-enabling its service is the rollback. It still holds the previous LinkedIn token in its store, so remove it when you no longer need it.

### LinkedIn app

1. A LinkedIn Page (a placeholder is enough), and an app at <https://www.linkedin.com/developers/apps> linked to that Page, with the **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect** products.
2. In **Auth**, a redirect URL, for example `https://localhost/linkedin-callback`. Nothing has to serve it. `LINKEDIN_REDIRECT_URI` must match it character for character.
3. `LINKEDIN_API_VERSION` is the latest active `YYYYMM` on LinkedIn's [versioning page](https://learn.microsoft.com/en-us/linkedin/marketing/versioning). LinkedIn retires each version after about a year; the publisher then reports HTTP 426, and you store a newer one.

### LinkedIn token (now, and every 60 days)

The link and the code stay with you: they never pass through the agent or the chat.

1. **In a WSL terminal:**

   ```bash
   ~/.openclaw-social/social-openclaw/linkedin/scripts/auth.mjs url
   ```

   It reads the client id and the redirect URL from the store and prints the authorization link. Open it in the Windows browser, sign in as yourself and allow access. LinkedIn should show **your** app's name; if it shows another app, stop.

   LinkedIn then sends the browser to the redirect URL with `?code=…&state=…`; the page may fail to load, which is fine. Copy the whole address and paste it at the hidden prompt. The script checks the `state` and keeps the code, which is single-use and valid for 30 minutes, in a private file outside the agents' workspaces.
2. **In the LinkedIn bot,** within 30 minutes, send **"renew the token"**. The agent runs `linkedin/scripts/auth.mjs exchange`, with no arguments. Approve it. It trades the code for a token, stores it (bound to `api.linkedin.com` and `www.linkedin.com`, which receives image uploads) and writes `workspace-linkedin/state/linkedin-account.json` with only `personUrn` and `expiresAt`.
3. The agent replies with the LinkedIn **member** the token belongs to. If it is not you, revoke the app's access (LinkedIn → Settings → Data privacy → Permitted services) and start again.

LinkedIn gives self-serve apps no refresh token. Renew when a post warns that the token expires in under 10 days.

### Instagram

The publisher uses the Instagram API with Instagram Login, which publishes single images and carousels of JPEG images fetched from a public URL.

1. **The account.** The brand's Instagram account must be a professional (Business) account: in the app, **Settings → Account type and tools → Switch to professional account**.
2. **The Meta app.** At <https://developers.facebook.com/apps>, create a Business app with the Instagram product and open **API setup with Instagram business login**. In **App roles**, add the brand's account as an **Instagram Tester**, and accept the invitation in Instagram (**Settings → Apps and websites → Tester invites**). The app serves only an account you manage, so it needs Standard Access and no App Review.
3. **Store the account and the API version** as env entries. `INSTAGRAM_USERNAME` is the account's username without `@`; the publisher refuses a token of any other account. `INSTAGRAM_API_VERSION` is the latest Graph API version on Meta's [changelog](https://developers.facebook.com/docs/graph-api/changelog/versions), such as `v25.0`:

   ```bash
   openclaw --profile social secrets store set INSTAGRAM_USERNAME --kind env --value '<username>'
   openclaw --profile social secrets store set INSTAGRAM_API_VERSION --kind env --value '<vNN.0>'
   ```

4. **The private Backblaze B2 bucket**, where each approved slide is available through a temporary download URL:
   - create a dedicated **Private** bucket, for example `brand-instagram`, in **B2 Cloud Storage → Buckets**. Leave Object Lock disabled. Use a separate bucket from any other application;
   - private storage does not require enabling public buckets or their verification payment. The free storage allowance is shared across the account; consult [B2 pricing](https://www.backblaze.com/cloud-storage/pricing) for storage and download charges;
   - in **Lifecycle Settings**, choose custom rules with an empty prefix: hide files one day after upload and delete them one day after hiding. [B2 lifecycle rules](https://www.backblaze.com/docs/cloud-storage-lifecycle-rules) run asynchronously; this is fallback cleanup. The publisher deletes exact file versions after each attempt;
   - create an application key restricted to this bucket, with `writeFiles`, `listFiles`, `deleteFiles` and `shareFiles`, and no file-name prefix. Use a bucket-restricted **Read and Write** key and verify these capabilities. Do not use a master key or a key shared with another application;
   - store the bucket's id and name as env entries, then run the hidden operator helper to enter the application key ID and application key. It encodes the Basic header and stores it as a protected secret bound only to `api.backblazeb2.com`:

   ```bash
   openclaw --profile social secrets store set INSTAGRAM_B2_BUCKET_ID --kind env --value '<bucket id>'
   openclaw --profile social secrets store set INSTAGRAM_B2_BUCKET_NAME --kind env --value '<bucket name>'
   ~/.openclaw-social/social-openclaw/instagram/scripts/b2.mjs store
   ```

   Each publication authorizes the B2 Native API using the protected header sentinel. Its temporary session and upload tokens stay only in publisher memory. The publisher requests [download authorization](https://www.backblaze.com/apidocs/b2-get-download-authorization) with a one-hour lifetime and each random image key as its prefix. Only that temporary read credential is sent to Meta in the URL's `Authorization` query parameter. Anyone holding the link can read its matching file until expiry or deletion; the URL is not printed, and reflected credentials are redacted before diagnostics are truncated. The credential-store helper is operator-only and is not added to the agent's exec commands.

### Instagram token

1. **Once, after the deploy:** in the Meta app's **API setup with Instagram business login**, generate a token for the brand's account and type or paste it at the hidden prompt of:

   ```bash
   ~/.openclaw-social/social-openclaw/instagram/scripts/token.mjs store
   ```

   It stores `INSTAGRAM_ACCESS_TOKEN` bound to `graph.instagram.com`, and writes `workspace-instagram/state/instagram-token.json` with only `expiresAt` (60 days) and `renewedAt`.
2. **Before the 60 days run out:** send **"renew the token"** to the Instagram bot, at least one day after the token was stored or last renewed. The agent runs `instagram/scripts/token.mjs refresh`, with no arguments; approve it. Meta issues a new 60-day token, which goes straight into the store. A scheduled post warns when fewer than 20 days remain.
3. A token that expired cannot be renewed: generate a new one in the Meta app and run `token.mjs store` again.

## Deploy

Every change reaches the Gateway through one idempotent deploy of a committed revision, run from Windows. `-SourceRef` defaults to local `main`; `-WhatIf` previews everything and changes nothing:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\sync-wsl.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\sync-wsl.ps1
```

In order, the script:

1. Builds a `git archive` of the revision (`package.json`, `package-lock.json` when the revision has one, `config/`, `scripts/`, `systemd/`, `test/`, `linkedin/`, `instagram/`), sends it to WSL and checks its SHA-256 on both sides.
2. Installs the dependencies the lockfile pins, if there is one (`npm ci`, without install scripts), and runs `node --test` in WSL on that revision. A failure stops here and changes nothing.
3. Refuses to go on unless the setup exists: the profile's config and the service unit. `apply-gateway.mjs` then refuses to run without its env entries in the store.
4. Syncs, keeping the previous versions under `~/.openclaw-social/sync-backups/<revision>-<time>/`:
   - each agent's `workspace/` into its workspace (`workspace-linkedin`, `workspace-instagram`), creating it the first time and **never touching `content/` or `state/`**;
   - the whole revision into `~/.openclaw-social/social-openclaw/`, where the publishers and token scripts live outside the agents' reach;
   - the systemd drop-in (`UMask=0077`), restarting the service only when it changed.
5. Runs `scripts/apply-gateway.mjs apply`:
   - **Config:** renders `config/openclaw.social.json` with the store's values, dry-runs it (schema and SecretRefs), then patches `openclaw.json`. It restarts the service only when the file changed.
   - **Exec approvals:** makes the host approvals record hold the floors (`security`, `ask`, `askFallback`) and each agent's allowlist of `config/exec-approvals.json`, writing it with `openclaw approvals set` only when something drifted and keeping OpenClaw's own fields.
   - **Scheduled posts:** creates or edits `linkedin-scout` and `instagram-post`, each on its own schedule and announcing through its own bot, only when a field it owns drifted.

It never deletes a file and never touches the fleet Gateway. Running it twice in a row changes nothing the second time. Start a new Telegram conversation afterwards so the agents load the new instructions.

Rollback:

- Pause a scheduled post: `openclaw --profile social cron edit <id> --disable` (`openclaw --profile social cron list --all` shows the id). The next deploy enables it again.
- Stop both agents: `systemctl --user disable --now openclaw-gateway-social.service`. During the migration, `systemctl --user enable --now openclaw-gateway-linkedin.service` brings the old LinkedIn agent back.
- Revoke a token: LinkedIn → Settings → Data privacy → Permitted services; Instagram → Settings → Apps and websites; Cloudflare → API Tokens.

None of these affects the fleet.

## Dashboard

The profile's Control UI is at `http://127.0.0.1:18289` in the Windows browser (WSL runs in mirrored networking mode). It authenticates with the Gateway token, which lives in the store as `SOCIAL_GATEWAY_TOKEN`. To open it the first time on a browser:

1. In a terminal window **outside** the Claude panel, run `wsl -d OpenClawGateway -u openclaw`, then `openclaw --profile social gateway auth-token --show`.
2. Open `http://127.0.0.1:18289/#token=<that token>`. Choose **Token**, never "Password", if a form appears; repeated wrong attempts trip the Gateway's auth limiter. A restart of `openclaw-gateway-social.service` clears that limiter.

After the first login the browser keeps its device pairing. Always pass `--profile social`: without it the command reveals the fleet Gateway's token.

## Daily use

Each agent chooses the topic, writes the post and makes its images; you approve it or ask for changes, in that agent's bot. Both agents talk to Gabriel in English, and Instagram posts are written in English.

- On each agent's schedule, the draft arrives with its exact text, pillar, format, sources and file. The Instagram routine runs Monday, Wednesday and Friday at 09:00 America/Sao_Paulo: educational, practical and educational carousels, respectively, by default. Gabriel can ask the bot for another format on any of these days. Carousels have 4–6 numbered images and per-slide alt text. The bot also lists the words of each slide for spelling review.
- The Instagram routine reads `content/editorial/<Monday-date>.json`, the ledger and the brand facts `USER.md` names. Reruns reuse the same execution and existing artifacts. A persistent publisher receipt prevents another publication of a completed, concurrent or uncertain execution. Preview deliveries say “Preview, not published” and do not request publication.
- "new post", "post about <topic>" (and, on Instagram, "carousel about <topic>"): the same, on demand.
- LinkedIn images are SVG files the agent writes in one of the formats of `linkedin/workspace/IMAGES.md`, the single visual style for posts and article covers. On demand, it runs `render.mjs` on the SVG; approve it and the PNG arrives with the post. A scheduled post never runs a command, so its draft ends with "Reply \"image\" to see the image"; answer "image" and approve the render.
- Instagram slides come from `image_generate`. When it fails (OpenAI down, a usage or rate limit, a failed sign-in), the agent writes every slide of that version as SVG in the house style of `instagram/workspace/SLIDES-SVG.md`, and the draft ends with "Reply \"image\" to see them"; answer "image" and approve the render, and the 1080x1080 JPEGs arrive with the official logo. When the failure reaches only a background completion, answer "svg slides" first. The publisher posts the drawn JPEGs in place of generated ones.
- "cover" (LinkedIn): the agent draws an article cover in the same style (`IMAGES.md`, "Article cover") and runs `render.mjs` on its `…-cover-v<n>.svg`; approve it and the 1920x1080 PNG arrives in the chat. Upload it to the article yourself: a cover is never published.
- "shorter", "another image", "swap slide 3", or any change: a new version, with new images only where the change calls for them.
- "renew the token": in the LinkedIn bot, finishes the renewal after `auth.mjs url` in your terminal; in the Instagram bot, renews the Instagram token.
- "ok" (or "publish"): the agent runs its publisher on the exact file, Telegram shows the approval with the command, and you answer `/approve <id> allow-once` or `/approve <id> deny`. Only `allow-once` and `deny` exist; there is no standing approval.

**Read every approval before answering.** Approve only these exact shapes, only in the bot of the agent they belong to, and only for what you just asked for: the image of the post or the cover you asked for, the draft you saw, or the token step you asked for.

```text
/home/openclaw/.openclaw-social/social-openclaw/linkedin/publisher/render.mjs content/drafts/<date>-<slug>-v<n>.svg
/home/openclaw/.openclaw-social/social-openclaw/linkedin/publisher/publish.mjs content/drafts/<date>-<slug>-v<n>.md
/home/openclaw/.openclaw-social/social-openclaw/linkedin/scripts/auth.mjs exchange
/home/openclaw/.openclaw-social/social-openclaw/instagram/publisher/publish.mjs content/drafts/<date>-<slug>-v<n>.md
/home/openclaw/.openclaw-social/social-openclaw/instagram/scripts/token.mjs refresh
/home/openclaw/.openclaw-social/social-openclaw/instagram/publisher/render.mjs content/drafts/<date>-<slug>-v<n>.slides.txt
```

Deny anything else. Under `ask: always` OpenClaw prompts for *every* command, including ones outside the exec allowlist, so your approval is the gate. A request you did not expect means the agent was steered by something it read: deny it and tell the agent.

Three more habits keep that gate intact:

- **Approve only from OpenClaw's own approval message**, checking the command it shows. The agent learns the approval id, so a text from it that describes a harmless command with an id is not the approval.
- **Never type `/exec …` in a DM.** A message containing `/exec security=full ask=off` would loosen that turn's exec policy. The approval floors in `config/exec-approvals.json` hold `security` and `ask` anyway, but do not rely on them.
- **Never run `git` inside an agent's workspace.** The agent can write files there, including `.git/config`, whose settings would run commands on your next `git` call.

## Troubleshooting

### Both agents

| Symptom | Cause and fix |
|---|---|
| A DM gets no answer | Only the user id in `SOCIAL_TELEGRAM_USER_ID` is allowed; after changing it, deploy again. Check `openclaw --profile social channels status` and the service with `systemctl --user status openclaw-gateway-social.service`. If the LinkedIn bot is silent right after the migration, check that the old `openclaw-gateway-linkedin.service` is stopped: two Gateways cannot poll the same bot. |
| The deploy stops with "… is not in the OpenClaw store as an env entry" | A store entry is missing or was stored as a secret: [Setup](#setup-operator-only). |
| The deploy's config dry run fails on a SecretRef | `SOCIAL_GATEWAY_TOKEN`, `LINKEDIN_TELEGRAM_BOT_TOKEN` or `INSTAGRAM_TELEGRAM_BOT_TOKEN` is missing from the store. |
| A post fails on a `web_search` error | The provider in `SOCIAL_WEB_SEARCH_PROVIDER` failed, limited the rate, or (DuckDuckGo) answered with a bot challenge. Test it with `openclaw --profile social infer web search --provider <id> --query test`. Ask for the post again later, or store another installed provider and deploy. |
| A reply or post came from the Claude fallback, or both models failed | The primary failed with a failover error: check `openclaw --profile social models status --agent <id>` and sign in to OpenAI again if its profile expired. If the fallback failed too, the Anthropic key is missing, revoked or out of credit in that agent's auth store: paste it again (phase 2, step 4). |
| A LinkedIn post arrives without its image | A scheduled post never renders: answer "image" and approve the render. On demand, the render was denied, or it was `rejected` (see the `rejected` rows under LinkedIn below). |
| An Instagram post arrives without its images | `image_generate` failed or timed out. Answer "svg slides" for SVG slides now, or ask for "another image" later. If the log says the model "is not supported when using Codex with a ChatGPT account", store another model the sign-in lists in `SOCIAL_IMAGE_RESPONSES_MODEL` and deploy. A usage limit on the ChatGPT account stops generated images until it resets: `openclaw --profile social models status --agent instagram` shows it. |
| An Instagram render is `rejected` | Nothing was drawn. The `message` names each slide's SVG and what broke `SLIDES-SVG.md` (a color or font outside the style, an image or link, text past the canvas); the agent fixes those SVGs and asks to render the list once more. "no fonts in …" means the deploy's copy has no `instagram/publisher/fonts/`: deploy again from a revision that has them. |
| No scheduled post | The PC, WSL or the service was off at that time, and that run is skipped. Ask for "new post". `openclaw --profile social cron runs <id>` shows the history. |
| `unknown`, timeout, network error or HTTP 5xx | The post **may exist**. Check the profile before asking again; nothing retries on its own. |

### LinkedIn

| Symptom | Cause and fix |
|---|---|
| `not_posted`, "HTTP 401 … renew the token" or "the LinkedIn token expired" | The token expired or was revoked, or `state/linkedin-account.json` says it did. Run `linkedin/scripts/auth.mjs url` in WSL, then send "renew the token". |
| `auth.mjs url` or the renewal fails with "LINKEDIN_CLIENT_ID …", "LINKEDIN_REDIRECT_URI …" or "LINKEDIN_CLIENT_SECRET …" | A value is missing from the store, the client id or redirect URL was stored as a protected secret, or the secret as plaintext. Redo Phase 1 step 5 or Phase 2 step 5. |
| LinkedIn shows "The redirect_uri does not match the registered value" | `LINKEDIN_REDIRECT_URI` differs from every redirect URL in the app's **Auth** tab, or one just added there has not taken effect yet. Copy it again, wait a few minutes and rerun `auth.mjs url`. |
| `auth.mjs url`: "unauthorized_scope_error" | The app lacks **Sign In with LinkedIn using OpenID Connect** or **Share on LinkedIn**. Add it in **Products** and rerun `auth.mjs url`. |
| Renewal `failed`, "no authorization is waiting" or "older than 30 minutes" | Run `auth.mjs url` in WSL first, and send "renew the token" within 30 minutes. Each code can be exchanged once. |
| Renewal `failed`, "token exchange failed with HTTP 401 (invalid_client …)" | LinkedIn refused the client secret: a wrong or regenerated one, or one stored by hand. Store it again with the helper, then `auth.mjs url` and "renew the token". |
| `not_posted`, "HTTP 403 … w_member_social" | The app lacks **Share on LinkedIn**, or `LINKEDIN_ACCESS_TOKEN` is not bound to `api.linkedin.com`. Renew the token. |
| `not_posted`, "retired API version … HTTP 426" | Store the latest active `LINKEDIN_API_VERSION`. |
| `rejected`, "nothing was rendered; fix the SVG: …" | The agent's SVG broke a rule of `IMAGES.md` (a color or font outside the house style, a link, a script). The agent fixes that same SVG and asks to render it once more. |
| `rejected`, "something runs past the 1200x800 canvas …" | A line of the SVG is longer than its space and would come out cropped. The agent shortens or breaks it and asks to render that same SVG once more. |
| `rejected`, "… already exists; a changed image is the next version" | That version already has its image. Ask for "another image": the agent writes the next version. |
| `rejected`, "no fonts in …" | The deploy's copy has no `linkedin/publisher/fonts/`. Deploy again from a revision that has them. |
| `not_posted`, "uploading the image was refused (HTTP 403)" | `LINKEDIN_ACCESS_TOKEN` is not allowed for `www.linkedin.com`: `openclaw --profile social secrets store set LINKEDIN_ACCESS_TOKEN --kind secret --allow-host api.linkedin.com --allow-host www.linkedin.com`. |

### Instagram

| Symptom | Cause and fix |
|---|---|
| `not_posted`, "the Instagram token belongs to @…, not @…" | The token was generated for another account, or `INSTAGRAM_USERNAME` is wrong. Generate the token as the expected account and run `token.mjs store`, or fix the entry. |
| `not_posted`, "… code 190 … renew the token" | The token expired or was revoked. Send "renew the token"; if it already expired, generate a new one in the Meta app and run `token.mjs store`. |
| `not_posted`, "… instagram_business_content_publish …" | The token lacks the publishing permission, or `INSTAGRAM_ACCESS_TOKEN` is not bound to `graph.instagram.com` (`openclaw --profile social secrets store list` shows the hosts). Generate the token again with both Instagram permissions and run `token.mjs store`. |
| `not_posted`, "B2 authorization failed with HTTP 401" | The B2 key was revoked or entered incorrectly. Enter the bucket-restricted key again with `instagram/scripts/b2.mjs store`; verify its protected host binding to `api.backblazeb2.com`. |
| `not_posted`, "B2 … failed with HTTP 401/403" or "application key must be restricted" | Check the key's dedicated bucket restriction and writing, listing, deleting and sharing capabilities, without a file prefix. Also check the account's caps. |
| `not_posted`, "B2 returned an unsafe … endpoint" | The returned destination is outside the publisher's validated B2 hosts or URL shape. Inspect provider documentation without forwarding credentials or disabling validation. |
| `not_posted`, "container status ERROR" | Instagram could not fetch or read a slide: verify that temporary download authorization works while an unauthenticated request is denied, and that the slide is a JPEG within Instagram's limits. Do not paste a temporary download URL in chat or logs. |
| `not_posted`, "slide … is not a JPEG" or "is not among the generated images" | The slide was generated as PNG, or under another name. Ask the agent to make that slide again. |
| `not_posted`, "INSTAGRAM_… must be …" | A store entry is missing or malformed: [Instagram](#instagram). |
| Renewal `failed`, "A token can be refreshed only after 24 hours" | Meta renews a token only when it is at least a day old. Try again tomorrow. |
| `published`, with `cleanup: "failed"` | The post is out, but some slides stayed in the bucket; the lifecycle rule removes them within a day. |
