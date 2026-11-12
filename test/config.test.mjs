import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { render } from "../scripts/lib/gateway-plan.mjs";

const config = JSON.parse(readFileSync(new URL("../config/openclaw.social.json", import.meta.url), "utf8"));
const working = ["linkedin", "instagram"];
const agents = Object.fromEntries(working.map(id => [id, config.agents.entries[id]]));
// LinkedIn draws its images from SVG with render.mjs; Instagram's slides come from image_generate.
const allowedTools = {
  linkedin: ["web_search", "web_fetch", "read", "write", "edit", "exec"],
  instagram: ["web_search", "web_fetch", "read", "write", "edit", "image_generate", "exec"]
};
const storeValues = {
  telegramUserId: "123456789", webSearchProvider: "duckduckgo", imageModel: "openai/gpt-test-image",
  imageResponsesModel: "openai/gpt-test-responses",
  linkedin: { model: "openai/gpt-test-model", fallbackModel: "anthropic/claude-test-model", thinking: "high" },
  instagram: { model: "openai/gpt-other-model", fallbackModel: "anthropic/claude-other-model", thinking: "medium" }
};

// With explicit ownership, channels, heartbeat, cron and bare CLI operations must resolve a named owner or fail
// closed; there is no default agent to fall back to.
test("linkedin and instagram are the working agents, and ownership is explicit", () => {
  assert.deepEqual(Object.keys(config.agents.entries).sort(), ["instagram", "linkedin", "main"]);
  assert.equal(config.agents.ownership, "explicit");
  for (const entry of Object.values(config.agents.entries)) assert.equal(entry.default, undefined);
  assert.deepEqual(agents.linkedin.skills, ["linkedin-publisher"]);
  assert.deepEqual(agents.instagram.skills, ["instagram-publisher"]);
  assert.deepEqual(config.skills.entries, { "linkedin-publisher": { enabled: true }, "instagram-publisher": { enabled: true } });
});

// Each agent keeps its own workspace and agent directory, so its file tools never reach the other's drafts or state.
test("each agent has its own workspace and agent directory", () => {
  const entries = Object.values(config.agents.entries);
  assert.equal(new Set(entries.map(entry => entry.workspace)).size, entries.length);
  assert.equal(new Set(entries.map(entry => entry.agentDir)).size, entries.length);
  assert.equal(agents.linkedin.workspace, "/home/openclaw/.openclaw-social/workspace-linkedin");
  assert.equal(agents.instagram.workspace, "/home/openclaw/.openclaw-social/workspace-instagram");
  assert.ok(!working.some(id => agents[id].workspace === config.agents.defaults.workspace), "no working agent owns the default workspace");
});

// OpenClaw refuses to delete the baseline `main` agent (it owns the profile's legacy auth store), so it stays inert:
// its own empty workspace, no skills, no tools, no heartbeat, and no binding routes to it.
test("the baseline main agent is inert", () => {
  const main = config.agents.entries.main;
  assert.deepEqual(main.skills, []);
  assert.deepEqual(main.tools, { allow: [], deny: ["*"] });
  assert.equal(main.heartbeat.every, "0m");
  assert.ok(config.bindings.every(binding => binding.agentId !== "main"));
});

for (const id of working) {
  const agent = agents[id];

  test(`${id} may use only web search/fetch, file tools, exec and, for Instagram, image generation`, () => {
    assert.deepEqual([...agent.tools.allow].sort(), [...allowedTools[id]].sort());
  });

  test(`${id}: browser, sessions, message, cron, gateway and nodes are denied`, () => {
    for (const tool of ["browser", "group:sessions", "message", "cron", "gateway", "nodes"]) {
      assert.ok(agent.tools.deny.includes(tool), `${tool} must be denied`);
      assert.ok(!agent.tools.allow.includes(tool), `${tool} must not be allowed`);
    }
    assert.ok(!agent.tools.allow.some(tool => tool.startsWith("sessions_") || tool.startsWith("group:")));
  });

  test(`${id}: file tools stay inside the workspace, and exec runs on the Gateway from an allowlist and always asks`, () => {
    assert.equal(agent.tools.fs.workspaceOnly, true);
    assert.deepEqual(agent.tools.exec, { host: "gateway", security: "allowlist", ask: "always" });
    assert.equal(agent.heartbeat.every, "0m");
  });

  // Code Mode runs model-written scripts in the Gateway process without /approve, and gpt-5.6-terra turns it on by
  // default. The Codex harness would bring its own native shell. Both stay off; the agent runs on OpenClaw's runtime.
  test(`${id} runs on OpenClaw's embedded runtime with Code Mode off, for whichever models the store names`, () => {
    const placeholder = `__${id.toUpperCase()}_MODEL__`;
    const fallback = `__${id.toUpperCase()}_FALLBACK_MODEL__`;
    assert.deepEqual(agent.model, { primary: placeholder, fallbacks: [fallback] });
    assert.equal(agent.thinkingDefault, `__${id.toUpperCase()}_THINKING__`);
    // The fallback stays on OpenClaw's runtime too, so an Anthropic model uses the API key and never the Claude CLI.
    for (const key of [placeholder, fallback]) assert.deepEqual(agent.models[key], { agentRuntime: { id: "openclaw" }, codeMode: false });
    // Code Mode accepts only exact model keys; the agent-wide tools.codeMode below covers any other model.
    assert.deepEqual(agent.models["openai/*"], { agentRuntime: { id: "openclaw" } });
    assert.deepEqual(agent.tools.codeMode, { enabled: false, executor: "quickjs" });
    const rendered = render(config, storeValues).agents.entries[id];
    assert.deepEqual(rendered.model, { primary: storeValues[id].model, fallbacks: [storeValues[id].fallbackModel] });
    assert.equal(rendered.thinkingDefault, storeValues[id].thinking);
    for (const model of [storeValues[id].model, storeValues[id].fallbackModel]) {
      assert.deepEqual(rendered.models[model], { agentRuntime: { id: "openclaw" }, codeMode: false });
    }
  });
}

test("the Codex harness is off, and workspace files cannot reconfigure the embedded runtime", () => {
  assert.equal(config.plugins.entries.codex.enabled, false);
  assert.equal(config.agents.defaults.embeddedAgent.projectSettingsPolicy, "ignore");
});

test("exec defaults stay on the Gateway allowlist and file tools inside workspaces", () => {
  assert.equal(config.tools.fs.workspaceOnly, true);
  assert.deepEqual(config.tools.exec, { host: "gateway", security: "allowlist", ask: "always" });
});

test("images come from image_generate, with the image and responses models the store names", () => {
  assert.deepEqual(config.agents.defaults.mediaModels, { image: { primary: "__IMAGE_MODEL__" } });
  // image_generate falls back to the default model's openai/ id when the account does not offer OpenClaw's own.
  assert.equal(config.agents.defaults.model, "__IMAGE_RESPONSES_MODEL__");
  const rendered = render(config, storeValues).agents.defaults;
  assert.equal(rendered.mediaModels.image.primary, "openai/gpt-test-image");
  assert.equal(rendered.model, "openai/gpt-test-responses");
});

// Each agent has its own bot: a Telegram account bound to it alone, answering only Gabriel's DM, and forwarding only
// that agent's exec approvals.
test("each agent answers through its own Telegram bot, only to Gabriel's DM, with groups disabled", () => {
  // A new profile ships the Telegram plugin disabled; the channel needs it on.
  assert.equal(config.plugins.entries.telegram.enabled, true);
  const telegram = config.channels.telegram;
  assert.equal(telegram.dmPolicy, "allowlist");
  assert.deepEqual(telegram.allowFrom, ["__TELEGRAM_USER_ID__"]);
  assert.equal(telegram.groupPolicy, "disabled");
  assert.equal(telegram.botToken, undefined, "every bot belongs to an account");
  assert.deepEqual(Object.keys(telegram.accounts).sort(), ["instagram", "linkedin"]);
  assert.ok(telegram.defaultAccount in telegram.accounts);
  for (const id of working) {
    const account = telegram.accounts[id];
    assert.equal(account.enabled, true);
    assert.equal(account.dmPolicy, "allowlist");
    assert.deepEqual(account.allowFrom, ["__TELEGRAM_USER_ID__"]);
    assert.equal(account.groupPolicy, "disabled");
    assert.deepEqual(account.execApprovals, { enabled: true, approvers: ["__TELEGRAM_USER_ID__"], target: "dm", agentFilter: [id] });
  }
  assert.deepEqual(config.bindings, working.map(id => ({ type: "route", agentId: id, match: { channel: "telegram", accountId: id } })));
});

test("exec approvals are forwarded to the originating Telegram session, for the working agents only", () => {
  assert.deepEqual(config.approvals.exec, { enabled: true, mode: "session", agentFilter: ["linkedin", "instagram"] });
});

test("each bot's token is its own store SecretRef", () => {
  assert.deepEqual(config.channels.telegram.accounts.linkedin.botToken, { source: "store", provider: "default", id: "LINKEDIN_TELEGRAM_BOT_TOKEN" });
  assert.deepEqual(config.channels.telegram.accounts.instagram.botToken, { source: "store", provider: "default", id: "INSTAGRAM_TELEGRAM_BOT_TOKEN" });
});

test("the Gateway's own access token is a store SecretRef, not plaintext in openclaw.json", () => {
  assert.deepEqual(config.gateway.auth, { mode: "token", token: { source: "store", provider: "default", id: "SOCIAL_GATEWAY_TOKEN" } });
});

test("no credential-like key holds a plaintext string anywhere", () => {
  const offenders = [];
  const walk = (value, at) => {
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${at}[${index}]`));
    else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (/token|apikey|secret|password/i.test(key) && typeof inner === "string") offenders.push(`${at}.${key}`);
        walk(inner, `${at}.${key}`);
      }
    }
  };
  walk(config, "config");
  assert.deepEqual(offenders, []);
});

// With no provider pinned, OpenAI models use OpenAI's native search, whose web content arrives inside the model's
// answer instead of through OpenClaw's web_search tool and its untrusted-content wrapping.
test("web search goes through the managed provider the store names", () => {
  assert.deepEqual(config.tools.web, { search: { provider: "__WEB_SEARCH_PROVIDER__" } });
  assert.equal(render(config, storeValues).tools.web.search.provider, "duckduckgo");
});

test("the egress proxy is on, so tokens reach exec only as sentinels", () => {
  assert.equal(config.secrets.egressProxy.enabled, true);
});

test("nothing runs the model on its own besides the scheduled posts", () => {
  assert.equal(config.agents.defaults.heartbeat.every, "0m");
  assert.equal(config.plugins.entries["memory-core"].config.dreaming.enabled, false);
  assert.equal(config.skills.workshop.autonomous.mode, "off");
});

test("chat commands cannot run shell commands or edit config, and the browser is off", () => {
  assert.equal(config.commands.bash, false);
  assert.equal(config.commands.config, false);
  assert.equal(config.browser.enabled, false);
});

// 18289 keeps the derived ports (base+1, base+2, CDP base+11 to base+110) clear of the old linkedin profile's 18489
// and of the fleet's 18789 and its CDP range.
test("the Gateway listens on its own loopback port, away from the fleet's 18789 and the linkedin profile's 18489", () => {
  assert.equal(config.gateway.bind, "loopback");
  assert.equal(config.gateway.port, 18289);
  assert.ok(Math.abs(config.gateway.port - 18789) >= 120);
  assert.ok(config.gateway.port + 110 < 18489);
});

const approvals = JSON.parse(readFileSync(new URL("../config/exec-approvals.json", import.meta.url), "utf8"));
const installed = "/home/openclaw/.openclaw-social/social-openclaw";
const draftArgument = id => new RegExp(approvals.agents[id].allowlist[0].argPattern);

test("each agent's exec allowlist holds only its publisher, its bare token command and its renderer, outside every workspace", () => {
  assert.deepEqual(Object.keys(approvals.agents).sort(), ["instagram", "linkedin", "main"]);
  assert.deepEqual(approvals.agents.main.allowlist, []);
  assert.deepEqual(approvals.agents.linkedin.allowlist.map(entry => entry.pattern), [
    `${installed}/linkedin/publisher/publish.mjs`, `${installed}/linkedin/scripts/auth.mjs`, `${installed}/linkedin/publisher/render.mjs`
  ]);
  assert.deepEqual(approvals.agents.instagram.allowlist.map(entry => entry.pattern), [
    `${installed}/instagram/publisher/publish.mjs`, `${installed}/instagram/scripts/token.mjs`, `${installed}/instagram/publisher/render.mjs`
  ]);
  for (const id of working) {
    for (const entry of approvals.agents[id].allowlist) {
      assert.ok(!entry.pattern.includes("/.openclaw-social/workspace"), entry.pattern);
      assert.ok(entry.argPattern.startsWith("^") && entry.argPattern.endsWith("$"), entry.argPattern);
    }
  }
});

test("each publisher accepts exactly one versioned draft path", () => {
  for (const id of working) {
    const argument = draftArgument(id);
    for (const ok of ["content/drafts/2026-10-07-evidence-over-hype-v1.md", "content/drafts/2026-10-07-gpt5-v12.md"]) {
      assert.ok(argument.test(ok), ok);
    }
    for (const bad of [
      "content/drafts/2026-10-07-x-v1.md --dry-run", "content/drafts/../state/x-v1.md", "content/notes/2026-10-07-x-v1.md",
      "/home/openclaw/.openclaw-social/workspace-linkedin/content/drafts/2026-10-07-x-v1.md", "content/drafts/2026-10-07-x-v1Xmd",
      "content/drafts/2026-10-07-X-v1.md", "content/drafts/2026-10-07-x.md", "content/drafts/2026-10-07-x-v1.md; rm -rf ~",
      "content/drafts/2026-10-07-x-v1.slides.txt", ""
    ]) assert.ok(!argument.test(bad), bad);
  }
});

test("the renderer accepts exactly one versioned SVG path", () => {
  const argument = new RegExp(approvals.agents.linkedin.allowlist[2].argPattern);
  for (const ok of ["content/drafts/2026-10-07-evidence-over-hype-v1.svg", "content/drafts/2026-10-07-gpt5-v12.svg",
    "content/drafts/2026-11-05-retry-keys-cover-v1.svg"]) {
    assert.ok(argument.test(ok), ok);
  }
  for (const bad of [
    "content/drafts/2026-10-07-x-v1.md", "content/drafts/2026-10-07-x-v1.svg --out /tmp/x.png", "content/drafts/../state/x-v1.svg",
    "/home/openclaw/.openclaw-social/workspace-linkedin/content/drafts/2026-10-07-x-v1.svg", "content/drafts/2026-10-07-x.svg",
    "content/drafts/2026-10-07-x-v1.svg; rm -rf ~", "content/drafts/2026-10-07-x-v1.png", ""
  ]) assert.ok(!argument.test(bad), bad);
});

test("the Instagram renderer accepts exactly one versioned slide list path", () => {
  const argument = new RegExp(approvals.agents.instagram.allowlist[2].argPattern);
  for (const ok of ["content/drafts/2026-10-12-appeal-deadline-v1.slides.txt", "content/drafts/2026-10-12-order-v12.slides.txt"]) {
    assert.ok(argument.test(ok), ok);
  }
  for (const bad of [
    "content/drafts/2026-10-12-x-v1.md", "content/drafts/2026-10-12-x-v1-1.svg", "content/drafts/2026-10-12-x-v1slides.txt",
    "content/drafts/2026-10-12-x-v1.slides.txt --out /tmp", "content/drafts/../state/x-v1.slides.txt",
    "/home/openclaw/.openclaw-social/workspace-instagram/content/drafts/2026-10-12-x-v1.slides.txt", "content/drafts/2026-10-12-x.slides.txt",
    "content/drafts/2026-10-12-x-v1.slides.txt; rm -rf ~", ""
  ]) assert.ok(!argument.test(bad), bad);
});

// LinkedIn's authorization link and code stay in Gabriel's terminal, and Instagram's token is typed there; the agents
// may only run the exchange and the refresh, with no other argument.
test("the token commands take no other argument", () => {
  const exchange = new RegExp(approvals.agents.linkedin.allowlist[1].argPattern);
  assert.ok(exchange.test("exchange"));
  for (const bad of ["url", "exchange AQTQmah11lalyH65DAIivsjs", "exchange ", "exchange;id", ""]) assert.ok(!exchange.test(bad), bad);
  const refresh = new RegExp(approvals.agents.instagram.allowlist[1].argPattern);
  assert.ok(refresh.test("refresh"));
  for (const bad of ["store", "refresh IGAAtoken", "refresh ", "refresh;id", ""]) assert.ok(!refresh.test(bad), bad);
});

// A message carrying "/exec security=full ask=off" replaces tools.exec for that turn; only these floors in the host
// approvals record still apply (security takes the stricter value, ask the more demanding one).
test("the approvals record floors every agent at ask always and a denied fallback", () => {
  assert.deepEqual(approvals.defaults, { security: "deny", ask: "always", askFallback: "deny" });
  for (const id of working) {
    const agent = approvals.agents[id];
    assert.deepEqual([agent.security, agent.ask, agent.askFallback], ["allowlist", "always", "deny"]);
  }
  const { main } = approvals.agents;
  assert.deepEqual([main.security, main.ask, main.askFallback], ["deny", "always", "deny"]);
});
