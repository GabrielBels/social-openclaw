import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executionForDate, executionFromId, readEditorialMetadata } from "../../instagram/publisher/lib/editorial.mjs";
import { claimPublication } from "../../instagram/publisher/lib/publication-state.mjs";

test("each week has three executions identified by its Monday, independent of missed executions", () => {
  const executions = ["2026-10-19", "2026-10-21", "2026-10-23"].map(executionForDate);
  assert.deepEqual(executions.map(x => x.id), ["2026-10-19-1", "2026-10-19-2", "2026-10-19-3"]);
  assert.equal(executionForDate("2026-10-16").id, "2026-10-12-3");
  assert.deepEqual(executionFromId("2026-10-19-2"), executions[1]);
});

test("week identity survives a year boundary and rejects invalid dates or non-scheduled days", () => {
  assert.equal(executionForDate("2027-01-01").id, "2026-12-28-3");
  for (const date of ["2026-02-30", "2026-10-20", "not-a-date"]) assert.throws(() => executionForDate(date));
  for (const id of ["2026-10-20-1", "2026-10-19-4", "../../secret"]) assert.throws(() => executionFromId(id));
});

test("any execution day takes any editorial format, but not an unknown one", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ig-editorial-format-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = async (draft, value) => {
    const file = path.join(root, draft);
    await writeFile(file.replace(/\.md$/, ".editorial.json"), JSON.stringify(value));
    return readEditorialMetadata(file);
  };
  const friday = await metadata("2026-10-30-pedidos-v1.md", { executionId: "2026-10-26-3", format: "carousel-practical" });
  assert.equal(friday.format, "carousel-practical");
  assert.equal(friday.id, "2026-10-26-3");
  const monday = await metadata("2026-10-26-conferencias-v1.md", { executionId: "2026-10-26-1", format: "carousel-educational" });
  assert.equal(monday.format, "carousel-educational");
  await assert.rejects(metadata("2026-10-26-conferencias-v2.md", { executionId: "2026-10-26-1", format: "reel", version: 2 }), /editorial format must be one of/);
  await assert.rejects(metadata("2026-10-28-pedidos-v1.md", { executionId: "2026-10-26-2", format: "story" }), /editorial format must be one of/);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ig-publication-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, draft: path.join(root, "v1.md"), metadata: { id: "2026-10-19-1" } };
}

test("a concurrent or uncertain execution cannot acquire another publication claim", async t => {
  const { root, draft, metadata } = await fixture(t);
  const claim = await claimPublication(root, draft, metadata);
  await assert.rejects(claimPublication(root, draft, metadata), error => error.outcome === "unknown");
  await claim.failed("unknown");
  await assert.rejects(claimPublication(root, draft, metadata), error => error.outcome === "unknown");
});

test("a proven not-posted failure can be retried, but published revisions share one identity", async t => {
  const { root, draft, metadata } = await fixture(t);
  const claim = await claimPublication(root, draft, metadata);
  await claim.failed("not_posted");
  const retry = await claimPublication(root, draft, metadata);
  await retry.published({ mediaId: "179001", url: "https://www.instagram.com/p/AbC123/" });
  await retry.failed("not_posted");
  await assert.rejects(claimPublication(root, path.join(root, "v2.md"), metadata), /already published/);
});
