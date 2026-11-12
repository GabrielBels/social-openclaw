#!/usr/bin/env node
// Brings the social Gateway in line with this repository, or previews it:
//   node scripts/apply-gateway.mjs plan|apply
// The operator's values come from the profile's OpenClaw store (env entries SOCIAL_TELEGRAM_USER_ID,
// SOCIAL_WEB_SEARCH_PROVIDER, SOCIAL_IMAGE_MODEL, SOCIAL_IMAGE_RESPONSES_MODEL, and each agent's model, fallback model,
// thinking level and schedule, listed in
// AGENT_ENTRIES of scripts/lib/gateway-plan.mjs).
// It owns the config fragment in config/openclaw.social.json, the exec approvals in config/exec-approvals.json and the
// linkedin-scout and instagram-post jobs. It only ever runs `openclaw --profile social …`, so the fleet Gateway is never
// touched.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AGENT_ENTRIES, PROFILE, planApprovals, planJob, postJobs, readOperator, render } from "./lib/gateway-plan.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(os.homedir(), ".openclaw-social", "openclaw.json");
const service = "openclaw-gateway-social.service";
// Objects the repository owns whole: a patch replaces them instead of merging, so a stale entry cannot survive.
// Agents are replaced one by one: OpenClaw refuses a write that drops an agent without an explicit deletion.
const replacePaths = ["agents.entries.linkedin", "agents.entries.instagram", "agents.entries.main", "bindings", "tools", "approvals",
  "channels.telegram", "skills.entries"];

function openclaw(args, { input } = {}) {
  const result = spawnSync("openclaw", ["--profile", PROFILE, ...args], { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error(`could not run openclaw: ${result.error.code}`);
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}`.trim().split("\n").at(-1) ?? "";
    throw new Error(`openclaw ${args.slice(0, 2).join(" ")} failed (exit ${result.status}): ${detail}`);
  }
  return result.stdout;
}

function json(text) {
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error("openclaw printed no JSON");
  return JSON.parse(text.slice(start));
}

// An env entry of the profile's OpenClaw store. Protected (secret) entries are write-only and cannot be read here.
function storeEnvValue(name) {
  try {
    return json(openclaw(["secrets", "store", "get", name, "--json"])).value;
  } catch {
    throw new Error(`${name} is not in the OpenClaw store as an env entry (docs/operations.md, Setup)`);
  }
}

function agentValues(entries) {
  return Object.fromEntries(Object.entries(entries).map(([field, name]) => [field, storeEnvValue(name)]));
}

function fileHash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function waitForGateway() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync("openclaw", ["--profile", PROFILE, "health"], { encoding: "utf8" });
    if (result.status === 0) return;
    spawnSync("sleep", ["2"]);
  }
  throw new Error("the social Gateway did not become healthy after the restart");
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (!["plan", "apply"].includes(mode) || rest.length !== 0) throw new Error("usage: apply-gateway.mjs plan|apply");
  const apply = mode === "apply";
  const operator = readOperator({
    telegramUserId: storeEnvValue("SOCIAL_TELEGRAM_USER_ID"),
    webSearchProvider: storeEnvValue("SOCIAL_WEB_SEARCH_PROVIDER"),
    imageModel: storeEnvValue("SOCIAL_IMAGE_MODEL"),
    imageResponsesModel: storeEnvValue("SOCIAL_IMAGE_RESPONSES_MODEL"),
    linkedin: agentValues(AGENT_ENTRIES.linkedin),
    instagram: agentValues(AGENT_ENTRIES.instagram)
  });
  const config = render(readJson(path.join(repository, "config", "openclaw.social.json")), operator);
  const approvals = readJson(path.join(repository, "config", "exec-approvals.json"));
  const replaceArgs = replacePaths.flatMap(item => ["--replace-path", item]);
  const summary = { mode };

  // 1. Config. The dry run validates the schema and that every SecretRef resolves; apply stops on any error.
  const dryRun = spawnSync("openclaw", ["--profile", PROFILE, "config", "patch", "--stdin", "--dry-run", "--json", ...replaceArgs],
    { input: JSON.stringify(config), encoding: "utf8" });
  const check = (() => { try { return json(dryRun.stdout); } catch { return { ok: false, errors: [{ message: "no dry-run result" }] }; } })();
  if (!check.ok) {
    const errors = (check.errors ?? []).map(error => error.message);
    if (apply) throw new Error(`config dry run failed: ${errors.join("; ")}`);
    summary.config = { invalid: errors };
  } else if (apply) {
    const before = fileHash(configPath);
    openclaw(["config", "patch", "--stdin", ...replaceArgs], { input: JSON.stringify(config) });
    summary.config = fileHash(configPath) === before ? "unchanged" : "changed";
    if (summary.config === "changed") {
      spawnSync("systemctl", ["--user", "restart", service], { stdio: "inherit" });
      waitForGateway();
      summary.restarted = true;
    }
  } else {
    summary.config = "validated";
  }

  // 2. Exec approvals: floors and allowlists. `allowlist add` cannot set argPattern or floors, so the record is read,
  // changed only where it drifted, and written back whole.
  const { drift, file } = planApprovals(approvals, json(openclaw(["approvals", "get", "--json"])).file);
  if (drift.length === 0) summary.approvals = "unchanged";
  else if (apply) {
    openclaw(["approvals", "set", "--stdin"], { input: JSON.stringify(file) });
    summary.approvals = { replaced: drift };
  } else summary.approvals = { wouldReplace: drift };

  // 3. Each agent's scheduled post.
  const listed = json(openclaw(["cron", "list", "--all", "--json"]));
  const jobs = Array.isArray(listed) ? listed : listed.jobs ?? [];
  summary.jobs = {};
  for (const desired of postJobs(operator)) {
    const plan = planJob(desired, jobs);
    if (plan.action === "none") summary.jobs[desired.name] = "unchanged";
    else if (!apply) summary.jobs[desired.name] = plan.action === "create" ? "would create" : `would update: ${plan.drift.join(", ")}`;
    else {
      openclaw(plan.action === "create" ? ["cron", "create", ...plan.args] : ["cron", "edit", plan.id, ...plan.args]);
      summary.jobs[desired.name] = plan.action === "create" ? "created" : `updated: ${plan.drift.join(", ")}`;
    }
  }

  console.log(JSON.stringify(summary));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "apply-gateway failed");
  process.exitCode = 1;
}
