import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DraftError } from "./draft.mjs";

function uncertain(message) {
  const error = new DraftError(message);
  error.outcome = "unknown";
  return error;
}

// The claim survives crashes and uncertain responses. Only a proven not-posted result releases it.
export async function claimPublication(workspaceRoot, draftPath, metadata) {
  const identity = metadata?.id ?? path.basename(draftPath);
  const root = await realpath(workspaceRoot);
  const state = path.join(root, "state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  if (await realpath(state) !== state) throw new DraftError("publication state must remain inside the workspace");
  const directory = path.join(state, "instagram-publications");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw new DraftError("publication state must remain inside the workspace");
  const key = createHash("sha256").update(identity).digest("hex");
  const file = path.join(directory, `${key}.json`);
  const initial = { identity, draft: path.basename(draftPath), status: "publishing" };
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!(await lstat(file)).isFile()) throw uncertain("publication state is not a regular file; manual verification is required");
    let previous;
    try { previous = JSON.parse(await readFile(file, "utf8")); } catch { throw uncertain("publication state is incomplete; check Instagram before any manual recovery"); }
    if (previous.status === "published") throw new DraftError(`this execution is already published (${previous.url ?? previous.mediaId}); nothing was posted again`);
    throw uncertain("this execution is in progress or its publication is uncertain; check Instagram before any manual recovery");
  }
  try { await handle.writeFile(JSON.stringify(initial)); await handle.sync(); } finally { await handle.close(); }
  let published = false;
  async function save(record) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  }
  return {
    async published(receipt) {
      await save({ ...initial, ...receipt, status: "published" });
      published = true;
    },
    async failed(status) {
      if (published) return;
      if (status === "not_posted") await unlink(file);
      else await save({ ...initial, status: "unknown" });
    }
  };
}
