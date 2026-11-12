import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function files(directory) {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(directory, entry.name);
    return entry.isDirectory() ? files(relative) : [relative];
  });
}

// The deploy runs this suite on the archived revision in WSL before changing anything, so a CRLF archive (a
// `#!…/node\r` shebang, a `UMask=0077\r` drop-in) is refused there.
test("files that run on Linux use LF line endings", () => {
  const deployed = ["linkedin", "instagram", "scripts", "systemd", "config"].flatMap(files)
    .filter(file => !/\.(ps1|png|jpe?g|mp4|ttf)$/i.test(file));
  const offenders = deployed.filter(file => readFileSync(path.join(root, file)).includes(0x0d));
  assert.deepEqual(offenders, []);
});

// The exec allowlist names these files by path, so each runs on its own shebang.
test("every script the agents or Gabriel run directly has the bundled Node as its shebang", () => {
  for (const file of [
    "linkedin/publisher/publish.mjs", "linkedin/publisher/render.mjs", "linkedin/scripts/auth.mjs", "linkedin/scripts/store-client-secret.mjs",
    "instagram/publisher/publish.mjs", "instagram/publisher/render.mjs", "instagram/scripts/token.mjs"
  ]) {
    const firstLine = readFileSync(path.join(root, file), "utf8").split("\n")[0];
    assert.equal(firstLine, "#!/home/openclaw/.openclaw/tools/node/bin/node", file);
  }
});
