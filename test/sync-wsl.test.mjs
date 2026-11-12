import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sync = readFileSync(new URL("../scripts/sync-wsl.ps1", import.meta.url), "utf8");

// A revision from before the LinkedIn renderer has no lockfile and no render.mjs, and one from before the Instagram
// renderer has no Instagram render.mjs. Redeploying it (a rollback) must not name what it lacks, or `git archive`,
// `npm ci` and `chmod` fail before anything is installed.
test("the deploy archives the lockfile, installs dependencies and marks each renderer only for revisions that have them", () => {
  assert.match(sync, /ls-tree --name-only \$revision package-lock\.json\) \{ \$paths \+= 'package-lock\.json' \}/);
  assert.doesNotMatch(sync, /archive --format=tar "--output=\$archive" \$revision[^\n]*package-lock\.json/);
  assert.match(sync, /if \[ -f "\$stage\/package-lock\.json" \]; then\n\s+\(cd "\$stage" && [^\n]*npm-cli\.js" ci /);
  assert.match(sync, /if \[ -e "\$stage\/linkedin\/publisher\/render\.mjs" \]; then chmod u\+x/);
  assert.match(sync, /if \[ -e "\$stage\/instagram\/publisher\/render\.mjs" \]; then chmod u\+x/);
  assert.doesNotMatch(sync, /^chmod u\+x [^\n]*render\.mjs/m);
});
