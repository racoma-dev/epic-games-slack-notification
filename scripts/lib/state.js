// Notification state (RCM-65 / Requirements FR-4 + FR-7).
//
// On-disk JSON keyed by offerId|startDate|endDate so an offer is never
// notified twice. Title is stored for human readability only — it is
// intentionally NOT part of the dedupe key (titles are localized and can
// change). Pure helpers are exported alongside file IO so they're testable
// in isolation (RCM-69).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_STATE_PATH = "data/seen-epic-offers.json";
export const DEFAULT_CAP = 1000;
export const STATE_VERSION = 1;

/**
 * @typedef {Object} StateEntry
 * @property {string} key     `${offerId}|${startDate}|${endDate}`
 * @property {string} title   Title at notification time. Display-only.
 * @property {string} seenAt  ISO 8601 timestamp.
 */
/**
 * @typedef {Object} State
 * @property {number} version
 * @property {StateEntry[]} entries  Oldest first; newest appended at the tail.
 */

export function emptyState() {
  return { version: STATE_VERSION, entries: [] };
}

/**
 * Build the dedupe key for an offer. Falls back to productId when offerId is
 * absent. Throws when none of the required pieces are present — callers must
 * not silently treat a malformed offer as "new".
 *
 * @param {import('../providers/epic.js').EpicOffer} offer
 * @returns {string}
 */
export function offerKey(offer) {
  const id = String(offer?.offerId || offer?.productId || "").trim();
  const start = String(offer?.startDate || "").trim();
  const end = String(offer?.endDate || "").trim();
  if (!id || !start || !end) {
    throw new Error(
      `Cannot build state key: missing offerId/productId/startDate/endDate (got id="${id}", start="${start}", end="${end}")`,
    );
  }
  return `${id}|${start}|${end}`;
}

/**
 * Read the state file. A missing file or unparseable contents both yield an
 * empty state — the script must keep working on first run and after a manual
 * wipe. Other IO errors propagate.
 *
 * @param {string} [path]
 * @returns {Promise<State>}
 */
export async function loadState(path = DEFAULT_STATE_PATH) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return emptyState();
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState();
  }
  if (!parsed || !Array.isArray(parsed.entries)) return emptyState();
  const entries = parsed.entries.filter(
    (e) => e && typeof e.key === "string" && e.key.length > 0,
  );
  return { version: STATE_VERSION, entries };
}

/**
 * Persist state to disk. Pretty-printed so git diffs are reviewable, with a
 * trailing newline for POSIX-friendliness.
 *
 * @param {State} state
 * @param {string} [path]
 */
export async function saveState(state, path = DEFAULT_STATE_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/**
 * Pure: pick offers whose key is NOT yet in state. Offers missing the fields
 * needed to build a key are skipped (treated as not new) so we never notify
 * for something we couldn't record afterwards.
 *
 * @param {import('../providers/epic.js').EpicOffer[]} offers
 * @param {State} state
 * @returns {import('../providers/epic.js').EpicOffer[]}
 */
export function selectNewOffers(offers, state) {
  const seen = new Set((state?.entries ?? []).map((e) => e.key));
  const out = [];
  for (const offer of offers ?? []) {
    let key;
    try {
      key = offerKey(offer);
    } catch {
      continue;
    }
    if (!seen.has(key)) out.push(offer);
  }
  return out;
}

/**
 * Pure: return a NEW state with `offers` appended. Caller is responsible for
 * only passing offers whose Slack notification succeeded — failed sends must
 * not be recorded, otherwise we silently lose them on the next run.
 *
 * Existing entries are preserved; duplicates within the input are collapsed.
 * The result is trimmed FIFO to `cap` items.
 *
 * @param {State} state
 * @param {import('../providers/epic.js').EpicOffer[]} offers
 * @param {Object} [opts]
 * @param {number} [opts.cap=DEFAULT_CAP]
 * @param {Date|string|number} [opts.now=new Date()]
 * @returns {State}
 */
export function recordNotified(
  state,
  offers,
  { cap = DEFAULT_CAP, now = new Date() } = {},
) {
  const base =
    state && Array.isArray(state.entries)
      ? { version: STATE_VERSION, entries: [...state.entries] }
      : emptyState();
  const seen = new Set(base.entries.map((e) => e.key));
  const seenAt = toIso(now);

  for (const offer of offers ?? []) {
    let key;
    try {
      key = offerKey(offer);
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    base.entries.push({
      key,
      title: String(offer?.title ?? ""),
      seenAt,
    });
  }

  if (cap > 0 && base.entries.length > cap) {
    base.entries.splice(0, base.entries.length - cap);
  }
  return base;
}

function toIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "number") return new Date(now).toISOString();
  return new Date(String(now)).toISOString();
}
