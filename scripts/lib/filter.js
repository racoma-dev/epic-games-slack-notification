// Free-promotion filter (RCM-64 / Requirements FR-3).
//
// Pure transformation: takes provider Offers and a clock, returns the subset
// representing a *currently active* free promotion. No I/O, no side effects.

/**
 * @typedef {import('../providers/epic.js').EpicOffer} Offer
 */

/**
 * @typedef {Object} FilterConfig
 * @property {boolean} [includeAddons=true]   Include ADD_ON / BUNDLE offers when true.
 * @property {boolean} [notifyUpcoming=false] Reserved for future use; MVP emits only active.
 */

/**
 * Select offers that represent a currently-active, effectively-free promotion.
 *
 * Rules:
 *   - Active window:  startDate <= now < endDate
 *   - Effectively free: Epic's discountPercentage === 0 (their semantics: 0 = fully
 *                       discounted) OR discountPrice === 0
 *   - Excludes permanent free-to-play titles (originalPrice <= 0) — those are
 *     not promotions
 *   - When includeAddons is false, only BASE_GAME offers pass
 *
 * @param {Offer[]} offers
 * @param {Object} [params]
 * @param {Date|string|number} [params.now]   Current time. Injectable for tests (NFR-4).
 * @param {FilterConfig} [params.config]
 * @returns {Offer[]}
 */
export function filterCurrentFreeOffers(
  offers,
  { now = new Date(), config = {} } = {},
) {
  if (!Array.isArray(offers)) return [];
  const includeAddons = config.includeAddons ?? true;
  const nowMs = toMs(now);
  if (!Number.isFinite(nowMs)) return [];

  return offers.filter(
    (offer) =>
      isCurrentlyActive(offer, nowMs) &&
      isEffectivelyFree(offer) &&
      isAllowedType(offer, includeAddons),
  );
}

function isCurrentlyActive(offer, nowMs) {
  const start = Date.parse(offer?.startDate);
  const end = Date.parse(offer?.endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start <= nowMs && nowMs < end;
}

function isEffectivelyFree(offer) {
  // Permanent F2P sentinel: a real promotion implies a non-zero list price.
  if (typeof offer?.originalPrice === "number" && offer.originalPrice <= 0) {
    return false;
  }
  if (offer?.discountPercentage === 0) return true;
  if (typeof offer?.discountPrice === "number" && offer.discountPrice === 0) {
    return true;
  }
  return false;
}

function isAllowedType(offer, includeAddons) {
  if (includeAddons) return true;
  return offer?.offerType === "BASE_GAME";
}

function toMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "number") return now;
  return Date.parse(String(now));
}
