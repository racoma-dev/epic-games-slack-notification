// Epic Games Store free-promotion provider.
// Requirements FR-2: fetch free-promotion data for the given locale/country
// and map it to the internal Offer shape. Free/non-free judgement is the
// caller's responsibility (see RCM-64).

// Canonical Epic free-games endpoint that has been stable across years of
// public Epic Store integrations. The earlier `-ipv4` host with the
// `ByLocale` path returned 502/404 from real clients (locale is passed as a
// query param here, not a path segment).
const DEFAULT_ENDPOINT =
  "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions";
const DEFAULT_STORE_BASE = "https://store.epicgames.com";
const USER_AGENT =
  "epic-games-slack-notification/0.1 (+https://github.com/racoma-dev/epic-games-slack-notification)";

/**
 * @typedef {Object} EpicOffer
 * @property {string} offerId            Epic element id
 * @property {string} productId          Epic namespace
 * @property {string} title
 * @property {string} startDate          ISO 8601
 * @property {string} endDate            ISO 8601
 * @property {number|null} originalPrice In minor unit per Epic (e.g. JPY: 1080 = ¥1,080)
 * @property {number|null} discountPrice
 * @property {string|null} currencyCode
 * @property {number|null} discountPercentage  Epic semantics: 0 = fully discounted
 * @property {string} url
 * @property {string} offerType          BASE_GAME | ADD_ON | BUNDLE | ...
 * @property {string[]} categoryPaths    Epic category paths used for game/add-on gating
 */

/**
 * Fetch active and upcoming Epic promotional offers and return them as a
 * flat array of EpicOffer. Throws on transport / parse / shape errors.
 *
 * @param {Object} [options]
 * @param {string} [options.locale="ja-JP"]
 * @param {string} [options.country="JP"]
 * @param {string} [options.endpoint]
 * @param {string} [options.storeBase]
 * @param {typeof fetch} [options.fetchImpl]   Inject for tests.
 * @param {Pick<Console, "error"|"warn"|"info">} [options.logger]
 * @returns {Promise<EpicOffer[]>}
 */
export async function fetchEpicFreeOffers({
  locale = "ja-JP",
  country = "JP",
  endpoint = DEFAULT_ENDPOINT,
  storeBase = DEFAULT_STORE_BASE,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const url = buildRequestUrl(endpoint, locale, country);

  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "Accept-Language": locale,
        "User-Agent": USER_AGENT,
      },
    });
  } catch (err) {
    logger.error(`[epic-provider] fetch failed: ${err?.message ?? err}`);
    throw new Error(`Epic API request failed: ${err?.message ?? err}`, {
      cause: err,
    });
  }

  if (!response.ok) {
    const body = await safeReadText(response);
    logger.error(
      `[epic-provider] HTTP ${response.status} ${response.statusText}: ${body.slice(0, 500)}`,
    );
    throw new Error(`Epic API returned HTTP ${response.status}`);
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    logger.error(`[epic-provider] JSON parse failed: ${err?.message ?? err}`);
    throw new Error(`Failed to parse Epic API response: ${err?.message ?? err}`, {
      cause: err,
    });
  }

  return mapToOffers(json, { locale, storeBase, logger });
}

/**
 * Pure transformer: Epic API JSON → EpicOffer[].
 * Exported so tests can pass fixtures without hitting the network.
 *
 * @param {unknown} json
 * @param {Object} [options]
 * @param {string} [options.locale="ja-JP"]
 * @param {string} [options.storeBase]
 * @param {Pick<Console, "error"|"warn">} [options.logger]
 * @returns {EpicOffer[]}
 */
export function mapToOffers(
  json,
  { locale = "ja-JP", storeBase = DEFAULT_STORE_BASE, logger = console } = {},
) {
  const elements = json?.data?.Catalog?.searchStore?.elements;
  if (!Array.isArray(elements)) {
    logger.error(
      "[epic-provider] Unexpected response shape: data.Catalog.searchStore.elements is not an array",
    );
    throw new Error("Unexpected Epic API response shape");
  }

  const offers = [];
  for (const el of elements) {
    try {
      offers.push(...extractOffersFromElement(el, { locale, storeBase }));
    } catch (err) {
      logger.warn(
        `[epic-provider] skipped element "${el?.title ?? "unknown"}": ${err?.message ?? err}`,
      );
    }
  }
  return offers;
}

function extractOffersFromElement(el, { locale, storeBase }) {
  const out = [];
  const promoGroups = el?.promotions?.promotionalOffers ?? [];
  for (const group of promoGroups) {
    const inner = group?.promotionalOffers ?? [];
    for (const promo of inner) {
      if (!promo?.startDate || !promo?.endDate) continue;
      out.push(buildOffer(el, promo, { locale, storeBase }));
    }
  }
  return out;
}

function buildOffer(el, promo, { locale, storeBase }) {
  const totalPrice = el?.price?.totalPrice ?? null;
  return {
    offerId: String(el?.id ?? ""),
    productId: String(el?.namespace ?? ""),
    title: String(el?.title ?? ""),
    startDate: promo.startDate,
    endDate: promo.endDate,
    originalPrice: numericOrNull(totalPrice?.originalPrice),
    discountPrice: numericOrNull(totalPrice?.discountPrice),
    currencyCode: stringOrNull(totalPrice?.currencyCode),
    discountPercentage: numericOrNull(promo?.discountSetting?.discountPercentage),
    url: buildStoreUrl(el, locale, storeBase),
    offerType: String(el?.offerType ?? "UNKNOWN"),
    categoryPaths: categoryPaths(el?.categories),
  };
}

function buildRequestUrl(endpoint, locale, country) {
  const params = new URLSearchParams({
    locale,
    country,
    allowCountries: country,
  });
  return `${endpoint}?${params.toString()}`;
}

function buildStoreUrl(el, locale, storeBase) {
  const slug =
    pickSlug(el?.catalogNs?.mappings) ||
    pickSlug(el?.offerMappings) ||
    el?.productSlug ||
    el?.urlSlug ||
    "";
  if (!slug) return `${storeBase}/${locale}/free-games`;
  const cleaned = String(slug).replace(/\/home$/, "");
  return `${storeBase}/${locale}/p/${cleaned}`;
}

function pickSlug(mappings) {
  if (!Array.isArray(mappings)) return null;
  const productHome = mappings.find((m) => m?.pageType === "productHome");
  return productHome?.pageSlug ?? null;
}

function numericOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function stringOrNull(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function categoryPaths(categories) {
  if (!Array.isArray(categories)) return [];
  return categories
    .map((category) => category?.path)
    .filter((path) => typeof path === "string" && path.length > 0);
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
