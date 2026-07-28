/**
 * Detect popular CDN / cloud object-storage hosts used as third-party asset origins.
 * For these hosts we record the Referer (or Origin) so testers can see which site loaded them.
 */

import { getRootDomain, splitHostKey } from "./domain";

/**
 * Hostname suffixes (and exact hosts) treated as cloud/CDN asset origins.
 * Matched as: host === suffix OR host.endsWith("." + suffix)
 */
const CLOUD_ASSET_SUFFIXES: string[] = [
  // AWS
  "cloudfront.net",
  "amazonaws.com",
  "awsglobalaccelerator.com",
  "elasticbeanstalk.com",
  // Azure
  "azureedge.net",
  "azurefd.net",
  "blob.core.windows.net",
  "web.core.windows.net",
  "azure-api.net",
  "trafficmanager.net",
  // Google
  "googleapis.com",
  "googleusercontent.com",
  "gstatic.com",
  "ggpht.com",
  "appspot.com",
  "cloudfunctions.net",
  "run.app",
  // Cloudflare
  "cloudflarestorage.com",
  "r2.dev",
  "pages.dev",
  "workers.dev",
  "cdnjs.cloudflare.com",
  // Akamai
  "akamaihd.net",
  "akamaized.net",
  "akamai.net",
  "edgesuite.net",
  "edgekey.net",
  "akamaitechnologies.com",
  // Fastly / other CDNs
  "fastly.net",
  "fastlylb.net",
  "imgix.net",
  "cloudinary.com",
  "imagekit.io",
  "b-cdn.net",
  "bunnycdn.com",
  "bunny.net",
  "keycdn.com",
  "kxcdn.com",
  "stackpathcdn.com",
  "stackpathdns.com",
  "netdna-cdn.com",
  "netdna-ssl.com",
  "maxcdn.com",
  "bootstrapcdn.com",
  "jsdelivr.net",
  "unpkg.com",
  "esm.sh",
  "skypack.dev",
  // Object storage providers
  "digitaloceanspaces.com",
  "backblazeb2.com",
  "wasabisys.com",
  "storage.yandexcloud.net",
  "yandexcloud.net",
  "supabase.co",
  "supabase.in",
  "vercel-storage.com",
  "blob.vercel-storage.com",
  "public.blob.vercel-storage.com",
  // Alibaba / Tencent / China CDNs
  "alicdn.com",
  "aliyuncs.com",
  "aliyun.com",
  "myqcloud.com",
  "qcloud.com",
  "tencentcos.cn",
  // Common app/media CDNs sites pull from
  "fbcdn.net",
  "cdninstagram.com",
  "twimg.com",
  "ytimg.com",
  "ggpht.com",
  "discordapp.net",
  "discordapp.com",
  "redditstatic.com",
  "redd.it",
  "pinimg.com",
  "shopify.com",
  "shopifycdn.com",
  "shopifycs.com",
  "wp.com",
  "w.org",
  "medium.com",
  "medium.systems",
  "scdn.co",
  "spotifycdn.com",
  "licdn.com",
  "linkedin.com",
  // Misc edge / static hosts
  "rackcdn.com",
  "scaleengine.net",
  "hwcdn.net",
  "lxdns.com",
  "cdngc.net",
  "cdn77.org",
  "cdn77.com",
  "cachefly.net",
  "section.io",
  "ntc.party",
];

/** Pre-sorted longest-first so more specific suffixes win if we ever list them. */
const SORTED_SUFFIXES = [...CLOUD_ASSET_SUFFIXES].sort((a, b) => b.length - a.length);

/**
 * True when the host is a known CDN / cloud object store / common third-party asset origin.
 */
export function isCloudAssetHost(hostKey: string): boolean {
  const hostname = splitHostKey(hostKey).hostname.toLowerCase();
  if (hostname.length === 0) {
    return false;
  }

  for (const suffix of SORTED_SUFFIXES) {
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) {
      return true;
    }
  }

  // S3 dual-stack / regional patterns not always ending in a single fixed multi-label suffix
  // already covered by amazonaws.com. Extra: s3-website-* style
  if (/(^|\.)s3[.-]/.test(hostname) && hostname.includes("amazonaws")) {
    return true;
  }

  return false;
}

/**
 * Parse Referer or Origin header value into a display label (root domain, lower-case).
 * Returns undefined for empty / same-host / unparseable values.
 */
export function refererLabelFromHeader(
  headerValue: string | undefined,
  requestHostKey: string,
): string | undefined {
  if (headerValue === undefined) {
    return undefined;
  }
  const raw = headerValue.trim();
  if (raw.length === 0 || raw === "null" || raw === "undefined") {
    return undefined;
  }

  let refererHost: string | undefined;

  // Origin is often just "https://abc.com" or "null"
  try {
    if (/^https?:\/\//i.test(raw)) {
      refererHost = new URL(raw).hostname;
    } else if (raw.includes("/") || raw.includes(":")) {
      // Some clients send host:port or scheme-less
      try {
        refererHost = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
      } catch {
        refererHost = raw.split("/")[0]?.split(":")[0];
      }
    } else {
      // bare hostname
      refererHost = raw.replace(/^\[|\]$/g, "");
    }
  } catch {
    return undefined;
  }

  if (refererHost === undefined || refererHost.length === 0) {
    return undefined;
  }

  const label = getRootDomain(refererHost);
  const requestRoot = getRootDomain(requestHostKey);

  // Don't label a CDN request as "coming from" itself
  if (label === requestRoot || label === splitHostKey(requestHostKey).hostname.toLowerCase()) {
    return undefined;
  }

  return label;
}

/**
 * Prefer Referer, fall back to Origin (CORS subresource requests).
 */
export function extractRefererLabel(
  headers: Record<string, string[]> | undefined,
  requestHostKey: string,
): string | undefined {
  if (headers === undefined) {
    return undefined;
  }

  const pick = (name: string): string | undefined => {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === name) {
        return v[0];
      }
    }
    return undefined;
  };

  return (
    refererLabelFromHeader(pick("referer"), requestHostKey) ??
    refererLabelFromHeader(pick("origin"), requestHostKey)
  );
}

/** Uppercase display form matching the user's example: [ABC.COM] */
export function formatRefererBadge(label: string): string {
  return label.toUpperCase();
}
