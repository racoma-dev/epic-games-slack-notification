// Slack notifier (RCM-66 / Requirements FR-5 + FR-6).
//
// Sends ONE Slack message per offer. Internal data stays UTC / ISO 8601;
// only the rendered message uses Asia/Tokyo. Returns per-offer success so
// the caller can persist state only for confirmed sends (FR-7).
//
// The webhook URL must NEVER be logged (NFR-3). We don't log it intentionally,
// but transport errors thrown by `fetch()` can embed the request URL in their
// message on some platforms — every catch path runs through `redactSecrets`
// before logging. Failed sends are surfaced as `SlackNotifyError` so the
// entry point can attribute the failure to the notify layer (RCM-68).

import { SlackNotifyError, redactSecrets } from "./errors.js";

/**
 * @typedef {import('../providers/epic.js').EpicOffer} Offer
 */

/**
 * @typedef {Object} NotifyResult
 * @property {boolean} ok
 * @property {Error}  [error]
 */

/**
 * @typedef {Object} NotifyOptions
 * @property {string} webhookUrl
 * @property {typeof fetch} [fetchImpl]
 * @property {Date|string|number} [now]
 * @property {Pick<Console, "error"|"warn"|"info">} [logger]
 */

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "IDR", "ISK", "JPY", "KMF", "KRW", "MGA",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

const OFFER_TYPE_LABELS = {
  BASE_GAME: "本体",
  ADD_ON: "DLC",
  BUNDLE: "バンドル",
};

/**
 * POST a single offer to Slack. Resolves with `{ ok, error? }` rather than
 * throwing so the orchestrator can record successes and surface failures
 * without unwinding mid-batch.
 *
 * @param {Offer} offer
 * @param {NotifyOptions} options
 * @returns {Promise<NotifyResult>}
 */
export async function notifyOffer(
  offer,
  { webhookUrl, fetchImpl = fetch, now = new Date(), logger = console } = {},
) {
  if (!webhookUrl) {
    return {
      ok: false,
      error: new SlackNotifyError("SLACK_WEBHOOK_URL is not configured"),
    };
  }

  const text = buildMessageText(offer, { now });
  const payload = { text };

  let response;
  try {
    response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const safeMsg = redactSecrets(err?.message ?? err, webhookUrl);
    logger.error(
      `[notifier] Slack POST threw for "${offer?.title ?? "unknown"}": ${safeMsg}`,
    );
    return {
      ok: false,
      error: new SlackNotifyError(safeMsg, { cause: err }),
    };
  }

  if (!response.ok) {
    const body = await safeReadText(response);
    const safeBody = redactSecrets(body, webhookUrl).slice(0, 300);
    logger.error(
      `[notifier] Slack POST failed for "${offer?.title ?? "unknown"}": HTTP ${response.status} ${safeBody}`,
    );
    return {
      ok: false,
      error: new SlackNotifyError(`Slack returned HTTP ${response.status}`),
    };
  }

  return { ok: true };
}

/**
 * Send each offer sequentially. Sequential keeps Slack ordering predictable
 * and avoids tripping per-channel rate limits (~1 msg/sec). Returns one entry
 * per input offer; the caller decides what to do on partial failure.
 *
 * @param {Offer[]} offers
 * @param {NotifyOptions} options
 * @returns {Promise<Array<NotifyResult & { offer: Offer }>>}
 */
export async function notifyOffers(offers, options) {
  const results = [];
  for (const offer of offers ?? []) {
    const r = await notifyOffer(offer, options);
    results.push({ offer, ...r });
  }
  return results;
}

/**
 * Pure: render the Slack message body for one offer. Exported for tests.
 *
 * @param {Offer} offer
 * @param {{ now?: Date|string|number }} [opts]
 * @returns {string}
 */
export function buildMessageText(offer, { now = new Date() } = {}) {
  const lines = ["🎮 Epic無料配布を検知"];
  lines.push(`タイトル: ${offer?.title || "(タイトル不明)"}`);

  if (offer?.endDate) lines.push(`期限: ${formatJst(offer.endDate)}`);
  if (offer?.startDate) lines.push(`開始: ${formatJst(offer.startDate)}`);

  if (offer?.endDate) {
    const remaining = formatRemaining(offer.endDate, now);
    if (remaining) lines.push(remaining);
  }

  const price = formatPrice(offer?.originalPrice, offer?.currencyCode);
  if (price) lines.push(`通常価格: ${price}`);

  const typeLabel = offerTypeLabel(offer?.offerType);
  if (typeLabel) lines.push(`種別: ${typeLabel}`);

  if (offer?.url) lines.push(`URL: ${offer.url}`);
  lines.push(`検知日時: ${formatJst(toIso(now))}`);

  return lines.join("\n");
}

export function formatJst(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute} JST`;
}

export function formatRemaining(endIso, now) {
  const endMs = new Date(endIso).getTime();
  const nowMs = toMs(now);
  const ms = endMs - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return null;

  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;

  const parts = [];
  if (days) parts.push(`${days}日`);
  if (hours) parts.push(`${hours}時間`);
  if (!days && mins) parts.push(`${mins}分`);
  return parts.length ? `残り ${parts.join("")}` : "残り 1分未満";
}

export function formatPrice(amount, currencyCode) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  if (!currencyCode || typeof currencyCode !== "string") return null;
  const code = currencyCode.toUpperCase();
  const major = ZERO_DECIMAL_CURRENCIES.has(code) ? amount : amount / 100;
  try {
    return new Intl.NumberFormat("ja-JP", {
      style: "currency",
      currency: code,
    }).format(major);
  } catch {
    return `${major} ${code}`;
  }
}

function offerTypeLabel(t) {
  if (!t) return null;
  return OFFER_TYPE_LABELS[t] ?? null;
}

function toMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "number") return now;
  return Date.parse(String(now));
}

function toIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "number") return new Date(now).toISOString();
  return new Date(String(now)).toISOString();
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
