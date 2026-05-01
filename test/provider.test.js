import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mapToOffers, fetchEpicFreeOffers } from "../scripts/providers/epic.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "fixtures", "epic-response.json");

async function loadFixture() {
  return JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
}

const silentLogger = { error: () => {}, warn: () => {}, info: () => {} };

test("provider: mapToOffers extracts an offer per promo from fixture", async () => {
  const json = await loadFixture();
  const offers = mapToOffers(json, { logger: silentLogger });
  // Active(1) + Two-promo(2) + Slug(1) + DLC(1) = 5; "No Promotion" element contributes 0.
  assert.equal(offers.length, 5);
});

test("provider: mapToOffers preserves promo dates and discountPercentage", async () => {
  const offers = mapToOffers(await loadFixture(), { logger: silentLogger });
  const active = offers.find((o) => o.title === "Active Free Game");
  assert.equal(active.startDate, "2026-04-30T15:00:00.000Z");
  assert.equal(active.endDate, "2026-05-07T15:00:00.000Z");
  assert.equal(active.discountPercentage, 0);
});

test("provider: mapToOffers maps price fields with currency", async () => {
  const offers = mapToOffers(await loadFixture(), { logger: silentLogger });
  const active = offers.find((o) => o.title === "Active Free Game");
  assert.equal(active.originalPrice, 1980);
  assert.equal(active.discountPrice, 0);
  assert.equal(active.currencyCode, "JPY");
});

test("provider: mapToOffers preserves offerType so the filter can gate DLC/BUNDLE", async () => {
  const offers = mapToOffers(await loadFixture(), { logger: silentLogger });
  const dlc = offers.find((o) => o.title === "Free DLC");
  assert.equal(dlc.offerType, "ADD_ON");
});

test("provider: mapToOffers builds store URL from productSlug", async () => {
  const offers = mapToOffers(await loadFixture(), { logger: silentLogger });
  const active = offers.find((o) => o.title === "Active Free Game");
  assert.equal(active.url, "https://store.epicgames.com/ja-JP/p/active-free-game");
});

test("provider: mapToOffers prefers catalogNs.mappings slug and strips trailing /home", async () => {
  const offers = mapToOffers(await loadFixture(), { logger: silentLogger });
  const slug = offers.find((o) => o.title === "Slug From CatalogNs");
  assert.equal(slug.url, "https://store.epicgames.com/ja-JP/p/from-catalog-ns");
});

test("provider: mapToOffers expands multiple promos within one element", async () => {
  const offers = mapToOffers(await loadFixture(), { logger: silentLogger });
  const multi = offers.filter((o) => o.title === "Two Promo Element");
  assert.equal(multi.length, 2);
  assert.deepEqual(multi.map((o) => o.endDate).sort(), [
    "2026-05-03T15:00:00.000Z",
    "2026-05-17T15:00:00.000Z",
  ]);
});

test("provider: mapToOffers throws on unexpected response shape", () => {
  assert.throws(() => mapToOffers({}, { logger: silentLogger }));
  assert.throws(() => mapToOffers({ data: { Catalog: { searchStore: { elements: "nope" } } } }, { logger: silentLogger }));
});

test("provider: mapToOffers skips elements with broken inner structure", async () => {
  const json = await loadFixture();
  // Inject an element where promotionalOffers is malformed
  json.data.Catalog.searchStore.elements.push({
    title: "broken",
    id: "x",
    namespace: "y",
    offerType: "BASE_GAME",
    promotions: { promotionalOffers: "not-an-array" },
  });
  const offers = mapToOffers(json, { logger: silentLogger });
  // Same count as before — broken element is skipped, not crashed on.
  assert.equal(offers.length, 5);
});

// fetchEpicFreeOffers — verify HTTP plumbing without real network.

test("fetchEpicFreeOffers: builds a query-param URL and sets headers", async () => {
  let captured;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, json: async () => await loadFixture() };
  };
  const offers = await fetchEpicFreeOffers({
    locale: "ja-JP",
    country: "JP",
    fetchImpl: fakeFetch,
    logger: silentLogger,
  });
  assert.ok(captured.url.includes("locale=ja-JP"));
  assert.ok(captured.url.includes("country=JP"));
  assert.ok(captured.url.includes("allowCountries=JP"));
  assert.equal(captured.init.headers.Accept, "application/json");
  assert.equal(captured.init.headers["Accept-Language"], "ja-JP");
  assert.equal(offers.length, 5);
});

test("fetchEpicFreeOffers: throws on HTTP error", async () => {
  const fakeFetch = async () => ({ ok: false, status: 502, statusText: "Bad Gateway", text: async () => "down" });
  await assert.rejects(
    fetchEpicFreeOffers({ fetchImpl: fakeFetch, logger: silentLogger }),
    /HTTP 502/,
  );
});

test("fetchEpicFreeOffers: throws on transport error", async () => {
  const fakeFetch = async () => { throw new Error("ENOTFOUND"); };
  await assert.rejects(
    fetchEpicFreeOffers({ fetchImpl: fakeFetch, logger: silentLogger }),
    /Epic API request failed/,
  );
});

test("fetchEpicFreeOffers: throws on JSON parse error", async () => {
  const fakeFetch = async () => ({
    ok: true, status: 200,
    json: async () => { throw new Error("invalid json"); },
  });
  await assert.rejects(
    fetchEpicFreeOffers({ fetchImpl: fakeFetch, logger: silentLogger }),
    /parse Epic API response/,
  );
});
