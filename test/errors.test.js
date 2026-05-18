// RCM-68: error-handling guarantees that span layers.
//
// These tests pin the contracts the entry point relies on:
//   - Each pipeline layer throws / returns its own typed error so failures
//     can be attributed in CI logs.
//   - Webhook URLs are redacted from any text that could reach the logs,
//     even when a transport error embeds the URL in its message (NFR-3).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EpicFetchError,
  EpicResponseError,
  SlackNotifyError,
  errorLayer,
  redactSecrets,
} from "../scripts/lib/errors.js";
import {
  fetchEpicFreeOffers,
  mapToOffers,
} from "../scripts/providers/epic.js";
import { notifyOffer } from "../scripts/lib/notifier.js";

const SECRET_WEBHOOK = "https://hooks.slack.com/services/SUPER/SECRET/TOKEN12345";
const silentLogger = { error: () => {}, warn: () => {}, info: () => {} };

const sampleOffer = {
  offerId: "A",
  title: "Example Game",
  startDate: "2026-04-30T15:00:00Z",
  endDate: "2026-05-02T15:00:00Z",
  originalPrice: 2000,
  discountPrice: 0,
  currencyCode: "JPY",
  url: "https://store.epicgames.com/ja-JP/p/example-game",
  offerType: "BASE_GAME",
};

// -------------------- redactSecrets --------------------

test("redactSecrets: replaces every literal occurrence of the secret", () => {
  const out = redactSecrets(
    `connect to ${SECRET_WEBHOOK} failed and ${SECRET_WEBHOOK} timed out`,
    SECRET_WEBHOOK,
  );
  assert.doesNotMatch(out, /SUPER|SECRET|TOKEN12345/);
  // The marker still appears so a reader can see the redaction happened.
  assert.match(out, /\[REDACTED:SLACK_WEBHOOK_URL\]/);
});

test("redactSecrets: ignores empty / undefined secrets without throwing", () => {
  const text = "no secrets here";
  assert.equal(redactSecrets(text), text);
  assert.equal(redactSecrets(text, undefined, null, ""), text);
});

test("redactSecrets: stringifies non-string inputs", () => {
  assert.equal(redactSecrets(undefined), "");
  assert.equal(redactSecrets(null), "");
  assert.equal(redactSecrets(42), "42");
});

// -------------------- errorLayer --------------------

test("errorLayer: maps each typed error to its layer name", () => {
  assert.equal(errorLayer(new EpicFetchError("x")), "fetch");
  assert.equal(errorLayer(new EpicResponseError("x")), "response");
  assert.equal(errorLayer(new SlackNotifyError("x")), "notify");
  assert.equal(errorLayer(new Error("x")), "unknown");
  assert.equal(errorLayer(undefined), "unknown");
});

// -------------------- provider error tagging --------------------

test("provider: transport failure throws EpicFetchError (fetch layer)", async () => {
  const fakeFetch = async () => {
    throw new Error("ENOTFOUND");
  };
  await assert.rejects(
    fetchEpicFreeOffers({ fetchImpl: fakeFetch, logger: silentLogger }),
    (err) => err instanceof EpicFetchError,
  );
});

test("provider: HTTP 5xx throws EpicFetchError (fetch layer)", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 503,
    statusText: "Unavailable",
    text: async () => "down",
  });
  await assert.rejects(
    fetchEpicFreeOffers({ fetchImpl: fakeFetch, logger: silentLogger }),
    (err) => err instanceof EpicFetchError && /HTTP 503/.test(err.message),
  );
});

test("provider: JSON parse failure throws EpicResponseError (response layer)", async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("invalid json");
    },
  });
  await assert.rejects(
    fetchEpicFreeOffers({ fetchImpl: fakeFetch, logger: silentLogger }),
    (err) => err instanceof EpicResponseError,
  );
});

test("provider: shape change throws EpicResponseError (response layer)", () => {
  assert.throws(
    () => mapToOffers({}, { logger: silentLogger }),
    (err) => err instanceof EpicResponseError,
  );
});

test("provider: HTTP error log captures status and body", async () => {
  const logs = [];
  const logger = {
    error: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    info: () => {},
  };
  const fakeFetch = async () => ({
    ok: false,
    status: 502,
    statusText: "Bad Gateway",
    text: async () => "upstream timeout",
  });
  await assert.rejects(
    fetchEpicFreeOffers({ fetchImpl: fakeFetch, logger }),
    EpicFetchError,
  );
  const joined = logs.join("\n");
  assert.match(joined, /HTTP 502/);
  assert.match(joined, /upstream timeout/);
});

// -------------------- notifier error tagging + redaction --------------------

test("notifier: HTTP error returns SlackNotifyError (notify layer)", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 500,
    statusText: "ISE",
    text: async () => "down",
  });
  const r = await notifyOffer(sampleOffer, {
    webhookUrl: SECRET_WEBHOOK,
    fetchImpl: fakeFetch,
    logger: silentLogger,
  });
  assert.equal(r.ok, false);
  assert.ok(r.error instanceof SlackNotifyError);
});

test("notifier: redacts the webhook URL when it leaks into a transport error", async () => {
  const logs = [];
  const logger = {
    error: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    info: () => {},
  };
  // Simulate a platform fetch error whose message embeds the request URL —
  // undici sometimes does this for connect/refused errors.
  const fakeFetch = async () => {
    throw new Error(`request to ${SECRET_WEBHOOK} failed: ECONNREFUSED`);
  };
  const r = await notifyOffer(sampleOffer, {
    webhookUrl: SECRET_WEBHOOK,
    fetchImpl: fakeFetch,
    logger,
  });
  assert.equal(r.ok, false);
  // No webhook fragment may appear in either the log line or the surfaced
  // error message — both feed into CI output paths.
  assert.doesNotMatch(logs.join("\n"), /SUPER|SECRET|TOKEN12345/);
  assert.doesNotMatch(r.error.message, /SUPER|SECRET|TOKEN12345/);
  assert.match(r.error.message, /ECONNREFUSED/);
});

test("notifier: redacts the webhook URL when Slack echoes it in the error body", async () => {
  const logs = [];
  const logger = {
    error: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    info: () => {},
  };
  // Extremely unlikely but cheap to defend: an upstream that echoes the URL.
  const fakeFetch = async () => ({
    ok: false,
    status: 400,
    statusText: "Bad Request",
    text: async () => `invalid_payload for ${SECRET_WEBHOOK}`,
  });
  await notifyOffer(sampleOffer, {
    webhookUrl: SECRET_WEBHOOK,
    fetchImpl: fakeFetch,
    logger,
  });
  assert.doesNotMatch(logs.join("\n"), /SUPER|SECRET|TOKEN12345/);
});

test("notifier: missing webhook returns SlackNotifyError without invoking fetch", async () => {
  const r = await notifyOffer(sampleOffer, {
    fetchImpl: () => {
      throw new Error("must not run");
    },
  });
  assert.equal(r.ok, false);
  assert.ok(r.error instanceof SlackNotifyError);
});
