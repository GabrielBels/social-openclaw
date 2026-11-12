// LinkedIn's "little text" format treats these characters as markup. Left unescaped, the post is silently cut at the
// first one, so every occurrence is escaped and the post renders exactly as written (a plain "#AI" stays text).
const reserved = /[|{}@[\]()<>#\\*_~]/g;

export function escapeLittleText(text) {
  return text.replace(reserved, character => `\\${character}`);
}
