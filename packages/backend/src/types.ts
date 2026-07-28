/** A path discovered via a proxied request (or HTML). */
export type PathEntry = {
  path: string;
  method: string;
  source: "request" | "html";
  firstSeen: number;
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
  source?: "request" | "html";
  jsFile?: string;
  firstSeen: number;
  fetched?: boolean;
  /** Root domain of the page that loaded this (CDN) host */
  referer?: string;
  isCloudAsset?: boolean;
};

export type Result<T> =
  | { kind: "Error"; error: string }
  | { kind: "Ok"; value: T };
