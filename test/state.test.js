import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyState,
  offerKey,
  loadState,
  saveState,
  selectNewOffers,
  recordNotified,
  DEFAULT_CAP,
  STATE_VERSION,
} from "../scripts/lib/state.js";

const NOW = new Date("2026-05-01T12:00:00Z");

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "rcm69-state-"));
  return { dir, path: join(dir, "state.json"), cleanup: () => rmSync(dir, { recursive: true }) };
}

const baseOffer = {
  offerId: "A",
  productId: "NS-A",
  title: "Title v1",
  startDate: "2026-05-01T00:00:00Z",
  endDate: "2026-05-08T00:00:00Z",
};

test("state: emptyState shape", () => {
  const s = emptyState();
  assert.deepEqual(s, { version: STATE_VERSION, entries: [] });
});

test("state: offerKey uses offerId + startDate + endDate (NOT title)", () => {
  assert.equal(offerKey(baseOffer), "A|2026-05-01T00:00:00Z|2026-05-08T00:00:00Z");
  // Title-only changes must not change the key (RCM-65 forbids title-only dedupe).
  const titleChanged = { ...baseOffer, title: "Title v2" };
  assert.equal(offerKey(titleChanged), offerKey(baseOffer));
});

test("state: offerKey falls back to productId when offerId is missing", () => {
  const o = { ...baseOffer, offerId: "" };
  assert.equal(offerKey(o), "NS-A|2026-05-01T00:00:00Z|2026-05-08T00:00:00Z");
});

test("state: offerKey throws when all of offerId/productId are missing", () => {
  assert.throws(() => offerKey({ ...baseOffer, offerId: "", productId: "" }));
});

test("state: offerKey throws when startDate or endDate missing", () => {
  assert.throws(() => offerKey({ ...baseOffer, startDate: "" }));
  assert.throws(() => offerKey({ ...baseOffer, endDate: "" }));
});

test("state: loadState returns empty when file does not exist", async () => {
  const t = tmp();
  try {
    const s = await loadState(t.path);
    assert.deepEqual(s, emptyState());
  } finally { t.cleanup(); }
});

test("state: loadState returns empty when file is corrupt JSON", async () => {
  const t = tmp();
  try {
    writeFileSync(t.path, "{ not json");
    const s = await loadState(t.path);
    assert.deepEqual(s, emptyState());
  } finally { t.cleanup(); }
});

test("state: loadState returns empty when entries is missing", async () => {
  const t = tmp();
  try {
    writeFileSync(t.path, JSON.stringify({ version: 1 }));
    const s = await loadState(t.path);
    assert.deepEqual(s, emptyState());
  } finally { t.cleanup(); }
});

test("state: loadState filters out malformed entries", async () => {
  const t = tmp();
  try {
    writeFileSync(t.path, JSON.stringify({
      version: 1,
      entries: [
        { key: "good|x|y", title: "ok", seenAt: "2026-05-01T00:00:00Z" },
        { title: "no key" },
        null,
        { key: "" },
      ],
    }));
    const s = await loadState(t.path);
    assert.equal(s.entries.length, 1);
    assert.equal(s.entries[0].key, "good|x|y");
  } finally { t.cleanup(); }
});

test("state: saveState/loadState round-trips", async () => {
  const t = tmp();
  try {
    const s1 = recordNotified(emptyState(), [baseOffer], { now: NOW });
    await saveState(s1, t.path);
    const s2 = await loadState(t.path);
    assert.equal(s2.entries.length, 1);
    assert.equal(s2.entries[0].key, offerKey(baseOffer));
  } finally { t.cleanup(); }
});

test("state: saveState only writes key/title/seenAt (NFR-3 — no secrets/PII)", async () => {
  const t = tmp();
  try {
    const offerWithExtras = {
      ...baseOffer,
      url: "https://store.epicgames.com/...",
      originalPrice: 1980,
      currencyCode: "JPY",
    };
    const s1 = recordNotified(emptyState(), [offerWithExtras], { now: NOW });
    await saveState(s1, t.path);
    const s2 = await loadState(t.path);
    assert.deepEqual(Object.keys(s2.entries[0]).sort(), ["key", "seenAt", "title"]);
  } finally { t.cleanup(); }
});

test("state: selectNewOffers returns offers not in state", () => {
  const s = recordNotified(emptyState(), [baseOffer], { now: NOW });
  const o2 = { ...baseOffer, offerId: "B" };
  assert.deepEqual(
    selectNewOffers([baseOffer, o2], s).map((o) => o.offerId),
    ["B"],
  );
});

test("state: selectNewOffers treats title-only changes as already-seen", () => {
  const s = recordNotified(emptyState(), [baseOffer], { now: NOW });
  const renamed = { ...baseOffer, title: "Renamed" };
  assert.equal(selectNewOffers([renamed], s).length, 0);
});

test("state: selectNewOffers treats endDate change as new (re-promo)", () => {
  const s = recordNotified(emptyState(), [baseOffer], { now: NOW });
  const repromo = { ...baseOffer, endDate: "2026-06-01T00:00:00Z" };
  assert.equal(selectNewOffers([repromo], s).length, 1);
});

test("state: selectNewOffers skips offers it cannot key (does NOT mark as new)", () => {
  // Skipping is the safe default — notifying without being able to record
  // would cause infinite re-notification.
  const s = emptyState();
  const malformed = { title: "no ids" };
  assert.equal(selectNewOffers([malformed], s).length, 0);
});

test("state: recordNotified is pure (input not mutated)", () => {
  const s = emptyState();
  const before = JSON.stringify(s);
  recordNotified(s, [baseOffer], { now: NOW });
  assert.equal(JSON.stringify(s), before);
});

test("state: recordNotified does not duplicate existing keys", () => {
  let s = emptyState();
  s = recordNotified(s, [baseOffer], { now: NOW });
  s = recordNotified(s, [baseOffer], { now: NOW });
  assert.equal(s.entries.length, 1);
});

test("state: recordNotified caps to FIFO 1000 by default", () => {
  let s = emptyState();
  const many = Array.from({ length: DEFAULT_CAP + 5 }, (_, i) => ({
    offerId: `id-${i}`,
    startDate: "2026-05-01T00:00:00Z",
    endDate: "2026-05-08T00:00:00Z",
  }));
  s = recordNotified(s, many, { now: NOW });
  assert.equal(s.entries.length, DEFAULT_CAP);
  // Oldest entries dropped (FIFO).
  assert.equal(s.entries[0].key, `id-5|2026-05-01T00:00:00Z|2026-05-08T00:00:00Z`);
  assert.equal(s.entries[s.entries.length - 1].key, `id-${DEFAULT_CAP + 4}|2026-05-01T00:00:00Z|2026-05-08T00:00:00Z`);
});

test("state: recordNotified honors custom cap", () => {
  const five = Array.from({ length: 5 }, (_, i) => ({
    offerId: `X${i}`,
    startDate: "2026-05-01T00:00:00Z",
    endDate: "2026-05-08T00:00:00Z",
  }));
  const s = recordNotified(emptyState(), five, { cap: 3, now: NOW });
  assert.deepEqual(s.entries.map((e) => e.key.split("|")[0]), ["X2", "X3", "X4"]);
});

test("state: recordNotified silently skips offers it cannot key", () => {
  const s = recordNotified(emptyState(), [{ title: "no ids" }, baseOffer], { now: NOW });
  assert.equal(s.entries.length, 1);
  assert.equal(s.entries[0].key, offerKey(baseOffer));
});

test("state: recordNotified collapses duplicates within a single batch", () => {
  const s = recordNotified(emptyState(), [baseOffer, { ...baseOffer, title: "dup" }], { now: NOW });
  assert.equal(s.entries.length, 1);
});

test("state: 'failure path' — caller passes [] on Slack failure → state unchanged", () => {
  // Simulates the wiring contract: only offers whose Slack POST returned ok:true
  // should be passed to recordNotified. This test pins that contract.
  const before = recordNotified(emptyState(), [baseOffer], { now: NOW });
  const after = recordNotified(before, [], { now: NOW }); // Slack failed → []
  assert.deepEqual(after.entries.map((e) => e.key), before.entries.map((e) => e.key));
});
