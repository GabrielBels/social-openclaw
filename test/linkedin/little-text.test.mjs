import assert from "node:assert/strict";
import test from "node:test";
import { escapeLittleText } from "../../linkedin/publisher/lib/little-text.mjs";

for (const character of ["|", "{", "}", "@", "[", "]", "(", ")", "<", ">", "#", "\\", "*", "_", "~"]) {
  test(`escapes reserved character ${character}`, () => {
    assert.equal(escapeLittleText(`a${character}b`), `a\\${character}b`);
  });
}

test("escapes every occurrence in a realistic post", () => {
  const post = "Evidence over hype (always).\n\nRead the spec [v2] @ 9am: x*y_z ~ <ok> | {done}\n\n#AI #DotNet";
  assert.equal(
    escapeLittleText(post),
    "Evidence over hype \\(always\\).\n\nRead the spec \\[v2\\] \\@ 9am: x\\*y\\_z \\~ \\<ok\\> \\| \\{done\\}\n\n\\#AI \\#DotNet"
  );
});

test("leaves ordinary text, punctuation, accents and emoji untouched", () => {
  const text = "Plain text, with: punctuation! \"quotes\" 'apostrophes' — dashes; über 100% ✅";
  assert.equal(escapeLittleText(text), text);
});
