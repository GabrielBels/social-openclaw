// Pure planning for the social Gateway: renders the versioned config with the operator's local values and decides
// whether each agent's scheduled post job needs to be created or edited. scripts/apply-gateway.mjs runs the resulting
// openclaw commands.

export const PROFILE = "social";

const telegramUserIdPattern = /^[1-9][0-9]{4,14}$/;
const cronPattern = /^[0-9A-Za-z*,/?-]+( [0-9A-Za-z*,/?-]+){4}$/;
const modelPattern = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// The fallback runs on the Anthropic API key saved in each agent's auth store, never on the Claude CLI route.
const fallbackModelPattern = /^anthropic\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// On a ChatGPT sign-in, image_generate draws through a Codex responses model: OpenClaw's default first, then only the
// openai/ models of agents.defaults.model when the account does not offer it.
const imageResponsesModelPattern = /^openai\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// OpenClaw's config schema checks the level itself (thinkingDefault); this only keeps the value a plain word.
const thinkingPattern = /^[a-z]{2,16}$/;
const webSearchProviderPattern = /^[a-z0-9][a-z0-9-]{1,39}$/;

// Each agent's own store entries: its model, the Claude model it falls back to, its thinking level, and when its
// scheduled post runs.
export const AGENT_ENTRIES = {
  linkedin: {
    model: "LINKEDIN_MODEL", fallbackModel: "LINKEDIN_FALLBACK_MODEL", thinking: "LINKEDIN_THINKING",
    cron: "LINKEDIN_SCOUT_CRON", tz: "LINKEDIN_SCOUT_TZ"
  },
  instagram: {
    model: "INSTAGRAM_MODEL", fallbackModel: "INSTAGRAM_FALLBACK_MODEL", thinking: "INSTAGRAM_THINKING",
    cron: "INSTAGRAM_POST_CRON", tz: "INSTAGRAM_POST_TZ"
  }
};

function isTimeZone(value) {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function readAgent(values, entries) {
  const model = String(values?.model ?? "").trim();
  if (!modelPattern.test(model)) throw new Error(`${entries.model} must be a provider/model id from \`openclaw models list\`, stored with --kind env`);
  const fallbackModel = String(values?.fallbackModel ?? "").trim();
  if (!fallbackModelPattern.test(fallbackModel)) {
    throw new Error(`${entries.fallbackModel} must be an anthropic/<model> id from \`openclaw models list --provider anthropic\`, stored with --kind env`);
  }
  const thinking = String(values?.thinking ?? "").trim();
  if (!thinkingPattern.test(thinking)) throw new Error(`${entries.thinking} must be an OpenClaw thinking level, stored with --kind env`);
  const cron = String(values?.cron ?? "").trim().replace(/\s+/g, " ");
  if (!cronPattern.test(cron)) throw new Error(`${entries.cron} must be a five-field cron expression, stored with --kind env`);
  const tz = String(values?.tz ?? "").trim();
  if (!isTimeZone(tz)) throw new Error(`${entries.tz} must be an IANA time zone, stored with --kind env`);
  return { model, fallbackModel, thinking, cron, tz };
}

// The operator's values stay out of Git, as env entries of the profile's OpenClaw store, because the config and the
// jobs need their real values. Shared by both agents: SOCIAL_TELEGRAM_USER_ID (both bots' allowFrom and approvers, the
// jobs' delivery), SOCIAL_WEB_SEARCH_PROVIDER (the web_search provider; its plugin must be installed),
// SOCIAL_IMAGE_MODEL (image_generate's model) and SOCIAL_IMAGE_RESPONSES_MODEL (the responses model image_generate
// retries with). Per agent: the entries in AGENT_ENTRIES.
export function readOperator(operator) {
  const telegramUserId = String(operator?.telegramUserId ?? "");
  if (!telegramUserIdPattern.test(telegramUserId)) {
    throw new Error("SOCIAL_TELEGRAM_USER_ID must be Gabriel's numeric Telegram user id, stored with --kind env");
  }
  const webSearchProvider = String(operator?.webSearchProvider ?? "").trim();
  if (!webSearchProviderPattern.test(webSearchProvider)) {
    throw new Error("SOCIAL_WEB_SEARCH_PROVIDER must be an OpenClaw web_search provider id, stored with --kind env");
  }
  const imageModel = String(operator?.imageModel ?? "").trim();
  if (!modelPattern.test(imageModel)) {
    throw new Error("SOCIAL_IMAGE_MODEL must be a provider/model id for image_generate, stored with --kind env");
  }
  const imageResponsesModel = String(operator?.imageResponsesModel ?? "").trim();
  if (!imageResponsesModelPattern.test(imageResponsesModel)) {
    throw new Error("SOCIAL_IMAGE_RESPONSES_MODEL must be an openai/<model> id the ChatGPT sign-in offers, stored with --kind env");
  }
  return {
    telegramUserId, webSearchProvider, imageModel, imageResponsesModel,
    linkedin: readAgent(operator?.linkedin, AGENT_ENTRIES.linkedin),
    instagram: readAgent(operator?.instagram, AGENT_ENTRIES.instagram)
  };
}

// Replaces every "__TELEGRAM_USER_ID__", "__WEB_SEARCH_PROVIDER__", "__IMAGE_MODEL__", "__IMAGE_RESPONSES_MODEL__", and
// each agent's "__<AGENT>_MODEL__",
// "__<AGENT>_FALLBACK_MODEL__" and "__<AGENT>_THINKING__" (LINKEDIN, INSTAGRAM) in string values and object keys (each
// agent's per-model entries are keyed by its models); anything else is copied as is.
export function render(template, { telegramUserId, webSearchProvider, imageModel, imageResponsesModel, linkedin, instagram }) {
  const values = {
    __TELEGRAM_USER_ID__: telegramUserId, __WEB_SEARCH_PROVIDER__: webSearchProvider, __IMAGE_MODEL__: imageModel,
    __IMAGE_RESPONSES_MODEL__: imageResponsesModel,
    __LINKEDIN_MODEL__: linkedin?.model, __LINKEDIN_FALLBACK_MODEL__: linkedin?.fallbackModel,
    __LINKEDIN_THINKING__: linkedin?.thinking,
    __INSTAGRAM_MODEL__: instagram?.model, __INSTAGRAM_FALLBACK_MODEL__: instagram?.fallbackModel,
    __INSTAGRAM_THINKING__: instagram?.thinking
  };
  const fill = text => text.replace(
    /__(?:TELEGRAM_USER_ID|WEB_SEARCH_PROVIDER|IMAGE_(?:RESPONSES_)?MODEL|(?:LINKEDIN|INSTAGRAM)_(?:FALLBACK_MODEL|MODEL|THINKING))__/g,
    match => values[match] ?? match);
  const walk = value => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [fill(key), walk(inner)]));
    if (typeof value === "string") return fill(value);
    return value;
  };
  const rendered = walk(template);
  const leftover = JSON.stringify(rendered).match(/__[A-Z_]+__/);
  if (leftover) throw new Error(`unrendered placeholder in config: ${leftover[0]}`);
  return rendered;
}

const FLOOR_KEYS = ["security", "ask", "askFallback"];

// The exec approvals record OpenClaw should hold: the floors (security, ask, askFallback) in `defaults` and per agent,
// and each listed agent's allowlist. The floors are what a per-message `/exec security=full ask=off` directive cannot
// loosen. Allowlist entries compare by pattern and argPattern only (OpenClaw adds ids and lastUsedAt), and everything
// else in the record (socket, other agents) is kept, because `openclaw approvals set` replaces the whole record.
export function planApprovals(desired, approvalsFile) {
  const key = entry => `${entry.pattern}\u0000${entry.argPattern ?? ""}`;
  const file = structuredClone(approvalsFile ?? { version: 1 });
  file.defaults ??= {};
  file.agents ??= {};
  const drift = [];
  for (const field of FLOOR_KEYS) {
    if (desired.defaults[field] !== undefined && file.defaults[field] !== desired.defaults[field]) {
      file.defaults[field] = desired.defaults[field];
      drift.push(`defaults.${field}`);
    }
  }
  for (const [agent, wanted] of Object.entries(desired.agents)) {
    const entry = { ...(file.agents[agent] ?? {}) };
    for (const field of FLOOR_KEYS) {
      if (wanted[field] !== undefined && entry[field] !== wanted[field]) {
        entry[field] = wanted[field];
        drift.push(`${agent}.${field}`);
      }
    }
    const current = entry.allowlist ?? [];
    const entries = wanted.allowlist ?? [];
    const matches = current.length === entries.length && entries.every(item => current.some(existing => key(existing) === key(item)));
    if (!matches) {
      entry.allowlist = entries.map(item => current.find(existing => key(existing) === key(item)) ?? { ...item });
      drift.push(`${agent}.allowlist`);
    }
    file.agents[agent] = entry;
  }
  return { drift, file };
}

// A scheduled post never needs exec, so its job cannot use it at all, whatever the session asks for.
export const POST_TOOLS = ["web_search", "web_fetch", "read", "write", "edit", "image_generate"];
// LinkedIn images are SVG files the agent writes; render.mjs draws them when Gabriel asks, never in a scheduled run.
export const LINKEDIN_POST_TOOLS = POST_TOOLS.filter(tool => tool !== "image_generate");

// Each agent's scheduled post: it runs in an isolated session and announces through the agent's own Telegram bot
// (the account bound to it in the config).
export function postJobs({ telegramUserId, linkedin, instagram }) {
  const job = ({ name, displayName, description, agentId, schedule, message, timeoutSeconds, toolsAllow = POST_TOOLS }) => ({
    name, displayName, description, agentId,
    enabled: true,
    schedule: { kind: "cron", expr: schedule.cron, tz: schedule.tz, staggerMs: 0 },
    sessionTarget: "isolated",
    wakeMode: "now",
    delivery: { mode: "announce", channel: "telegram", to: telegramUserId, accountId: agentId },
    payload: { kind: "agentTurn", message, timeoutSeconds, toolsAllow }
  });
  return [
    job({
      name: "linkedin-scout",
      displayName: "LinkedIn: scheduled post",
      description: `Researches AI and engineering news, writes a post with an image and sends it on Telegram for approval (cron ${linkedin.cron}, ${linkedin.tz}).`,
      agentId: "linkedin",
      schedule: linkedin,
      message: "Scheduled post (linkedin-scout). Follow section 1 (Post) of AGENTS.md exactly: choose the story, write the draft and its SVG image, and end with the post for Gabriel's approval, plus the token warning when it applies. Never run any command.",
      timeoutSeconds: 900,
      toolsAllow: LINKEDIN_POST_TOOLS
    }),
    job({
      name: "instagram-post",
      displayName: "Instagram: scheduled post",
      description: `Educational carousel on Monday and Friday and practical on Wednesday; review on Telegram (cron ${instagram.cron}, ${instagram.tz}).`,
      agentId: "instagram",
      schedule: instagram,
      message: "Scheduled post (instagram-post). Read EDITORIAL.md and follow section 1 (Post) of AGENTS.md. Use the scheduled date in America/Sao_Paulo: Monday educational carousel, Wednesday practical carousel, Friday educational carousel. Save the exact caption, slide list, metadata and same weekly execution before generating images. Reuse saved artifacts on rerun. Consult publication history, verified sources and the brand reference. End with the review package and token warning. Never run any command or publish.",
      // A carousel takes one image generation per slide.
      timeoutSeconds: 1800
    })
  ];
}

// `openclaw cron create` (with --name) or `openclaw cron edit <id>` flags that set every field this repo owns.
export function jobArgs(job, command) {
  const enabled = command === "create" ? [] : ["--enable"];
  return [
    ...(command === "create" ? ["--name", job.name] : []),
    "--display-name", job.displayName, "--description", job.description,
    "--agent", job.agentId,
    "--cron", job.schedule.expr, "--tz", job.schedule.tz, "--exact",
    "--session", job.sessionTarget, "--wake", job.wakeMode,
    "--announce", "--channel", job.delivery.channel, "--to", job.delivery.to, "--account", job.delivery.accountId,
    "--message", job.payload.message,
    "--timeout-seconds", String(job.payload.timeoutSeconds), "--tools", job.payload.toolsAllow.join(","),
    ...enabled
  ];
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function jobDrift(desired, current) {
  const drift = [];
  for (const field of ["displayName", "description", "agentId", "sessionTarget", "wakeMode"]) {
    if (current[field] !== desired[field]) drift.push(field);
  }
  if ((current.enabled !== false) !== desired.enabled) drift.push("enabled");
  const schedule = current.schedule ?? {};
  if (schedule.kind !== "cron" || schedule.expr !== desired.schedule.expr || schedule.tz !== desired.schedule.tz ||
      (schedule.staggerMs ?? 0) !== desired.schedule.staggerMs) drift.push("schedule");
  const delivery = current.delivery ?? {};
  if (delivery.mode !== desired.delivery.mode || delivery.channel !== desired.delivery.channel ||
      String(delivery.to) !== desired.delivery.to || delivery.accountId !== desired.delivery.accountId) {
    drift.push("delivery");
  }
  const payload = current.payload ?? {};
  for (const field of ["kind", "message", "timeoutSeconds", "toolsAllow"]) {
    if (!sameJson(payload[field], desired.payload[field])) drift.push(`payload.${field}`);
  }
  return drift;
}

// Never deletes: a second job with the same name is reported, not removed.
export function planJob(desired, jobs) {
  const matches = jobs.filter(job => job.name === desired.name);
  if (matches.length > 1) throw new Error(`more than one cron job is named ${desired.name}; remove the extra one by hand`);
  if (matches.length === 0) return { action: "create", args: jobArgs(desired, "create") };
  const drift = jobDrift(desired, matches[0]);
  if (drift.length === 0) return { action: "none", id: matches[0].id };
  return { action: "update", id: matches[0].id, drift, args: jobArgs(desired, "edit") };
}
