/**
 * Chromium's `did-fail-load` hands us its raw net-error string (e.g.
 * `ERR_CONNECTION_REFUSED`), which is meaningless to most users. This maps
 * the handful of codes that show up while previewing a local dev server to
 * plain-English explanations, and otherwise shows the raw text unchanged so
 * nothing is ever hidden.
 */
export type LoadErrorDescription = {
  /** Plain-English explanation, or the raw text when the code is unknown. */
  humanText: string;
  /** The original Chromium error text, always preserved for debugging. */
  rawCode: string;
};

const KNOWN_ERRORS: Record<string, string> = {
  ERR_CONNECTION_REFUSED: "The dev server is probably not running yet.",
  ERR_NAME_NOT_RESOLVED: "The address could not be resolved (DNS lookup failed).",
  ERR_INTERNET_DISCONNECTED: "There is no internet connection.",
  ERR_CONNECTION_TIMED_OUT: "The connection timed out.",
  ERR_ABORTED: "The page load was interrupted.",
};

export function describeLoadError(rawCode: string): LoadErrorDescription {
  const trimmed = rawCode.trim();

  // Chromium has many ERR_CERT_* variants (expired, invalid authority, date
  // mismatch, ...); users don't need to distinguish them, so group them all.
  if (trimmed.startsWith("ERR_CERT_")) {
    return { humanText: "The site's certificate is not trusted.", rawCode: trimmed };
  }

  const known = KNOWN_ERRORS[trimmed];
  if (known) {
    return { humanText: known, rawCode: trimmed };
  }

  // Unknown code or an already-human message (e.g. a caller-supplied
  // fallback string): show it verbatim rather than guessing.
  return { humanText: trimmed, rawCode: trimmed };
}
