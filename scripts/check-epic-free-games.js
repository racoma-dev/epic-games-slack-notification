#!/usr/bin/env node
// Entry point. For RCM-63 we only wire the provider and dump its output as
// JSON; free-promotion judgement, dedupe, and Slack notification land in
// later tickets (RCM-64+).

import { fetchEpicFreeOffers } from "./providers/epic.js";

async function main() {
  const locale = process.env.EPIC_LOCALE || "ja-JP";
  const country = process.env.EPIC_COUNTRY || "JP";

  const offers = await fetchEpicFreeOffers({ locale, country });
  process.stdout.write(JSON.stringify(offers, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err?.stack ?? err?.message ?? err);
  process.exit(1);
});
