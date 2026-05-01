import { test } from "node:test";
import assert from "node:assert/strict";
import {
  notifyOffer,
  notifyOffers,
  buildMessageText,
  formatJst,
  formatRemaining,
  formatPrice,
} from "../scripts/lib/notifier.js";

const NOW = new Date("2026-05-01T03:00:00Z"); // JST 12:00
const SECRET_WEBHOOK = "https://hooks.slack.com/services/SUPER/SECRET/TOKEN12345";

const sampleOffer = {
  offerId: "A",
  productId: "NS-A",
  title: "Example Game",
  startDate: "2026-04-30T15:00:00Z", // JST 2026-05-01 00:00
  endDate: "2026-05-02T15:00:00Z",   // JST 2026-05-03 00:00
  originalPrice: 2000,
  discountPrice: 0,
  currencyCode: "JPY",
  discountPercentage: 0,
  url: "https://store.epicgames.com/ja-JP/p/example-game",
  offerType: "BASE_GAME",
};

const silentLogger = { error: () => {}, warn: () => {}, info: () => {} };

// -------------------- formatJst --------------------

test("formatJst: renders Asia/Tokyo with YYYY/MM/DD HH:MM JST", () => {
  // 2026-05-03T15:00:00Z == JST 2026-05-04 00:00
  assert.equal(formatJst("2026-05-03T15:00:00Z"), "2026/05/04 00:00 JST");
});

test("formatJst: returns the input as-is when not parseable", () => {
  assert.equal(formatJst("garbage"), "garbage");
});

// -------------------- formatRemaining --------------------

test("formatRemaining: days + hours", () => {
  // end 2026-05-03T06:00Z, now 2026-05-01T03:00Z → 2d 3h
  assert.equal(formatRemaining("2026-05-03T06:00:00Z", NOW), "残り 2日3時間");
});

test("formatRemaining: minutes only when no days/hours", () => {
  assert.equal(formatRemaining("2026-05-01T03:45:00Z", NOW), "残り 45分");
});

test("formatRemaining: <1 minute fallback", () => {
  assert.equal(formatRemaining("2026-05-01T03:00:30Z", NOW), "残り 1分未満");
});

test("formatRemaining: returns null for past dates", () => {
  assert.equal(formatRemaining("2026-04-30T00:00:00Z", NOW), null);
});

// -------------------- formatPrice --------------------

test("formatPrice: JPY (zero-decimal) treats input as major units", () => {
  // ja-JP locale uses the full-width yen sign ￥ — Slack renders identically.
  assert.match(formatPrice(1080, "JPY"), /1,080/);
});

test("formatPrice: USD treats input as cents", () => {
  assert.equal(formatPrice(1080, "USD"), "$10.80");
});

test("formatPrice: returns null on non-numeric or missing currency", () => {
  assert.equal(formatPrice(null, "JPY"), null);
  assert.equal(formatPrice(1080, null), null);
});

// -------------------- buildMessageText --------------------

test("buildMessageText: includes all required + recommended fields", () => {
  const text = buildMessageText(sampleOffer, { now: NOW });
  // Required (FR-5)
  assert.match(text, /タイトル: Example Game/);
  assert.match(text, /URL: https:\/\/store\.epicgames\.com\/ja-JP\/p\/example-game/);
  assert.match(text, /期限: 2026\/05\/03 00:00 JST/);
  // Recommended
  assert.match(text, /開始: 2026\/05\/01 00:00 JST/);
  assert.match(text, /検知日時: 2026\/05\/01 12:00 JST/);
  assert.match(text, /残り /);
  // Optional (price + type)
  assert.match(text, /通常価格: /);
  assert.match(text, /種別: 本体/);
});

test("buildMessageText: starts with the spec emoji header", () => {
  assert.ok(buildMessageText(sampleOffer, { now: NOW }).startsWith("🎮 Epic無料配布を検知"));
});

test("buildMessageText: gracefully handles offers missing optional fields", () => {
  const minimal = {
    offerId: "M",
    title: "Minimal",
    endDate: "2026-05-02T15:00:00Z",
    url: "https://store.epicgames.com/ja-JP/p/minimal",
  };
  const text = buildMessageText(minimal, { now: NOW });
  assert.match(text, /タイトル: Minimal/);
  assert.match(text, /期限: /);
  assert.doesNotMatch(text, /通常価格: /);
  assert.doesNotMatch(text, /種別: /);
});

test("buildMessageText: maps offerType to Japanese label", () => {
  assert.match(buildMessageText({ ...sampleOffer, offerType: "ADD_ON" }, { now: NOW }), /種別: DLC/);
  assert.match(buildMessageText({ ...sampleOffer, offerType: "BUNDLE" }, { now: NOW }), /種別: バンドル/);
});

// -------------------- notifyOffer --------------------

test("notifyOffer: returns ok:false when webhook URL is missing", async () => {
  const r = await notifyOffer(sampleOffer, { fetchImpl: () => { throw new Error("must not run"); }, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /SLACK_WEBHOOK_URL/);
});

test("notifyOffer: posts JSON with text payload to the webhook URL", async () => {
  const captured = [];
  const fakeFetch = async (url, init) => {
    captured.push({ url, init });
    return { ok: true, status: 200, text: async () => "" };
  };
  const r = await notifyOffer(sampleOffer, { webhookUrl: SECRET_WEBHOOK, fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, SECRET_WEBHOOK);
  assert.equal(captured[0].init.method, "POST");
  assert.equal(captured[0].init.headers["Content-Type"], "application/json");
  const body = JSON.parse(captured[0].init.body);
  assert.equal(typeof body.text, "string");
  assert.match(body.text, /Example Game/);
});

test("notifyOffer: payload does NOT contain the webhook URL (NFR-3)", async () => {
  let bodyStr = "";
  const fakeFetch = async (_url, init) => {
    bodyStr = init.body;
    return { ok: true, status: 200, text: async () => "" };
  };
  await notifyOffer(sampleOffer, { webhookUrl: SECRET_WEBHOOK, fetchImpl: fakeFetch, now: NOW });
  assert.doesNotMatch(bodyStr, /SUPER|SECRET|TOKEN12345/);
});

test("notifyOffer: HTTP error returns ok:false and does NOT throw", async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, statusText: "ISE", text: async () => "down" });
  const r = await notifyOffer(sampleOffer, {
    webhookUrl: SECRET_WEBHOOK, fetchImpl: fakeFetch, now: NOW, logger: silentLogger,
  });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /HTTP 500/);
});

test("notifyOffer: network throw returns ok:false and does NOT throw", async () => {
  const fakeFetch = async () => { throw new Error("ECONNRESET"); };
  const r = await notifyOffer(sampleOffer, {
    webhookUrl: SECRET_WEBHOOK, fetchImpl: fakeFetch, now: NOW, logger: silentLogger,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.message, "ECONNRESET");
});

test("notifyOffer: NFR-3 — webhook URL is never written to logs", async () => {
  const logged = [];
  const logger = { error: (m) => logged.push(m), warn: (m) => logged.push(m), info: (m) => logged.push(m) };
  const fakeFetch = async () => ({ ok: false, status: 500, statusText: "ISE", text: async () => "secret-body" });
  await notifyOffer(sampleOffer, { webhookUrl: SECRET_WEBHOOK, fetchImpl: fakeFetch, now: NOW, logger });
  assert.doesNotMatch(logged.join("\n"), /SUPER|SECRET|TOKEN12345/);
});

// -------------------- notifyOffers --------------------

test("notifyOffers: sends sequentially in input order", async () => {
  const order = [];
  const fakeFetch = async (_u, init) => {
    order.push(JSON.parse(init.body).text.match(/タイトル: (\S+)/)[1]);
    return { ok: true, status: 200, text: async () => "" };
  };
  await notifyOffers(
    [
      { ...sampleOffer, offerId: "A", title: "First" },
      { ...sampleOffer, offerId: "B", title: "Second" },
      { ...sampleOffer, offerId: "C", title: "Third" },
    ],
    { webhookUrl: SECRET_WEBHOOK, fetchImpl: fakeFetch, now: NOW },
  );
  assert.deepEqual(order, ["First", "Second", "Third"]);
});

test("notifyOffers: continues after a failure and reports per-offer status", async () => {
  let n = 0;
  const fakeFetch = async () => {
    n++;
    return n === 2
      ? { ok: false, status: 429, statusText: "Too Many", text: async () => "rate" }
      : { ok: true, status: 200, text: async () => "" };
  };
  const out = await notifyOffers(
    [
      { ...sampleOffer, offerId: "A" },
      { ...sampleOffer, offerId: "B" },
      { ...sampleOffer, offerId: "C" },
    ],
    { webhookUrl: SECRET_WEBHOOK, fetchImpl: fakeFetch, now: NOW, logger: silentLogger },
  );
  assert.deepEqual(
    out.map((r) => ({ id: r.offer.offerId, ok: r.ok })),
    [
      { id: "A", ok: true },
      { id: "B", ok: false },
      { id: "C", ok: true },
    ],
  );
});

test("notifyOffers: returns [] for empty / nullish input", async () => {
  const calls = [];
  const fakeFetch = async () => { calls.push(1); return { ok: true, status: 200, text: async () => "" }; };
  assert.deepEqual(await notifyOffers([], { webhookUrl: SECRET_WEBHOOK, fetchImpl: fakeFetch, now: NOW }), []);
  assert.deepEqual(await notifyOffers(undefined, { webhookUrl: SECRET_WEBHOOK, fetchImpl: fakeFetch, now: NOW }), []);
  assert.equal(calls.length, 0);
});
