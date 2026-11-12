import { readFile } from "node:fs/promises";
import { DraftError } from "./draft.mjs";

export const WEEKLY_FORMATS = ["carousel-educational", "carousel-practical"];

function calendarDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new DraftError("editorial dates must be valid YYYY-MM-DD calendar dates");
  }
  return date;
}

export function executionForDate(value) {
  const date = calendarDate(value);
  const slot = { 1: 1, 3: 2, 5: 3 }[date.getUTCDay()];
  if (!slot) throw new DraftError("scheduled editorial executions run on Monday, Wednesday or Friday");
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  const week = date.toISOString().slice(0, 10);
  return { week, slot, id: `${week}-${slot}`, date: value };
}

export function executionFromId(id) {
  const match = /^(\d{4}-\d{2}-\d{2})-([123])$/.exec(String(id));
  if (!match) throw new DraftError("editorial executionId must be <Monday YYYY-MM-DD>-<1|2|3>");
  const date = calendarDate(match[1]);
  if (date.getUTCDay() !== 1) throw new DraftError("editorial week must start on Monday");
  date.setUTCDate(date.getUTCDate() + (Number(match[2]) - 1) * 2);
  return executionForDate(date.toISOString().slice(0, 10));
}

export async function readEditorialMetadata(draftPath) {
  let text;
  try {
    text = await readFile(`${draftPath.slice(0, -3)}.editorial.json`, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let metadata;
  try { metadata = JSON.parse(text); } catch { throw new DraftError("invalid editorial metadata JSON"); }
  const execution = executionFromId(metadata?.executionId);
  if (!WEEKLY_FORMATS.includes(metadata.format)) throw new DraftError(`editorial format must be one of ${WEEKLY_FORMATS.join(", ")}`);
  return { ...metadata, ...execution };
}
