// Free-promotion filter (RCM-64 / Requirements FR-3).
//
// Pure transformation: takes provider Offers and a clock, returns the subset
// representing a *currently active* free promotion. No I/O, no side effects.

/**
 * @typedef {import('../providers/epic.js').EpicOffer} Offer
 */

/**
 * @typedef {Object} FilterConfig
 * @property {boolean} [includeAddons=false]  Include ADD_ON offers when true.
 * @property {boolean} [notifyUpcoming=false] Reserved for future use; MVP emits only active.
 */

/**
 * Select offers that represent a currently-active, effectively-free promotion.
 *
 * Rules:
 *   - Active window:  startDate <= now < endDate
 *   - Usually paid: originalPrice > 0
 *   - Currently free: discountPrice === 0
 *   - PC game: games/edition/base or bundles/games category path
 *   - Excludes DLC / add-ons by default
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
  const includeAddons = config.includeAddons ?? false;
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
  return offer?.originalPrice > 0 && offer?.discountPrice === 0;
}

function isAllowedType(offer, includeAddons) {
  const paths = Array.isArray(offer?.categoryPaths) ? offer.categoryPaths : [];
  if (paths.includes("games/edition/base")) return true;
  if (paths.includes("bundles/games")) return true;
  if (includeAddons && offer?.offerType === "ADD_ON") return true;
  if (paths.length > 0) return false;
  return offer?.offerType === "BASE_GAME";
}

function toMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "number") return now;
  return Date.parse(String(now));
}
