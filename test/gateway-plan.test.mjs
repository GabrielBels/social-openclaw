import assert from "node:assert/strict";
import test from "node:test";
import { POST_TOOLS, jobArgs, planApprovals, planJob, postJobs, readOperator, render } from "../scripts/lib/gateway-plan.mjs";

const operator = {
  telegramUserId: "123456789", webSearchProvider: "duckduckgo", imageModel: "openai/gpt-test-image",
  imageResponsesModel: "openai/gpt-test-responses",
  linkedin: {
    model: "openai/gpt-test-model", fallbackModel: "anthropic/claude-test-model", thinking: "high", cron: "15 8 * * 2",
    tz: "Europe/Lisbon"
  },
  instagram: {
    model: "openai/gpt-other-model", fallbackModel: "anthropic/claude-other-model", thinking: "medium", cron: "0 8 * * 1,3,5",
    tz: "America/Sao_Paulo"
  }
};

test("reads the operator's store values and refuses malformed ones, naming the store entry", () => {
  assert.deepEqual(readOperator({
    ...operator, telegramUserId: 123456789, linkedin: { ...operator.linkedin, cron: " 15  8 * * 2 " }
  }), operator);
  assert.throws(() => readOperator(undefined), /SOCIAL_TELEGRAM_USER_ID/);
  for (const telegramUserId of [undefined, "", "@gabriel", "-100123456", "12"]) {
    assert.throws(() => readOperator({ ...operator, telegramUserId }), /SOCIAL_TELEGRAM_USER_ID/);
  }
  for (const webSearchProvider of [undefined, "", "DuckDuckGo", "duck duck", "-brave", "x"]) {
    assert.throws(() => readOperator({ ...operator, webSearchProvider }), /SOCIAL_WEB_SEARCH_PROVIDER/, webSearchProvider);
  }
  for (const imageModel of [undefined, "", "gpt-image-2", "openai/gpt image"]) {
    assert.throws(() => readOperator({ ...operator, imageModel }), /SOCIAL_IMAGE_MODEL/, imageModel);
  }
  // image_generate retries only with openai/ models, so any other provider would never be used.
  for (const imageResponsesModel of [undefined, "", "gpt-5.6-terra", "openai/", "openai/gpt terra", "anthropic/claude-test-model"]) {
    assert.throws(() => readOperator({ ...operator, imageResponsesModel }), /SOCIAL_IMAGE_RESPONSES_MODEL/, imageResponsesModel);
  }
  const entries = {
    linkedin: {
      model: "LINKEDIN_MODEL", fallbackModel: "LINKEDIN_FALLBACK_MODEL", thinking: "LINKEDIN_THINKING", cron: "LINKEDIN_SCOUT_CRON",
      tz: "LINKEDIN_SCOUT_TZ"
    },
    instagram: {
      model: "INSTAGRAM_MODEL", fallbackModel: "INSTAGRAM_FALLBACK_MODEL", thinking: "INSTAGRAM_THINKING", cron: "INSTAGRAM_POST_CRON",
      tz: "INSTAGRAM_POST_TZ"
    }
  };
  for (const agent of ["linkedin", "instagram"]) {
    const bad = (field, value) => readOperator({ ...operator, [agent]: { ...operator[agent], [field]: value } });
    assert.throws(() => readOperator({ ...operator, [agent]: undefined }), new RegExp(entries[agent].model));
    for (const model of [undefined, "", "gpt-6-sol", "openai/", "openai/gpt 6", "openai/*", "../etc/passwd"]) {
      assert.throws(() => bad("model", model), new RegExp(entries[agent].model), model);
    }
    // Only a Claude model on the Anthropic API: not another provider, and not the Claude CLI route.
    for (const fallbackModel of [undefined, "", "claude-opus-5-5", "anthropic/", "anthropic/*", "anthropic/claude opus",
      "openai/gpt-test-model", "claude-cli/claude-opus-5-5"]) {
      assert.throws(() => bad("fallbackModel", fallbackModel), new RegExp(entries[agent].fallbackModel), fallbackModel);
    }
    const trimmed = readOperator({ ...operator, [agent]: { ...operator[agent], fallbackModel: " anthropic/claude-opus-5-5 " } });
    assert.equal(trimmed[agent].fallbackModel, "anthropic/claude-opus-5-5");
    for (const thinking of [undefined, "", "High", "very high", "x"]) {
      assert.throws(() => bad("thinking", thinking), new RegExp(entries[agent].thinking), thinking);
    }
    for (const cron of [undefined, "", "30 9 * *", "30 9 * * 1,4 extra", "30 9 * * 1;id"]) {
      assert.throws(() => bad("cron", cron), new RegExp(entries[agent].cron), cron);
    }
    for (const tz of [undefined, "", "Mars/Olympus", "America/Sao Paulo"]) {
      assert.throws(() => bad("tz", tz), new RegExp(entries[agent].tz), tz);
    }
  }
});

test("renders placeholders in nested strings, arrays and object keys", () => {
  const rendered = render({
    a: ["__TELEGRAM_USER_ID__", 1, true], d: null,
    linkedin: {
      model: { primary: "__LINKEDIN_MODEL__", fallbacks: ["__LINKEDIN_FALLBACK_MODEL__"] },
      models: { __LINKEDIN_MODEL__: { thinking: "__LINKEDIN_THINKING__" }, __LINKEDIN_FALLBACK_MODEL__: {}, "openai/*": {} }
    },
    instagram: {
      model: { primary: "__INSTAGRAM_MODEL__", fallbacks: ["__INSTAGRAM_FALLBACK_MODEL__"] },
      models: { __INSTAGRAM_MODEL__: { thinking: "__INSTAGRAM_THINKING__" }, __INSTAGRAM_FALLBACK_MODEL__: {} }
    },
    search: "__WEB_SEARCH_PROVIDER__", image: "__IMAGE_MODEL__", responses: "__IMAGE_RESPONSES_MODEL__"
  }, operator);
  assert.deepEqual(rendered, {
    a: ["123456789", 1, true], d: null,
    linkedin: {
      model: { primary: "openai/gpt-test-model", fallbacks: ["anthropic/claude-test-model"] },
      models: { "openai/gpt-test-model": { thinking: "high" }, "anthropic/claude-test-model": {}, "openai/*": {} }
    },
    instagram: {
      model: { primary: "openai/gpt-other-model", fallbacks: ["anthropic/claude-other-model"] },
      models: { "openai/gpt-other-model": { thinking: "medium" }, "anthropic/claude-other-model": {} }
    },
    search: "duckduckgo", image: "openai/gpt-test-image", responses: "openai/gpt-test-responses"
  });
});

test("refuses a template with an unknown or unfilled placeholder", () => {
  assert.throws(() => render({ a: "__SOMETHING_ELSE__" }, operator), /unrendered placeholder/);
  assert.throws(() => render({ __WORKSPACE__: {} }, operator), /unrendered placeholder in config: __WORKSPACE__/);
  assert.throws(() => render({ __INSTAGRAM_MODEL__: {} }, { telegramUserId: "123456789" }), /unrendered placeholder in config: __INSTAGRAM_MODEL__/);
  assert.throws(() => render({ a: ["__LINKEDIN_FALLBACK_MODEL__"] }, { ...operator, linkedin: { model: "openai/gpt-test-model" } }),
    /unrendered placeholder in config: __LINKEDIN_FALLBACK_MODEL__/);
});

test("each agent's post runs on its own schedule, isolated, announced through its own bot to Gabriel's DM", () => {
  const [linkedin, instagram] = postJobs(operator);
  assert.deepEqual([linkedin.name, instagram.name], ["linkedin-scout", "instagram-post"]);
  assert.deepEqual(linkedin.schedule, { kind: "cron", expr: "15 8 * * 2", tz: "Europe/Lisbon", staggerMs: 0 });
  assert.deepEqual(instagram.schedule, { kind: "cron", expr: "0 8 * * 1,3,5", tz: "America/Sao_Paulo", staggerMs: 0 });
  for (const [job, agent] of [[linkedin, "linkedin"], [instagram, "instagram"]]) {
    assert.equal(job.agentId, agent);
    assert.equal(job.sessionTarget, "isolated");
    assert.deepEqual(job.delivery, { mode: "announce", channel: "telegram", to: "123456789", accountId: agent });
    const args = jobArgs(job, "create");
    assert.equal(args[args.indexOf("--cron") + 1], job.schedule.expr);
    assert.equal(args[args.indexOf("--tz") + 1], job.schedule.tz);
    assert.equal(args[args.indexOf("--agent") + 1], agent);
    assert.equal(args[args.indexOf("--account") + 1], agent);
  }
  assert.match(instagram.payload.message, /section 1 \(Post\) of AGENTS\.md/);
  assert.match(instagram.payload.message, /Never run any command/);
});

test("a scheduled post can make its images but can never exec", () => {
  assert.ok(POST_TOOLS.includes("image_generate"));
  assert.ok(!POST_TOOLS.includes("exec"));
  const [linkedin, instagram] = postJobs(operator);
  // LinkedIn writes its image as SVG; drawing it needs render.mjs, which a scheduled post cannot run.
  assert.deepEqual(linkedin.payload.toolsAllow, POST_TOOLS.filter(tool => tool !== "image_generate"));
  assert.deepEqual(instagram.payload.toolsAllow, POST_TOOLS);
  for (const job of [linkedin, instagram]) {
    assert.ok(!job.payload.toolsAllow.includes("exec"));
    const args = jobArgs(job, "create");
    assert.equal(args[args.indexOf("--tools") + 1], job.payload.toolsAllow.join(","));
  }
  assert.match(linkedin.payload.message, /its SVG image/);
  assert.match(linkedin.payload.message, /Never run any command/);
});

test("creates a job when missing", () => {
  const plan = planJob(postJobs(operator)[1], [{ id: "x", name: "linkedin-scout" }]);
  assert.equal(plan.action, "create");
  assert.deepEqual(plan.args.slice(0, 2), ["--name", "instagram-post"]);
});

test("leaves a job that already matches untouched", () => {
  for (const desired of postJobs(operator)) {
    const current = { ...structuredClone(desired), id: "job-1", state: { lastRunAt: 1 } };
    assert.deepEqual(planJob(desired, [current]), { action: "none", id: "job-1" });
  }
});

test("edits a job that drifted, naming what changed", () => {
  const desired = postJobs(operator)[0];
  const current = { ...structuredClone(desired), id: "job-1", enabled: false };
  current.payload.toolsAllow = ["exec"];
  current.schedule.expr = "0 9 * * *";
  const plan = planJob(desired, [current]);
  assert.equal(plan.action, "update");
  assert.equal(plan.id, "job-1");
  assert.deepEqual(plan.drift, ["enabled", "schedule", "payload.toolsAllow"]);
  assert.ok(plan.args.includes("--enable"));
  assert.ok(!plan.args.includes("--name"));
});

test("a job announcing through another bot is drift", () => {
  const desired = postJobs(operator)[1];
  for (const accountId of [undefined, "linkedin"]) {
    const current = { ...structuredClone(desired), id: "job-2" };
    current.delivery.accountId = accountId;
    assert.deepEqual(planJob(desired, [current]).drift, ["delivery"]);
  }
});

test("refuses to guess between two jobs with the same name", () => {
  const desired = postJobs(operator)[1];
  assert.throws(() => planJob(desired, [{ id: "a", name: "instagram-post" }, { id: "b", name: "instagram-post" }]), /more than one/);
});

const publisher = { pattern: "/home/openclaw/.openclaw-social/social-openclaw/linkedin/publisher/publish.mjs", argPattern: "^content/drafts/x[.]md$" };
const floors = { security: "allowlist", ask: "always", askFallback: "deny" };
const desired = {
  defaults: { security: "deny", ask: "always", askFallback: "deny" },
  agents: { linkedin: { ...floors, allowlist: [publisher] }, main: { security: "deny", ask: "always", askFallback: "deny", allowlist: [] } }
};
const settled = () => ({
  version: 1, socket: { path: "/x.sock" },
  defaults: { security: "deny", ask: "always", askFallback: "deny" },
  agents: { linkedin: { ...floors, allowlist: [{ ...publisher, id: "u1", lastUsedAt: 1 }] }, main: { security: "deny", ask: "always", askFallback: "deny", allowlist: [] } }
});

test("a record that already holds the floors and the allowlist needs no change, whatever ids OpenClaw added", () => {
  const record = settled();
  assert.deepEqual(planApprovals(desired, record), { drift: [], file: record });
});

test("an empty record gets every floor and exactly the publisher, keeping its other fields", () => {
  const { drift, file } = planApprovals(desired, { version: 1, socket: { path: "/x.sock" }, defaults: {}, agents: {} });
  assert.deepEqual(drift, ["defaults.security", "defaults.ask", "defaults.askFallback",
    "linkedin.security", "linkedin.ask", "linkedin.askFallback", "linkedin.allowlist",
    "main.security", "main.ask", "main.askFallback"]);
  assert.deepEqual(file.socket, { path: "/x.sock" });
  assert.deepEqual(file.defaults, { security: "deny", ask: "always", askFallback: "deny" });
  assert.deepEqual(file.agents.linkedin, { ...floors, allowlist: [publisher] });
});

test("a loosened floor is drift and is put back (the /exec security=full ask=off defense)", () => {
  const record = settled();
  record.agents.linkedin.ask = "off";
  record.agents.linkedin.security = "full";
  const { drift, file } = planApprovals(desired, record);
  assert.deepEqual(drift, ["linkedin.security", "linkedin.ask"]);
  assert.equal(file.agents.linkedin.security, "allowlist");
  assert.equal(file.agents.linkedin.ask, "always");
  assert.equal(record.agents.linkedin.ask, "off", "the input record is not mutated");
});

test("a missing argPattern or an extra entry is drift, and matching entries keep their ids", () => {
  const record = settled();
  record.agents.linkedin.allowlist.push({ pattern: "/usr/bin/node" });
  record.agents.main.allowlist = [{ pattern: "/bin/sh" }];
  const { drift, file } = planApprovals(desired, record);
  assert.deepEqual(drift, ["linkedin.allowlist", "main.allowlist"]);
  assert.deepEqual(file.agents.linkedin.allowlist, [{ ...publisher, id: "u1", lastUsedAt: 1 }]);
  assert.deepEqual(file.agents.main.allowlist, []);
});
