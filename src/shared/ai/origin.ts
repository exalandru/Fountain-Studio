/**
 * AI endpoint origin identity (M4).
 *
 * Origin = scheme + host + effective port. Path suffixes (`/v1` vs `/v2`) do not
 * change trust. Host tricks, credentials-in-URL, and scheme/port changes do.
 */

/** Canonical origin key, or `null` when the URL is not an http(s) endpoint. */
export function aiEndpointOrigin(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname) return null;
    const port = parsed.port || (protocol === 'https:' ? '443' : '80');
    return `${protocol}//${hostname}:${port}`;
  } catch {
    return null;
  }
}

export function sameAiEndpointOrigin(left: string, right: string): boolean {
  const a = aiEndpointOrigin(left);
  const b = aiEndpointOrigin(right);
  return a !== null && b !== null && a === b;
}
