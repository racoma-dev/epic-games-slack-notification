#!/usr/bin/env node
// Entry point. Pipeline:
//   1. fetch  (RCM-63) — Epic Games Store free promotions for locale/country
//   2. filter (RCM-64) — keep only currently-active, effectively-free offers
//   3. diff   (RCM-65) — drop offers we've already notified
//   4. notify (RCM-66) — POST one Slack message per remaining offer
//   5. record (RCM-65) — persist ONLY offers we successfully notified
//
// CI commit/push of the state file lives in the workflow (RCM-67).

import { fetchEpicFreeOffers } from "./providers/epic.js";
import { filterCurrentFreeOffers } from "./lib/filter.js";
import {
  loadState,
  saveState,
  selectNewOffers,
  recordNotified,
  DEFAULT_STATE_PATH,
} from "./lib/state.js";
import { notifyOffers } from "./lib/notifier.js";
import { errorLayer, redactSecrets } from "./lib/errors.js";

async function main() {
  const locale = process.env.EPIC_LOCALE || "ja-JP";
  const country = process.env.EPIC_COUNTRY || "JP";
  const includeAddons = parseBool(process.env.INCLUDE_ADDONS, false);
  const notifyUpcoming = parseBool(process.env.NOTIFY_UPCOMING, false);
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const statePath = process.env.STATE_FILE || DEFAULT_STATE_PATH;
  const now = new Date();

  if (!webhookUrl) {
    // Fail fast — running without a webhook would silently advance state.
    throw new Error("SLACK_WEBHOOK_URL is required");
  }

  const offers = await fetchEpicFreeOffers({ locale, country });
  const active = filterCurrentFreeOffers(offers, {
    now,
    config: { includeAddons, notifyUpcoming },
  });

  const state = await loadState(statePath);
  const novel = selectNewOffers(active, state);

  if (novel.length === 0) {
    console.log("[check] no new free offers");
    return;
  }

  const results = await notifyOffers(novel, { webhookUrl, now });
  const succeeded = results.filter((r) => r.ok).map((r) => r.offer);
  const failed = results.filter((r) => !r.ok);

  if (succeeded.length > 0) {
    const next = recordNotified(state, succeeded, { now });
    await saveState(next, statePath);
  }

  console.log(
    `[check] notified=${succeeded.length} failed=${failed.length} total=${novel.length}`,
  );

  if (failed.length > 0) {
    // Surface failures to CI without losing the successful sends already persisted.
    process.exitCode = 1;
  }
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

main().catch((err) => {
  // Attribute by layer so a CI log search like `[check] fetch layer` finds
  // every fetch-time failure regardless of message phrasing. Redact the
  // webhook URL defensively in case any platform error surfaced it.
  const layer = errorLayer(err);
  const detail = redactSecrets(
    err?.stack ?? err?.message ?? err,
    process.env.SLACK_WEBHOOK_URL,
  );
  console.error(`[check] ${layer} layer error:\n${detail}`);
  process.exit(1);
});
