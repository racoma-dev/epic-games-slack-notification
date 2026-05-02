import { test } from "node:test";
import assert from "node:assert/strict";
import { filterCurrentFreeOffers } from "../scripts/lib/filter.js";

const NOW = new Date("2026-05-01T12:00:00Z");

const baseFree = {
  offerId: "A",
  title: "Active Free",
  startDate: "2026-04-30T00:00:00Z",
  endDate: "2026-05-07T00:00:00Z",
  originalPrice: 1080,
  discountPrice: 0,
  currencyCode: "JPY",
  discountPercentage: 0,
  offerType: "BASE_GAME",
  categoryPaths: ["games/edition/base"],
};

test("filter: passes a currently-active free offer", () => {
  const out = filterCurrentFreeOffers([baseFree], { now: NOW });
  assert.deepEqual(out.map((o) => o.offerId), ["A"]);
});

test("filter: drops offers whose startDate is in the future", () => {
  const upcoming = { ...baseFree, offerId: "U", startDate: "2026-06-01T00:00:00Z", endDate: "2026-06-08T00:00:00Z" };
  const out = filterCurrentFreeOffers([upcoming], { now: NOW });
  assert.equal(out.length, 0);
});

test("filter: drops offers whose endDate is in the past", () => {
  const expired = { ...baseFree, offerId: "X", startDate: "2026-04-01T00:00:00Z", endDate: "2026-04-15T00:00:00Z" };
  const out = filterCurrentFreeOffers([expired], { now: NOW });
  assert.equal(out.length, 0);
});

test("filter: window is start <= now < end (start boundary inclusive)", () => {
  const offer = { ...baseFree, startDate: NOW.toISOString(), endDate: "2026-05-07T00:00:00Z" };
  assert.equal(filterCurrentFreeOffers([offer], { now: NOW }).length, 1);
});

test("filter: window is start <= now < end (end boundary exclusive)", () => {
  const offer = { ...baseFree, startDate: "2026-04-01T00:00:00Z", endDate: NOW.toISOString() };
  assert.equal(filterCurrentFreeOffers([offer], { now: NOW }).length, 0);
});

test("filter: drops 50%-off offers (not effectively free)", () => {
  const half = { ...baseFree, discountPercentage: 50, discountPrice: 540 };
  assert.equal(filterCurrentFreeOffers([half], { now: NOW }).length, 0);
});

test("filter: accepts offers where discountPrice is 0 even if discountPercentage missing", () => {
  const offer = { ...baseFree, discountPercentage: null, discountPrice: 0 };
  assert.equal(filterCurrentFreeOffers([offer], { now: NOW }).length, 1);
});

test("filter: excludes permanent free-to-play (originalPrice == 0)", () => {
  const f2p = { ...baseFree, originalPrice: 0 };
  assert.equal(filterCurrentFreeOffers([f2p], { now: NOW }).length, 0);
});

test("filter: excludes DLC by default", () => {
  const dlc = {
    ...baseFree,
    offerId: "D",
    offerType: "ADD_ON",
    categoryPaths: ["addons"],
  };
  const out = filterCurrentFreeOffers([baseFree, dlc], { now: NOW });
  assert.deepEqual(out.map((o) => o.offerId), ["A"]);
});

test("filter: includes game bundles by category path", () => {
  const bundle = {
    ...baseFree,
    offerId: "B",
    offerType: "BUNDLE",
    categoryPaths: ["bundles/games"],
  };
  const out = filterCurrentFreeOffers([baseFree, bundle], { now: NOW });
  assert.deepEqual(out.map((o) => o.offerId).sort(), ["A", "B"]);
});

test("filter: excludes DLC and add-on bundles even when they are free", () => {
  const dlc = {
    ...baseFree,
    offerId: "D",
    offerType: "ADD_ON",
    categoryPaths: ["addons"],
  };
  const addonBundle = {
    ...baseFree,
    offerId: "B",
    offerType: "BUNDLE",
    categoryPaths: ["bundles/addons"],
  };
  const out = filterCurrentFreeOffers([baseFree, dlc, addonBundle], { now: NOW });
  assert.deepEqual(out.map((o) => o.offerId), ["A"]);
});

test("filter: now is injectable as Date / string / number", () => {
  const offer = { ...baseFree, startDate: "2026-04-30T00:00:00Z", endDate: "2026-05-07T00:00:00Z" };
  assert.equal(filterCurrentFreeOffers([offer], { now: NOW }).length, 1);
  assert.equal(filterCurrentFreeOffers([offer], { now: NOW.toISOString() }).length, 1);
  assert.equal(filterCurrentFreeOffers([offer], { now: NOW.getTime() }).length, 1);
});

test("filter: non-array input returns []", () => {
  assert.deepEqual(filterCurrentFreeOffers(null), []);
  assert.deepEqual(filterCurrentFreeOffers(undefined), []);
});

test("filter: drops offers with malformed dates rather than throwing", () => {
  const bad = { ...baseFree, startDate: "not-a-date", endDate: "also-bad" };
  assert.deepEqual(filterCurrentFreeOffers([bad, baseFree], { now: NOW }).map((o) => o.offerId), ["A"]);
});
