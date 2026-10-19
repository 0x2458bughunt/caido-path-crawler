/**
 * Path extraction from HTML and JavaScript response bodies.
 * Designed for passive discovery (Burp-style sitemap enrichment).
 */

const MAX_BODY_CHARS = 2_000_000;

/** Extensions we treat as static assets (still recorded as paths if requested). */
const ASSET_EXT =
  /\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map|css|less|scss|mp[34]|webm|avi|mov|pdf|zip|gz|tar|br)(?:\?|$)/i;

/**
 * Clean a raw reference (HTML attribute / JS string) and resolve it against
 * `base` — the page, JS file, or <base href> URL it was found in.
 * Only http(s) URLs survive; data:/javascript:/mailto: etc. are dropped.
 */
export function resolveRef(raw: string, base: string): URL | undefined {
  const p = raw
    .trim()
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/^["'`]+|["'`]+$/g, "");
  if (p.length === 0 || p.length > 2048 || /[\x00-\x1f\x7f\s]/.test(p)) {
    return undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !/^https?:/i.test(p)) {
    return undefined;
  }
  try {
    const url = new URL(p, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Storage key for a URL: decoded pathname, repeated slashes collapsed, no query/fragment. */
export function pathOf(url: URL): string | undefined {
  let p = url.pathname.replace(/\/{2,}/g, "/");
  try {
    p = decodeURI(p);
  } catch {
    // keep encoded form
  }
  if (/\/(?:null|undefined|NaN)$/.test(p)) {
    return undefined;
  }
  return p;
}

export function isJsPath(path: string, contentType: string | undefined): boolean {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("javascript") || ct.includes("ecmascript")) {
    return true;
  }

  const clean = path.split("?")[0]?.toLowerCase() ?? "";
  return (
    clean.endsWith(".js") ||
    clean.endsWith(".mjs") ||
    clean.endsWith(".cjs") ||
    clean.endsWith(".jsx") ||
    clean.endsWith(".ts") ||
    clean.endsWith(".tsx")
  );
}

export function isHtmlContent(contentType: string | undefined, path: string): boolean {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml")) {
    return true;
  }
  const clean = path.split("?")[0]?.toLowerCase() ?? "";
  return clean.endsWith(".html") || clean.endsWith(".htm") || clean === "/" || clean === "";
}

export type HtmlRefs = {
  /** Raw link values, unresolved */
  refs: string[];
  /** <base href> value, if present */
  base: string | undefined;
  /** Inline <script> bodies */
  scripts: string[];
};

/**
 * Extract references from HTML (href, src, action, formaction, data-*, srcset),
 * plus <base href> and inline scripts. Values are returned raw — resolve with resolveRef.
 */
export function extractFromHtml(body: string): HtmlRefs {
  const text = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
  const refs = new Set<string>();

  // Quoted or unquoted attribute values
  const attrRe =
    /(?:href|src|action|formaction|poster|data-(?:url|href|src|path|endpoint|api))\s*=\s*(?:(["'])(.*?)\1|([^\s"'>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(text)) !== null) {
    const val = m[2] ?? m[3];
    if (val !== undefined) {
      refs.add(val);
    }
  }

  // srcset: "url 1x, url2 2x"
  const srcsetRe = /srcset\s*=\s*(["'])(.*?)\1/gi;
  while ((m = srcsetRe.exec(text)) !== null) {
    const val = m[2];
    if (val === undefined) {
      continue;
    }
    for (const part of val.split(",")) {
      const url = part.trim().split(/\s+/)[0];
      if (url !== undefined && url.length > 0) {
        refs.add(url);
      }
    }
  }

  const base = /<base\b[^>]*\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(text)?.[1];

  const scripts: string[] = [];
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = scriptRe.exec(text)) !== null) {
    const src = m[1];
    if (src !== undefined && src.trim().length > 0) {
      scripts.push(src);
    }
  }

  return { refs: [...refs], base, scripts };
}

/**
 * Extract path-like strings from JavaScript source (raw — resolve with resolveRef).
 * Covers: string literals, template literals, fetch/axios/XHR style URLs, route configs.
 */
export function extractRefsFromJs(body: string): string[] {
  const text = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
  const found = new Set<string>();

  // Double-quoted, single-quoted, and backtick strings that look like paths or URLs
  const stringRe = /(["'`])((?:https?:\/\/[^"'`\\]+|\/[^"'`\\]{0,500}?))\1/g;
  let m: RegExpExecArray | null;
  while ((m = stringRe.exec(text)) !== null) {
    const val = m[2];
    if (val !== undefined) {
      found.add(val);
    }
  }

  // Relative module/import paths that start with ./ or ../
  const relRe = /(?:from|import|require\s*\()\s*(["'`])(\.\.?\/[^"'`\\]+)\1/g;
  while ((m = relRe.exec(text)) !== null) {
    const val = m[2];
    if (val !== undefined) {
      found.add(val);
    }
  }

  // fetch("/x"), axios.get("/x"), .open("GET","/x"), location = "/x"
  const callRe =
    /(?:fetch|axios\.(?:get|post|put|patch|delete|head|options)|open|navigate|assign|replace)\s*\(\s*(?:["'][A-Z]+["']\s*,\s*)?(["'`])(\/[^"'`\\]+)\1/gi;
  while ((m = callRe.exec(text)) !== null) {
    const val = m[2];
    if (val !== undefined) {
      found.add(val);
    }
  }

  // path: "/api/..."  or  "path":"/api"  common in route maps
  const pathKeyRe = /(?:path|url|endpoint|route|href|src)\s*[:=]\s*(["'`])(\/[^"'`\\]+)\1/gi;
  while ((m = pathKeyRe.exec(text)) !== null) {
    const val = m[2];
    if (val !== undefined) {
      found.add(val);
    }
  }

  return [...found];
}

export function contentTypeOf(headers: Record<string, string[]> | undefined): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "content-type") {
      return v[0];
    }
  }
  return undefined;
}

export function isLikelyAssetPath(path: string): boolean {
  return ASSET_EXT.test(path);
}
