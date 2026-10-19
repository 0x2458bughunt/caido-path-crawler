/**
 * Where a path came from: proxied traffic, an HTML link / redirect,
 * a cross-host reference inside JS, or our own active crawl.
 */
export type PathSource = "request" | "html" | "js" | "crawl";

/** A path discovered via a proxied request (or HTML). */
export type PathEntry = {
  path: string;
  method: string;
  source: PathSource;
  firstSeen: number;
  /** Last response status seen for this path (proxied or crawled) */
  status?: number;
};

/** Paths extracted from inside a JavaScript file. */
export type JsPathEntry = {
  path: string;
  firstSeen: number;
};

/** A JavaScript file with the paths found inside it. */
export type JsFileEntry = {
  path: string;
  firstSeen: number;
  paths: JsPathEntry[];
  /** Whether we successfully fetched/parsed the JS body at least once */
  fetched: boolean;
};

/** Host-level crawl node (full hostname, possibly with port). */
export type HostNode = {
  host: string;
  paths: PathEntry[];
  jsFiles: JsFileEntry[];
  /**
   * For CDN / cloud storage hosts: sites that loaded this host (from Referer/Origin).
   * Display as: d111.cloudfront.net [ABC.COM]
   */
  referers: string[];
  /** True when host matches a known CDN / cloud object-storage pattern */
  isCloudAsset: boolean;
};

/**
 * Root-domain group: e.g. "abc.com" containing test1.abc.com, test2.abc.com, …
 * For CDNs: "cloudfront.net" with child hosts like d111.cloudfront.net.
 */
export type DomainGroup = {
  rootDomain: string;
  hosts: HostNode[];
  /** True when this root is a known CDN / cloud storage family */
  isCloudAsset: boolean;
};

/** Full crawl tree returned to the frontend. */
export type CrawlTree = {
  domains: DomainGroup[];
  totalHosts: number;
  totalPaths: number;
  totalJsFiles: number;
  totalJsPaths: number;
};

/** Live update payload for incremental UI refresh. */
export type CrawlUpdate = {
  host: string;
  rootDomain: string;
  kind: "path" | "js-file" | "js-path" | "referer";
  path: string;
  method?: string;
  source?: PathSource;
  status?: number;
  jsFile?: string;
  firstSeen: number;
  fetched?: boolean;
  /** Root domain of the page that loaded this (CDN) host */
  referer?: string;
  isCloudAsset?: boolean;
};

/** User-tunable crawler settings, persisted in the plugin DB. */
export type Settings = {
  /** Caido scope ID. Nothing is recorded or requested until one is chosen. */
  scopeId: string | undefined;
  /** Link hops followed from the seed paths during an active crawl */
  maxDepth: number;
  /** Hard cap on requests sent per crawl run */
  maxRequests: number;
  /** Requests per second (active crawl + JS fetches) */
  rps: number;
  /** Paths matching this regex are never actively requested */
  exclude: string;
  /** Save active requests to Caido's HTTP history */
  saveHistory: boolean;
};

export type CrawlStatus = {
  running: boolean;
  sent: number;
  queued: number;
  errors: number;
  maxRequests: number;
};

export type ScopeOption = {
  id: string;
  name: string;
};

export type Result<T> =
  | { kind: "Error"; error: string }
  | { kind: "Ok"; value: T };
