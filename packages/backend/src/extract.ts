/**
 * Path extraction from HTML and JavaScript response bodies.
 * Designed for passive discovery (Burp-style sitemap enrichment).
 */

const MAX_BODY_CHARS = 2_000_000;

/** Extensions we treat as static assets (still recorded as paths if requested). */
const ASSET_EXT =
  /\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map|css|less|scss|mp[34]|webm|avi|mov|pdf|zip|gz|tar|br)(?:\?|$)/i;

/**
 * Normalize a discovered path:
 * - strip query/hash for storage key consistency of pure paths
 * - ensure leading slash for absolute paths
 * - reject junk / binary-looking values
 */
export function normalizePath(raw: string): string | undefined {
  let p = raw.trim();
  if (p.length === 0 || p.length > 2048) {
    return undefined;
  }

  // Drop protocol-relative and full URLs handled elsewhere
  if (p.startsWith("//")) {
    return undefined;
  }

  // Decode common escapes from JS strings
  p = p.replace(/\\u002f/gi, "/").replace(/\\\//g, "/");

  // Strip surrounding quotes leftovers
  p = p.replace(/^["'`]+|["'`]+$/g, "");

  // Drop data:/javascript:/mailto:/tel: schemes
  if (/^(?:data|javascript|mailto|tel|blob|about):/i.test(p)) {
    return undefined;
  }

  // Full absolute URL → keep path only
  if (/^https?:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      p = u.pathname + (u.search.length > 0 ? u.search : "");
    } catch {
      return undefined;
    }
  }

  // Relative paths like ./api or ../api → normalize to absolute-ish
  if (p.startsWith("./")) {
    p = "/" + p.slice(2);
  } else if (p.startsWith("../")) {
    p = "/" + p.replace(/^(\.\.\/)+/, "");
  }

  // Must look like a path
  if (!p.startsWith("/")) {
    return undefined;
  }

  // Reject pure root with nothing useful? keep "/" — useful.
  // Reject control chars / whitespace
  if (/[\x00-\x1f\x7f\s]/.test(p)) {
    return undefined;
  }

  // Reject obvious noise
  if (p === "/null" || p === "/undefined" || p === "/NaN") {
    return undefined;
  }

  // Collapse repeated slashes
  p = p.replace(/\/{2,}/g, "/");

  // Drop fragment
  const hashIdx = p.indexOf("#");
  if (hashIdx !== -1) {
    p = p.slice(0, hashIdx);
  }

  if (p.length === 0) {
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

function pushPath(set: Set<string>, raw: string): void {
  const n = normalizePath(raw);
  if (n !== undefined) {
    set.add(n);
  }
}

/**
 * Extract paths from HTML (href, src, action, formaction, data-*, srcset).
 */
export function extractPathsFromHtml(body: string): string[] {
  const text = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
  const found = new Set<string>();

  // href / src / action / formaction / poster / data-url / data-href etc.
  const attrRe =
    /(?:href|src|action|formaction|poster|data-(?:url|href|src|path|endpoint|api))\s*=\s*(["'])(.*?)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(text)) !== null) {
    const val = m[2];
    if (val !== undefined) {
      pushPath(found, val);
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
      if (url !== undefined) {
        pushPath(found, url);
      }
    }
  }

  // Bare absolute paths in quotes inside inline scripts already handled by JS extractor if we call both.
  return [...found];
}

/**
 * Extract path-like strings from JavaScript source.
 * Covers: string literals, template literals, fetch/axios/XHR style URLs, route configs.
 */
export function extractPathsFromJs(body: string): string[] {
  const text = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
  const found = new Set<string>();

  // Double-quoted, single-quoted, and backtick strings that look like paths or URLs
  const stringRe = /(["'`])((?:https?:\/\/[^"'`\\]+|\/[^"'`\\]{0,500}?))\1/g;
  let m: RegExpExecArray | null;
  while ((m = stringRe.exec(text)) !== null) {
    const val = m[2];
    if (val !== undefined) {
      // Skip pure asset refs that are clearly static images fonts etc. inside JS? keep them —
      // testers often want every path. Filter only obvious noise later if needed.
      pushPath(found, val);
    }
  }

  // Relative module/import paths that start with ./ or ../
  const relRe = /(?:from|import|require\s*\()\s*(["'`])(\.\.?\/[^"'`\\]+)\1/g;
  while ((m = relRe.exec(text)) !== null) {
    const val = m[2];
    if (val !== undefined) {
      pushPath(found, val);
    }
  }

  // fetch("/x"), axios.get("/x"), .open("GET","/x"), location = "/x"
  const callRe =
    /(?:fetch|axios\.(?:get|post|put|patch|delete|head|options)|open|navigate|assign|replace)\s*\(\s*(?:["'][A-Z]+["']\s*,\s*)?(["'`])(\/[^"'`\\]+)\1/gi;
  while ((m = callRe.exec(text)) !== null) {
    const val = m[2];
    if (val !== undefined) {
      pushPath(found, val);
    }
  }

  // path: "/api/..."  or  "path":"/api"  common in route maps
  const pathKeyRe = /(?:path|url|endpoint|route|href|src)\s*[:=]\s*(["'`])(\/[^"'`\\]+)\1/gi;
  while ((m = pathKeyRe.exec(text)) !== null) {
    const val = m[2];
    if (val !== undefined) {
      pushPath(found, val);
    }
  }

  // Filter very noisy pure-asset-only discoveries? Keep; optional filter:
  // Remove paths that are only "/." or single-char noise
  return [...found].filter((p) => {
    if (p.length < 2 && p !== "/") {
      return false;
    }
    // Drop source maps path noise like huge base64 — already length limited
    return true;
  });
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
