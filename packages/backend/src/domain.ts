/**
 * Root-domain (eTLD+1) helpers for grouping hosts.
 * test1.abc.com / test2.abc.com → root "abc.com"
 */

/** Common multi-part public suffixes (not exhaustive; covers frequent cases). */
const MULTI_PART_TLDS = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "co.nz",
  "co.jp",
  "or.jp",
  "ne.jp",
  "com.br",
  "com.br",
  "co.in",
  "com.cn",
  "com.mx",
  "co.za",
  "com.sg",
  "com.hk",
  "com.tw",
  "co.kr",
  "com.ar",
  "com.tr",
  "co.id",
  "com.my",
  "com.ph",
  "com.vn",
  "co.th",
  "com.ng",
  "com.pk",
  "com.sa",
  "com.ae",
  "co.il",
  "com.pl",
  "com.ua",
  "com.ro",
  "com.pt",
  "gen.tr",
]);

export type HostParts = {
  /** Hostname without port */
  hostname: string;
  /** Port if non-default was in the key, else undefined */
  port: string | undefined;
  /** Full host key as stored (host or host:port) */
  full: string;
};

/** Split "host" or "host:port" (IPv6 not with brackets assumed rare in keys). */
export function splitHostKey(hostKey: string): HostParts {
  // IPv6 literal in brackets: [::1]:8080
  if (hostKey.startsWith("[")) {
    const end = hostKey.indexOf("]");
    if (end !== -1) {
      const hostname = hostKey.slice(0, end + 1);
      const rest = hostKey.slice(end + 1);
      if (rest.startsWith(":") && /^\d+$/.test(rest.slice(1))) {
        return { hostname, port: rest.slice(1), full: hostKey };
      }
      return { hostname, port: undefined, full: hostKey };
    }
  }

  const idx = hostKey.lastIndexOf(":");
  if (idx > 0) {
    const maybePort = hostKey.slice(idx + 1);
    if (/^\d+$/.test(maybePort)) {
      return {
        hostname: hostKey.slice(0, idx),
        port: maybePort,
        full: hostKey,
      };
    }
  }

  return { hostname: hostKey, port: undefined, full: hostKey };
}

function isIpv4(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Extract registrable / root domain used for grouping.
 * - test1.abc.com → abc.com
 * - abc.com → abc.com
 * - a.b.co.uk → b.co.uk
 * - 1.2.3.4 → 1.2.3.4
 * Port is not part of the root domain label (grouping ignores port differences
 * for display under the same eTLD+1; hosts remain separate children).
 */
export function getRootDomain(hostKey: string): string {
  const { hostname } = splitHostKey(hostKey);

  if (hostname.startsWith("[")) {
    return hostname;
  }
  if (isIpv4(hostname)) {
    return hostname;
  }
  if (hostname === "localhost") {
    return hostname;
  }

  const parts = hostname.toLowerCase().split(".").filter((p) => p.length > 0);
  if (parts.length <= 1) {
    return hostname.toLowerCase();
  }
  if (parts.length === 2) {
    return parts.join(".");
  }

  const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (MULTI_PART_TLDS.has(lastTwo)) {
    if (parts.length >= 3) {
      return parts.slice(-3).join(".");
    }
    return lastTwo;
  }

  return parts.slice(-2).join(".");
}
