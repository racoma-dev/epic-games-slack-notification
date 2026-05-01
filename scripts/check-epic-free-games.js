#!/usr/bin/env node
// Entry point. RCM-63 wires the provider; RCM-64 adds free-promotion filtering.
// Dedupe + Slack notification land in later tickets.

import { fetchEpicFreeOffers } from "./providers/epic.js";
import { filterCurrentFreeOffers } from "./lib/filter.js";

async function main() {
  const locale = process.env.EPIC_LOCALE || "ja-JP";
  const country = process.env.EPIC_COUNTRY || "JP";
  const includeAddons = parseBool(process.env.INCLUDE_ADDONS, true);
  const notifyUpcoming = parseBool(process.env.NOTIFY_UPCOMING, false);

  const offers = await fetchEpicFreeOffers({ locale, country });
  const active = filterCurrentFreeOffers(offers, {
    now: new Date(),
    config: { includeAddons, notifyUpcoming },
  });
  process.stdout.write(JSON.stringify(active, null, 2) + "\n");
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

main().catch((err) => {
  console.error(err?.stack ?? err?.message ?? err);
  process.exit(1);
});
