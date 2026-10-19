import type { DefineAPI, DefineEvents, SDK } from "caido:plugin";
import { RequestSpec } from "caido:utils";
import type { Request, Response } from "caido:utils";

import { extractRefererLabel, isCloudAssetHost } from "./cdn";
import { getRootDomain } from "./domain";
import {
  contentTypeOf,
  extractFromHtml,
  extractRefsFromJs,
  isHtmlContent,
  isJsPath,
  isLikelyAssetPath,
  pathOf,
  resolveRef,
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
  getCrawlSeeds,
  getTree,
  initStore,
  isJsFetched,
  isVisited,
  loadSettings,
  markJsFetched,
  saveSettings,
  setStatus,
} from "./store";
import type {
  CrawlStatus,
  CrawlTree,
  CrawlUpdate,
  PathSource,
  Result,
  ScopeOption,
  Settings,
} from "./types";

export type {
  CrawlStatus,
  CrawlTree,
  CrawlUpdate,
  DomainGroup,
  HostNode,
  JsFileEntry,
  JsPathEntry,
  PathEntry,
  PathSource,
  Result,
  ScopeOption,
  Settings,
} from "./types";

const DEFAULT_SETTINGS: Settings = {
  scopeId: undefined,
  maxDepth: 3,
  maxRequests: 500,
  rps: 5,
  exclude: "log-?out|sign-?out|delete|remove|destroy|unsubscribe|deactivate|revoke|reset",
  saveHistory: false,
};

/** Concurrent in-flight active requests */
const MAX_IN_FLIGHT = 4;

let settings: Settings = DEFAULT_SETTINGS;
let excludeRe = new RegExp(DEFAULT_SETTINGS.exclude, "i");

/** hostKey → scheme://authority last seen in traffic (hosts default to https) */
const origins = new Map<string, string>();

/** hostKey → session headers from the latest proxied request, replayed on active requests */
const sessions = new Map<string, Record<string, string>>();

type Job = { url: URL; depth: number; js: boolean };

const queue: Job[] = [];
/** host|path keys queued or sent this session (DB flags cover restarts) */
const queued = new Set<string>();
const run = { running: false, sent: 0, errors: 0 };
let inFlight = 0;
let pumping = false;
let lastSent = 0;

type PluginSDK = SDK<API, BackendEvents>;

// ── Scope ────────────────────────────────────────────────────────────────────

function scopeOk(sdk: PluginSDK, target: Request | RequestSpec | string): boolean {
  if (settings.scopeId === undefined) {
    return false;
  }
  try {
    const req = typeof target === "string" ? new RequestSpec(target) : target;
    return sdk.requests.inScope(req, [settings.scopeId]);
  } catch {
    return false;
  }
}

function originOf(host: string): string {
  return origins.get(host) ?? `https://${host}`;
}

function hostInScope(sdk: PluginSDK, host: string): boolean {
  return scopeOk(sdk, `${originOf(host)}/`);
}

// ── API ──────────────────────────────────────────────────────────────────────

async function getCrawlTree(sdk: SDK): Promise<Result<CrawlTree>> {
  const s = sdk as PluginSDK;
  const tree = await getTree((h) => hostInScope(s, h));
  return { kind: "Ok", value: tree };
}

function forgetQueued(host: string | undefined): void {
  for (const key of [...queued]) {
    if (host === undefined || key.startsWith(`${host}|`)) {
      queued.delete(key);
    }
  }
}

async function clearCrawlData(sdk: SDK): Promise<Result<void>> {
  const result = await clearAll();
  if (result.kind === "Ok") {
    forgetQueued(undefined);
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
    forgetQueued(host);
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
    forgetQueued(undefined);
    (sdk as PluginSDK).api.send("crawl-cleared", rootDomain);
  }
  return result;
}

async function exportCrawlMarkdown(sdk: SDK): Promise<Result<string>> {
  const s = sdk as PluginSDK;
  const md = await exportMarkdown((h) => hostInScope(s, h));
  return { kind: "Ok", value: md };
}

async function getScopes(sdk: SDK): Promise<Result<ScopeOption[]>> {
  const scopes = await sdk.scope.getAll();
  return { kind: "Ok", value: scopes.map((s) => ({ id: s.id, name: s.name })) };
}

function getSettings(_sdk: SDK): Result<Settings> {
  return { kind: "Ok", value: settings };
}

async function setSettings(sdk: SDK, patch: Partial<Settings>): Promise<Result<Settings>> {
  const next: Settings = { ...settings, ...patch };
  let re: RegExp;
  try {
    re = new RegExp(next.exclude, "i");
  } catch (err) {
    return { kind: "Error", error: `Invalid exclude regex: ${String(err)}` };
  }
  next.maxDepth = Math.max(0, Math.min(10, Math.floor(next.maxDepth)));
  next.maxRequests = Math.max(1, Math.min(100_000, Math.floor(next.maxRequests)));
  next.rps = Math.max(0.1, Math.min(50, next.rps));

  const scopeChanged = next.scopeId !== settings.scopeId;
  settings = next;
  excludeRe = re;
  await saveSettings(next);

  if (scopeChanged) {
    stopRun(sdk as PluginSDK);
    queue.length = 0;
    (sdk as PluginSDK).api.send("crawl-cleared", undefined);
  }
  return { kind: "Ok", value: settings };
}

function status(): CrawlStatus {
  return {
    running: run.running,
    sent: run.sent,
    queued: queue.length,
    errors: run.errors,
    maxRequests: settings.maxRequests,
  };
}

function getCrawlStatus(_sdk: SDK): Result<CrawlStatus> {
  return { kind: "Ok", value: status() };
}

async function startCrawl(sdk: SDK): Promise<Result<CrawlStatus>> {
  const s = sdk as PluginSDK;
  if (settings.scopeId === undefined) {
    return { kind: "Error", error: "Pick a scope first" };
  }
  if (run.running) {
    return { kind: "Ok", value: status() };
  }
  run.running = true;
  run.sent = 0;
  run.errors = 0;

  for (const { host, path } of await getCrawlSeeds()) {
    const url = resolveRef(path, `${originOf(host)}/`);
    if (url !== undefined) {
      await enqueue(s, url, 0, isJsPath(path, undefined));
    }
  }
  finishIfIdle(s);
  emitStatus(s);
  return { kind: "Ok", value: status() };
}

function stopCrawl(sdk: SDK): Result<CrawlStatus> {
  stopRun(sdk as PluginSDK);
  return { kind: "Ok", value: status() };
}

export type API = DefineAPI<{
  getCrawlTree: typeof getCrawlTree;
  clearCrawlData: typeof clearCrawlData;
  clearCrawlHost: typeof clearCrawlHost;
  clearCrawlRootDomain: typeof clearCrawlRootDomain;
  exportCrawlMarkdown: typeof exportCrawlMarkdown;
  getScopes: typeof getScopes;
  getSettings: typeof getSettings;
  setSettings: typeof setSettings;
  getCrawlStatus: typeof getCrawlStatus;
  startCrawl: typeof startCrawl;
  stopCrawl: typeof stopCrawl;
}>;

export type BackendEvents = DefineEvents<{
  "crawl-updated": (updates: CrawlUpdate[]) => void;
  "crawl-cleared": (host: string | undefined) => void;
  "crawl-status": (status: CrawlStatus) => void;
}>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function emit(sdk: PluginSDK, updates: CrawlUpdate[]): void {
  if (updates.length === 0) {
    return;
  }
  sdk.api.send("crawl-updated", updates);
}

function emitStatus(sdk: PluginSDK): void {
  sdk.api.send("crawl-status", status());
}

function rememberRequest(request: Request): string {
  const url = new URL(request.getUrl());
  origins.set(url.host, `${url.protocol}//${url.host}`);

  const headers: Record<string, string> = {};
  for (const name of ["Cookie", "Authorization", "User-Agent"]) {
    const value = request.getHeader(name);
    if (value !== undefined && value.length > 0) {
      headers[name] = value.join(name === "Cookie" ? "; " : ", ");
    }
  }
  // Merge: requests without cookies (CORS preflights, beacons) must not wipe the session
  sessions.set(url.host, { ...sessions.get(url.host), ...headers });
  return url.host;
}

/** Paths we never actively request: user excludes, static assets, templated routes. */
function skipCrawl(path: string): boolean {
  return excludeRe.test(path) || isLikelyAssetPath(path) || /[{}$<>]|\/:[a-z]/i.test(path);
}

// ── Active request queue ─────────────────────────────────────────────────────

/**
 * Queue an in-scope URL for an active GET.
 * JS files are fetched once whenever discovered; pages only during a crawl run.
 */
async function enqueue(sdk: PluginSDK, url: URL, depth: number, js: boolean): Promise<void> {
  const path = pathOf(url);
  if (path === undefined) {
    return;
  }
  const key = `${url.host}|${path}`;
  if (queued.has(key) || !scopeOk(sdk, url.href)) {
    return;
  }
  if (js) {
    if (await isJsFetched(url.host, path)) {
      return;
    }
  } else if (!run.running || depth > settings.maxDepth || skipCrawl(path)) {
    return;
  } else if (await isVisited(url.host, path)) {
    return;
  }

  queued.add(key);
  url.search = "";
  url.hash = "";
  queue.push({ url, depth, js });
  void pump(sdk);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pump(sdk: PluginSDK): Promise<void> {
  if (pumping) {
    return;
  }
  pumping = true;
  while (queue.length > 0) {
    while (inFlight >= MAX_IN_FLIGHT) {
      await sleep(50);
    }
    const wait = lastSent + 1000 / settings.rps - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }
    const job = queue.shift();
    if (job === undefined) {
      break;
    }
    lastSent = Date.now();
    void send(sdk, job);
  }
  pumping = false;
}

async function send(sdk: PluginSDK, job: Job): Promise<void> {
  inFlight += 1;
  if (run.running) {
    run.sent += 1;
  }
  try {
    const spec = new RequestSpec(job.url.href);
    spec.setMethod("GET");
    spec.setHeader("Accept", job.js ? "*/*" : "text/html,application/xhtml+xml,*/*;q=0.8");
    spec.setHeader("User-Agent", "Caido-PathCrawler/2.0");
    for (const [name, value] of Object.entries(sessions.get(job.url.host) ?? {})) {
      spec.setHeader(name, value);
    }
    // Last line of defence: the spec we actually send must be in scope
    if (!scopeOk(sdk, spec)) {
      return;
    }

    const { response } = await sdk.requests.send(spec, {
      timeouts: 20_000,
      save: settings.saveHistory,
    });
    await ingest(sdk, job.url, response, job.depth, job.js ? undefined : "crawl");
  } catch (err) {
    run.errors += 1;
    sdk.console.error(`Path Crawler: ${job.url.href} failed: ${String(err)}`);
  } finally {
    inFlight -= 1;
    if (run.running && run.sent >= settings.maxRequests) {
      stopRun(sdk);
    }
    finishIfIdle(sdk);
    emitStatus(sdk);
  }
}

function stopRun(sdk: PluginSDK): void {
  if (!run.running) {
    return;
  }
  run.running = false;
  // Drop pending pages; keep one-shot JS fetches
  const js = queue.filter((j) => j.js);
  for (const j of queue) {
    if (!j.js) {
      queued.delete(`${j.url.host}|${pathOf(j.url) ?? ""}`);
    }
  }
  queue.length = 0;
  queue.push(...js);
  emitStatus(sdk);
}

function finishIfIdle(sdk: PluginSDK): void {
  if (run.running && inFlight === 0 && !queue.some((j) => !j.js)) {
    run.running = false;
    emitStatus(sdk);
  }
}

// ── Ingest (proxied + active responses) ──────────────────────────────────────

/**
 * Record a response and mine its body for more paths.
 * `source` is set when the URL itself should be stored as a path (crawl hits).
 */
async function ingest(
  sdk: PluginSDK,
  url: URL,
  response: Response,
  depth: number,
  source: PathSource | undefined,
): Promise<void> {
  const host = url.host;
  const path = pathOf(url);
  if (path === undefined) {
    return;
  }
  const ct = contentTypeOf(response.getHeaders());
  const code = response.getCode();
  const updates: CrawlUpdate[] = [];
  const push = (u: CrawlUpdate | undefined) => {
    if (u !== undefined) {
      updates.push(u);
    }
  };

  const js = isJsPath(path, ct);
  if (source !== undefined && !js) {
    push(await addPath(host, path, "GET", source));
  }
  if (!js) {
    push(await setStatus(host, path, code));
  }

  const body = response.getBody()?.toText() ?? "";

  if (js) {
    const file = await addJsFile(host, path);
    push(file.update);
    if (body.length === 0 || code >= 400) {
      // 304 / cached by the browser → fetch it ourselves once
      if (source === undefined && code < 400) {
        await enqueue(sdk, url, depth, true);
      }
      emit(sdk, updates);
      return;
    }
    for (const raw of extractRefsFromJs(body)) {
      await record(sdk, raw, url, depth, { host, jsFile: path }, push);
    }
    await markJsFetched(host, path);
    push({
      host,
      rootDomain: getRootDomain(host),
      kind: "js-file",
      path,
      firstSeen: Date.now(),
      fetched: true,
    });
    emit(sdk, updates);
    return;
  }

  if (code >= 300 && code < 400) {
    const location = response.getHeader("Location")?.[0];
    if (location !== undefined) {
      await record(sdk, location, url, depth, undefined, push);
    }
  } else if (isHtmlContent(ct, path) && body.length > 0) {
    const html = extractFromHtml(body);
    const base = (html.base === undefined ? undefined : resolveRef(html.base, url.href)) ?? url;
    for (const raw of html.refs) {
      await record(sdk, raw, base, depth, undefined, push);
    }
    for (const script of html.scripts) {
      for (const raw of extractRefsFromJs(script)) {
        await record(sdk, raw, base, depth, undefined, push);
      }
    }
  }

  emit(sdk, updates);
}

/**
 * Resolve one discovered reference, store it if in scope, and queue it.
 * `inJs` nests same-host paths under the JS file they were found in.
 */
async function record(
  sdk: PluginSDK,
  raw: string,
  base: URL,
  depth: number,
  inJs: { host: string; jsFile: string } | undefined,
  push: (u: CrawlUpdate | undefined) => void,
): Promise<void> {
  const url = resolveRef(raw, base.href);
  if (url === undefined || !scopeOk(sdk, url.href)) {
    return;
  }
  const path = pathOf(url);
  if (path === undefined) {
    return;
  }

  if (isJsPath(path, undefined)) {
    push((await addJsFile(url.host, path)).update);
    await enqueue(sdk, url, depth + 1, true);
    return;
  }

  if (inJs !== undefined && inJs.host === url.host) {
    push(await addJsPath(url.host, inJs.jsFile, path));
  } else {
    push(await addPath(url.host, path, "GET", inJs === undefined ? "html" : "js"));
  }
  await enqueue(sdk, url, depth + 1, false);
}

// ── Interceptors ─────────────────────────────────────────────────────────────

async function handleRequest(sdk: PluginSDK, request: Request): Promise<void> {
  if (!scopeOk(sdk, request)) {
    return;
  }
  const host = rememberRequest(request);
  const path = pathOf(new URL(request.getUrl()));
  if (path === undefined) {
    return;
  }

  const updates: CrawlUpdate[] = [];

  // For in-scope CDN / cloud hosts, capture who loaded them (Referer → Origin)
  if (isCloudAssetHost(host)) {
    const label = extractRefererLabel(request.getHeaders(), host);
    if (label !== undefined) {
      const u = await addReferer(host, label);
      if (u !== undefined) {
        updates.push(u);
      }
    }
  }

  const u = isJsPath(path, undefined)
    ? (await addJsFile(host, path)).update
    : await addPath(host, path, request.getMethod(), "request");
  if (u !== undefined) {
    updates.push(u);
  }

  emit(sdk, updates);
}

async function handleResponse(
  sdk: PluginSDK,
  request: Request,
  response: Response,
): Promise<void> {
  if (!scopeOk(sdk, request)) {
    return;
  }
  await ingest(sdk, new URL(request.getUrl()), response, 0, undefined);
}

// ── Init ─────────────────────────────────────────────────────────────────────

export async function init(sdk: PluginSDK): Promise<void> {
  await initStore(sdk);
  settings = await loadSettings(DEFAULT_SETTINGS);
  excludeRe = new RegExp(settings.exclude, "i");

  sdk.api.register("getCrawlTree", getCrawlTree);
  sdk.api.register("clearCrawlData", clearCrawlData);
  sdk.api.register("clearCrawlHost", clearCrawlHost);
  sdk.api.register("clearCrawlRootDomain", clearCrawlRootDomain);
  sdk.api.register("exportCrawlMarkdown", exportCrawlMarkdown);
  sdk.api.register("getScopes", getScopes);
  sdk.api.register("getSettings", getSettings);
  sdk.api.register("setSettings", setSettings);
  sdk.api.register("getCrawlStatus", getCrawlStatus);
  sdk.api.register("startCrawl", startCrawl);
  sdk.api.register("stopCrawl", stopCrawl);

  sdk.events.onInterceptRequest((s, request) => {
    void handleRequest(s as PluginSDK, request);
  });

  sdk.events.onInterceptResponse((s, request, response) => {
    void handleResponse(s as PluginSDK, request, response);
  });

  sdk.console.log("Path Crawler initialized (in-scope only)");
}
