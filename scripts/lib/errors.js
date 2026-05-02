// Layer-tagged error classes (RCM-68 / Requirements §9 + NFR-2 + NFR-3).
//
// The pipeline has four distinguishable layers — fetch, response shape,
// notify, state. Throwing a typed error from each layer lets the entry point
// attribute failures in CI logs without re-parsing message strings, and keeps
// catch-by-instance reliable in tests.
//
// Also exports `redactSecrets`, the single helper every log/error path should
// run untrusted strings through before printing them. Slack webhook URLs
// must never appear in CI output (NFR-3); platform `fetch` errors can embed
// the URL host/path in their message, so redaction is applied defensively
// even where we don't intentionally include the URL.

export class EpicFetchError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "EpicFetchError";
  }
}

export class EpicResponseError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "EpicResponseError";
  }
}

export class SlackNotifyError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SlackNotifyError";
  }
}

const REDACTION = "[REDACTED:SLACK_WEBHOOK_URL]";

/**
 * Replace every literal occurrence of each `secret` in `text` with a fixed
 * marker. Empty / non-string secrets are ignored so callers can pass
 * `process.env.SLACK_WEBHOOK_URL` directly without guarding for undefined.
 *
 * @param {unknown} text
 * @param  {...(string|undefined|null)} secrets
 * @returns {string}
 */
export function redactSecrets(text, ...secrets) {
  let out = text == null ? "" : String(text);
  for (const s of secrets) {
    if (typeof s !== "string" || s.length === 0) continue;
    out = out.split(s).join(REDACTION);
  }
  return out;
}

/**
 * Categorize an error by the layer that produced it. Returns "unknown" for
 * untyped errors so the entry point can still print something useful.
 *
 * @param {unknown} err
 * @returns {"fetch"|"response"|"notify"|"unknown"}
 */
export function errorLayer(err) {
  if (err instanceof EpicFetchError) return "fetch";
  if (err instanceof EpicResponseError) return "response";
  if (err instanceof SlackNotifyError) return "notify";
  return "unknown";
}
