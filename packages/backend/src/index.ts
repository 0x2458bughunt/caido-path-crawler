import type { DefineAPI, DefineEvents, SDK } from "caido:plugin";
import { RequestSpec } from "caido:utils";
import type { Request, Response } from "caido:utils";

import { extractRefererLabel, isCloudAssetHost } from "./cdn";
import { getRootDomain } from "./domain";
import {
  contentTypeOf,
  extractPathsFromHtml,
  extractPathsFromJs,
  isHtmlContent,
  isJsPath,
  normalizePath,
} from "./extract";
import {
  addJsFile,
  addJsPath,
  addPath,
  addReferer,
  clearAll,
  clearHost,
  clearRootDomain,
  exportMarkdown,
  getTree,
  initStore,
  isJsFetched,
  markJsFetched,
} from "./store";
import type { CrawlTree, CrawlUpdate, Result } from "./types";

export type {
  CrawlTree,
  CrawlUpdate,
  DomainGroup,
  HostNode,
  JsFileEntry,
  JsPathEntry,
  PathEntry,
  Result,
} from "./types";

// ── Connection memory (for active JS fetches) ────────────────────────────────

type ConnInfo = {
  hostname: string;
  port: number;
  tls: boolean;
};

/** hostKey → last seen connection details */
const hostConns = new Map<string, ConnInfo>();

/** In-flight / completed active JS fetches this session: hostKey|path */
const jsFetchState = new Set<string>();

// ── API ──────────────────────────────────────────────────────────────────────

async function getCrawlTree(_sdk: SDK): Promise<Result<CrawlTree>> {
  const tree = await getTree();
  return { kind: "Ok", value: tree };
}

async function clearCrawlData(sdk: SDK): Promise<Result<void>> {
  const result = await clearAll();
  if (result.kind === "Ok") {
    jsFetchState.clear();
    (sdk as PluginSDK).api.send("crawl-cleared", undefined);
  }
  return result;
}

async function clearCrawlHost(sdk: SDK, host: string): Promise<Result<void>> {
  if (host.trim().length === 0) {
    return { kind: "Error", error: "Host is required" };
  }
  const result = await clearHost(host);
  if (result.kind === "Ok") {
    // Drop fetch state for this host
    for (const key of [...jsFetchState]) {
      if (key.startsWith(`${host}|`)) {
        jsFetchState.delete(key);
      }
    }
    (sdk as PluginSDK).api.send("crawl-cleared", host);
  }
  return result;
}

async function clearCrawlRootDomain(
  sdk: SDK,
  rootDomain: string,
): Promise<Result<number>> {
  if (rootDomain.trim().length === 0) {
    return { kind: "Error", error: "Root domain is required" };
  }
  const result = await clearRootDomain(rootDomain);
  if (result.kind === "Ok") {
    jsFetchState.clear();
    (sdk as PluginSDK).api.send("crawl-cleared", rootDomain);
  }
  return result;
}

async function exportCrawlMarkdown(_sdk: SDK): Promise<Result<string>> {
  const md = await exportMarkdown();
  return { kind: "Ok", value: md };
}

export type API = DefineAPI<{
  getCrawlTree: typeof getCrawlTree;
  clearCrawlData: typeof clearCrawlData;
  clearCrawlHost: typeof clearCrawlHost;
  clearCrawlRootDomain: typeof clearCrawlRootDomain;
  exportCrawlMarkdown: typeof exportCrawlMarkdown;
}>;

export type BackendEvents = DefineEvents<{
  "crawl-updated": (updates: CrawlUpdate[]) => void;
  "crawl-cleared": (host: string | undefined) => void;
}>;

type PluginSDK = SDK<API, BackendEvents>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function hostKey(request: Request): string {
  const host = request.getHost();
  const port = request.getPort();
  const tls = request.getTls();
  const defaultPort = tls ? 443 : 80;
  if (port === defaultPort) {
    return host;
  }
  return `${host}:${port}`;
}

function rememberConn(request: Request): string {
  const key = hostKey(request);
  hostConns.set(key, {
    hostname: request.getHost(),
    port: request.getPort(),
    tls: request.getTls(),
  });
  return key;
}

function responseContentType(response: Response): string | undefined {
  return contentTypeOf(response.getHeaders());
}

function emit(sdk: PluginSDK, updates: CrawlUpdate[]): void {
  if (updates.length === 0) {
    return;
  }
  sdk.api.send("crawl-updated", updates);
}

function jsStateKey(host: string, path: string): string {
  return `${host}|${path}`;
}

function buildJsUrl(conn: ConnInfo, path: string): string {
  const scheme = conn.tls ? "https" : "http";
  const defaultPort = conn.tls ? 443 : 80;
  const authority =
    conn.port === defaultPort ? conn.hostname : `${conn.hostname}:${conn.port}`;
  // path should already start with /
  return `${scheme}://${authority}${path}`;
}

/**
 * Actively request a JS file once so we can parse its body for paths.
 * Skips if already fetched (DB) or an in-flight/session fetch exists.
 */
async function ensureJsFetched(
  sdk: PluginSDK,
  host: string,
  path: string,
  connHint?: ConnInfo,
): Promise<void> {
  const stateKey = jsStateKey(host, path);
  if (jsFetchState.has(stateKey)) {
    return;
  }

  if (await isJsFetched(host, path)) {
    jsFetchState.add(stateKey);
    return;
  }

  const conn = connHint ?? hostConns.get(host);
  if (conn === undefined) {
    // No connection info yet — wait until we see traffic to this host
    return;
  }

  jsFetchState.add(stateKey);

  try {
    const url = buildJsUrl(conn, path);
    const spec = new RequestSpec(url);
    spec.setMethod("GET");
    spec.setHeader("Accept", "*/*");
    spec.setHeader("User-Agent", "Caido-PathCrawler/1.0");

    const result = await sdk.requests.send(spec);
    const response = result.response;
    if (response === undefined) {
      jsFetchState.delete(stateKey);
      return;
    }

    const body = response.getBody()?.toText();
    if (body === undefined || body.length === 0) {
      // Still mark attempted so we don't hammer; allow retry by not marking DB fetched
      return;
    }

    await processJsBody(sdk, host, path, body);
  } catch (err) {
    sdk.console.error(`JS fetch failed for ${host}${path}: ${String(err)}`);
    jsFetchState.delete(stateKey);
  }
}

async function processJsBody(
  sdk: PluginSDK,
  host: string,
  path: string,
  body: string,
): Promise<void> {
  const updates: CrawlUpdate[] = [];

  const { update: jsFileUpdate } = await addJsFile(host, path);
  if (jsFileUpdate !== undefined) {
    updates.push(jsFileUpdate);
  }

  const found = extractPathsFromJs(body);
  for (const p of found) {
    // Nested JS references → register + fetch once
    if (isJsPath(p, undefined)) {
      const nested = await addJsFile(host, p);
      if (nested.update !== undefined) {
        updates.push(nested.update);
      }
      if (!nested.alreadyFetched) {
        void ensureJsFetched(sdk, host, p);
      }
      continue;
    }
    const u = await addJsPath(host, path, p);
    if (u !== undefined) {
      updates.push(u);
    }
  }

  await markJsFetched(host, path);
  jsFetchState.add(jsStateKey(host, path));

  // Notify UI that this JS file is fully processed (even if no new paths)
  updates.push({
    host,
    rootDomain: getRootDomain(host),
    kind: "js-file",
    path,
    firstSeen: Date.now(),
    fetched: true,
  });

  emit(sdk, updates);
}

async function registerJsAndMaybeFetch(
  sdk: PluginSDK,
  host: string,
  path: string,
  connHint?: ConnInfo,
): Promise<CrawlUpdate | undefined> {
  const { update, alreadyFetched } = await addJsFile(host, path);
  if (!alreadyFetched) {
    void ensureJsFetched(sdk, host, path, connHint);
  }
  return update;
}

// ── Interceptors ─────────────────────────────────────────────────────────────

/**
 * For CDN / cloud storage hosts, attach the page that loaded them (Referer → Origin).
 */
async function maybeRecordReferer(
  request: Request,
  host: string,
): Promise<CrawlUpdate | undefined> {
  if (!isCloudAssetHost(host)) {
    return undefined;
  }
  const label = extractRefererLabel(request.getHeaders(), host);
  if (label === undefined) {
    return undefined;
  }
  return addReferer(host, label);
}

async function handleRequest(sdk: PluginSDK, request: Request): Promise<void> {
  const host = rememberConn(request);
  const rawPath = request.getPath();
  const method = request.getMethod();
  const path = normalizePath(rawPath) ?? rawPath;
  const conn = hostConns.get(host);

  const updates: CrawlUpdate[] = [];

  // Always try to capture who loaded this CDN host
  const refUpdate = await maybeRecordReferer(request, host);
  if (refUpdate !== undefined) {
    updates.push(refUpdate);
  }

  if (isJsPath(path, undefined)) {
    const u = await registerJsAndMaybeFetch(sdk, host, path, conn);
    if (u !== undefined) {
      updates.push(u);
    }
    emit(sdk, updates);
    return;
  }

  const pathUpdate = await addPath(host, path, method, "request");
  if (pathUpdate !== undefined) {
    updates.push(pathUpdate);
  }

  emit(sdk, updates);
}

async function handleResponse(
  sdk: PluginSDK,
  request: Request,
  response: Response,
): Promise<void> {
  const host = rememberConn(request);
  const rawPath = request.getPath();
  const path = normalizePath(rawPath) ?? rawPath;
  const ct = responseContentType(response);
  const body = response.getBody()?.toText();
  const conn = hostConns.get(host);

  if (body === undefined || body.length === 0) {
    return;
  }

  // JavaScript response body (from browser or our active fetch)
  if (isJsPath(path, ct)) {
    // Mark in-flight so ensureJsFetched won't double-send if intercept wins the race
    jsFetchState.add(jsStateKey(host, path));
    await processJsBody(sdk, host, path, body);
    return;
  }

  const updates: CrawlUpdate[] = [];

  if (isHtmlContent(ct, path)) {
    const found = extractPathsFromHtml(body);
    for (const p of found) {
      if (isJsPath(p, undefined)) {
        const u = await registerJsAndMaybeFetch(sdk, host, p, conn);
        if (u !== undefined) {
          updates.push(u);
        }
        continue;
      }
      const u = await addPath(host, p, "GET", "html");
      if (u !== undefined) {
        updates.push(u);
      }
    }

    const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let m: RegExpExecArray | null;
    while ((m = scriptRe.exec(body)) !== null) {
      const scriptBody = m[1];
      if (scriptBody === undefined || scriptBody.trim().length === 0) {
        continue;
      }
      const jsPaths = extractPathsFromJs(scriptBody);
      for (const p of jsPaths) {
        if (isJsPath(p, undefined)) {
          const u = await registerJsAndMaybeFetch(sdk, host, p, conn);
          if (u !== undefined) {
            updates.push(u);
          }
          continue;
        }
        const u = await addPath(host, p, "GET", "html");
        if (u !== undefined) {
          updates.push(u);
        }
      }
    }
  }

  emit(sdk, updates);
}

// ── Init ─────────────────────────────────────────────────────────────────────

export async function init(sdk: PluginSDK): Promise<void> {
  await initStore(sdk);

  sdk.api.register("getCrawlTree", getCrawlTree);
  sdk.api.register("clearCrawlData", clearCrawlData);
  sdk.api.register("clearCrawlHost", clearCrawlHost);
  sdk.api.register("clearCrawlRootDomain", clearCrawlRootDomain);
  sdk.api.register("exportCrawlMarkdown", exportCrawlMarkdown);

  sdk.events.onInterceptRequest((s, request) => {
    void handleRequest(s as PluginSDK, request);
  });

  sdk.events.onInterceptResponse((s, request, response) => {
    void handleResponse(s as PluginSDK, request, response);
  });

  sdk.console.log(`Path Crawler initialized (root grouping e.g. ${getRootDomain("test.abc.com")})`);
}
