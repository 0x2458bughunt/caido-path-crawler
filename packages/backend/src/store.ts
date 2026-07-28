import type { SDK } from "caido:plugin";

import { isCloudAssetHost } from "./cdn";
import { getRootDomain } from "./domain";
import type {
  CrawlTree,
  CrawlUpdate,
  DomainGroup,
  HostNode,
  JsFileEntry,
  JsPathEntry,
  PathEntry,
  Result,
} from "./types";

type Database = Awaited<ReturnType<SDK["meta"]["db"]>>;

let db: Database | undefined;

export async function initStore(sdk: SDK): Promise<void> {
  db = await sdk.meta.db();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS crawl_paths (
      host TEXT NOT NULL,
      path TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'GET',
      source TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      PRIMARY KEY (host, path)
    );

    CREATE TABLE IF NOT EXISTS crawl_js_files (
      host TEXT NOT NULL,
      path TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      fetched INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (host, path)
    );

    CREATE TABLE IF NOT EXISTS crawl_js_paths (
      host TEXT NOT NULL,
      js_file TEXT NOT NULL,
      path TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      PRIMARY KEY (host, js_file, path)
    );

    CREATE TABLE IF NOT EXISTS crawl_referers (
      host TEXT NOT NULL,
      referer TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      PRIMARY KEY (host, referer)
    );

    CREATE INDEX IF NOT EXISTS idx_crawl_paths_host ON crawl_paths(host);
    CREATE INDEX IF NOT EXISTS idx_crawl_js_files_host ON crawl_js_files(host);
    CREATE INDEX IF NOT EXISTS idx_crawl_js_paths_host ON crawl_js_paths(host);
    CREATE INDEX IF NOT EXISTS idx_crawl_referers_host ON crawl_referers(host);
  `);

  // Migration for older installs without `fetched`
  try {
    await db.exec(`ALTER TABLE crawl_js_files ADD COLUMN fetched INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // column already exists
  }
}

function requireDb(): Database {
  if (db === undefined) {
    throw new Error("Database not initialized");
  }
  return db;
}

function withRoot(update: Omit<CrawlUpdate, "rootDomain">): CrawlUpdate {
  return {
    ...update,
    rootDomain: getRootDomain(update.host),
    isCloudAsset: isCloudAssetHost(update.host),
  };
}

/**
 * Record a referring site for a CDN / cloud-storage host.
 * `referer` should already be a normalized root-domain label (e.g. "abc.com").
 */
export async function addReferer(
  host: string,
  referer: string,
): Promise<CrawlUpdate | undefined> {
  if (!isCloudAssetHost(host)) {
    return undefined;
  }
  const label = referer.trim().toLowerCase();
  if (label.length === 0) {
    return undefined;
  }

  const database = requireDb();
  const now = Date.now();

  const existing = await database.prepare(
    "SELECT 1 AS ok FROM crawl_referers WHERE host = ? AND referer = ?",
  );
  const row = await existing.get(host, label);
  if (row !== undefined) {
    return undefined;
  }

  const stmt = await database.prepare(
    "INSERT INTO crawl_referers (host, referer, first_seen) VALUES (?, ?, ?)",
  );
  await stmt.run(host, label, now);
  return withRoot({
    host,
    kind: "referer",
    path: "",
    referer: label,
    firstSeen: now,
  });
}

/** Record a path observed from a request or HTML. Returns update if newly inserted. */
export async function addPath(
  host: string,
  path: string,
  method: string,
  source: "request" | "html",
): Promise<CrawlUpdate | undefined> {
  const database = requireDb();
  const now = Date.now();

  const existing = await database.prepare(
    "SELECT source FROM crawl_paths WHERE host = ? AND path = ?",
  );
  const row = (await existing.get(host, path)) as { source: string } | undefined;

  if (row !== undefined) {
    if (row.source === "html" && source === "request") {
      const upd = await database.prepare(
        "UPDATE crawl_paths SET source = ?, method = ? WHERE host = ? AND path = ?",
      );
      await upd.run(source, method, host, path);
      return withRoot({ host, kind: "path", path, method, source, firstSeen: now });
    }
    return undefined;
  }

  const stmt = await database.prepare(
    "INSERT INTO crawl_paths (host, path, method, source, first_seen) VALUES (?, ?, ?, ?, ?)",
  );
  await stmt.run(host, path, method, source, now);
  return withRoot({ host, kind: "path", path, method, source, firstSeen: now });
}

/**
 * Register a JS file for a host.
 * Returns { update, isNew } so caller can decide whether to active-fetch.
 */
export async function addJsFile(
  host: string,
  path: string,
): Promise<{ update: CrawlUpdate | undefined; isNew: boolean; alreadyFetched: boolean }> {
  const database = requireDb();
  const now = Date.now();

  const existing = await database.prepare(
    "SELECT fetched FROM crawl_js_files WHERE host = ? AND path = ?",
  );
  const row = (await existing.get(host, path)) as { fetched: number } | undefined;

  if (row !== undefined) {
    return {
      update: undefined,
      isNew: false,
      alreadyFetched: row.fetched === 1,
    };
  }

  const stmt = await database.prepare(
    "INSERT INTO crawl_js_files (host, path, first_seen, fetched) VALUES (?, ?, ?, 0)",
  );
  await stmt.run(host, path, now);
  return {
    update: withRoot({ host, kind: "js-file", path, firstSeen: now, fetched: false }),
    isNew: true,
    alreadyFetched: false,
  };
}

/** Mark a JS file as successfully fetched/parsed. */
export async function markJsFetched(host: string, path: string): Promise<void> {
  const database = requireDb();
  const stmt = await database.prepare(
    "UPDATE crawl_js_files SET fetched = 1 WHERE host = ? AND path = ?",
  );
  await stmt.run(host, path);
}

export async function isJsFetched(host: string, path: string): Promise<boolean> {
  const database = requireDb();
  const stmt = await database.prepare(
    "SELECT fetched FROM crawl_js_files WHERE host = ? AND path = ?",
  );
  const row = (await stmt.get(host, path)) as { fetched: number } | undefined;
  return row?.fetched === 1;
}

/** Record a path found inside a JS file. */
export async function addJsPath(
  host: string,
  jsFile: string,
  path: string,
): Promise<CrawlUpdate | undefined> {
  const database = requireDb();
  const now = Date.now();

  await addJsFile(host, jsFile);

  const existing = await database.prepare(
    "SELECT 1 AS ok FROM crawl_js_paths WHERE host = ? AND js_file = ? AND path = ?",
  );
  const row = await existing.get(host, jsFile, path);
  if (row !== undefined) {
    return undefined;
  }

  const stmt = await database.prepare(
    "INSERT INTO crawl_js_paths (host, js_file, path, first_seen) VALUES (?, ?, ?, ?)",
  );
  await stmt.run(host, jsFile, path, now);
  return withRoot({ host, kind: "js-path", path, jsFile, firstSeen: now });
}

async function loadHostNode(database: Database, host: string): Promise<HostNode> {
  const pathsStmt = await database.prepare(
    "SELECT path, method, source, first_seen FROM crawl_paths WHERE host = ? ORDER BY path COLLATE NOCASE",
  );
  const pathRows = (await pathsStmt.all(host)) as Array<{
    path: string;
    method: string;
    source: "request" | "html";
    first_seen: number;
  }>;

  const paths: PathEntry[] = pathRows.map((r) => ({
    path: r.path,
    method: r.method,
    source: r.source,
    firstSeen: r.first_seen,
  }));

  const jsFilesStmt = await database.prepare(
    "SELECT path, first_seen, fetched FROM crawl_js_files WHERE host = ? ORDER BY path COLLATE NOCASE",
  );
  const jsFileRows = (await jsFilesStmt.all(host)) as Array<{
    path: string;
    first_seen: number;
    fetched: number;
  }>;

  const jsFiles: JsFileEntry[] = [];
  for (const jf of jsFileRows) {
    const jpStmt = await database.prepare(
      "SELECT path, first_seen FROM crawl_js_paths WHERE host = ? AND js_file = ? ORDER BY path COLLATE NOCASE",
    );
    const jpRows = (await jpStmt.all(host, jf.path)) as Array<{
      path: string;
      first_seen: number;
    }>;
    const jpEntries: JsPathEntry[] = jpRows.map((r) => ({
      path: r.path,
      firstSeen: r.first_seen,
    }));
    jsFiles.push({
      path: jf.path,
      firstSeen: jf.first_seen,
      paths: jpEntries,
      fetched: jf.fetched === 1,
    });
  }

  const refStmt = await database.prepare(
    "SELECT referer FROM crawl_referers WHERE host = ? ORDER BY referer COLLATE NOCASE",
  );
  const refRows = (await refStmt.all(host)) as Array<{ referer: string }>;
  const referers = refRows.map((r) => r.referer);

  return {
    host,
    paths,
    jsFiles,
    referers,
    isCloudAsset: isCloudAssetHost(host),
  };
}

export async function getTree(): Promise<CrawlTree> {
  const database = requireDb();

  const hostsStmt = await database.prepare(`
    SELECT host FROM (
      SELECT host FROM crawl_paths
      UNION
      SELECT host FROM crawl_js_files
      UNION
      SELECT host FROM crawl_referers
    ) ORDER BY host COLLATE NOCASE
  `);
  const hostRows = (await hostsStmt.all()) as Array<{ host: string }>;

  const byRoot = new Map<string, HostNode[]>();
  let totalPaths = 0;
  let totalJsFiles = 0;
  let totalJsPaths = 0;

  for (const { host } of hostRows) {
    const node = await loadHostNode(database, host);
    totalPaths += node.paths.length;
    totalJsFiles += node.jsFiles.length;
    for (const jf of node.jsFiles) {
      totalJsPaths += jf.paths.length;
    }

    const root = getRootDomain(host);
    const list = byRoot.get(root);
    if (list === undefined) {
      byRoot.set(root, [node]);
    } else {
      list.push(node);
    }
  }

  const domains: DomainGroup[] = [...byRoot.entries()]
    .map(([rootDomain, hosts]) => ({
      rootDomain,
      hosts: hosts.sort((a, b) =>
        a.host.localeCompare(b.host, undefined, { sensitivity: "base" }),
      ),
      isCloudAsset: hosts.some((h) => h.isCloudAsset) || isCloudAssetHost(rootDomain),
    }))
    .sort((a, b) =>
      a.rootDomain.localeCompare(b.rootDomain, undefined, { sensitivity: "base" }),
    );

  return {
    domains,
    totalHosts: hostRows.length,
    totalPaths,
    totalJsFiles,
    totalJsPaths,
  };
}

/** Build a markdown export of the full crawl tree, grouped by root domain then host. */
export async function exportMarkdown(): Promise<string> {
  const tree = await getTree();
  const lines: string[] = [
    "# Path Crawler Export",
    "",
    `Exported: ${new Date().toISOString()}`,
    "",
    `Hosts: ${tree.totalHosts} · Paths: ${tree.totalPaths} · JS files: ${tree.totalJsFiles} · Paths in JS: ${tree.totalJsPaths}`,
    "",
  ];

  for (const domain of tree.domains) {
    const domainTag = domain.isCloudAsset ? " _(CDN / cloud storage)_" : "";
    lines.push(`## ${domain.rootDomain}${domainTag}`);
    lines.push("");

    for (const host of domain.hosts) {
      const refLabel =
        host.referers.length > 0
          ? ` [${host.referers.map((r) => r.toUpperCase()).join(", ")}]`
          : "";
      lines.push(`### ${host.host}${refLabel}`);
      lines.push("");

      if (host.referers.length > 0) {
        lines.push(`**Loaded by:** ${host.referers.join(", ")}`);
        lines.push("");
      }

      if (host.paths.length > 0) {
        lines.push("#### Paths");
        lines.push("");
        for (const p of host.paths) {
          lines.push(`- \`${p.path}\` (${p.method}, ${p.source})`);
        }
        lines.push("");
      }

      if (host.jsFiles.length > 0) {
        lines.push("#### JavaScript files");
        lines.push("");
        for (const jf of host.jsFiles) {
          lines.push(`- \`${jf.path}\`${jf.fetched ? "" : " _(not fetched)_"}`);
          if (jf.paths.length > 0) {
            for (const jp of jf.paths) {
              lines.push(`  - \`${jp.path}\``);
            }
          } else {
            lines.push("  - _(no paths extracted)_");
          }
        }
        lines.push("");
      }

      if (host.paths.length === 0 && host.jsFiles.length === 0) {
        lines.push("_No paths_");
        lines.push("");
      }
    }
  }

  if (tree.domains.length === 0) {
    lines.push("_No data_");
    lines.push("");
  }

  return lines.join("\n");
}

export async function clearAll(): Promise<Result<void>> {
  const database = requireDb();
  await database.exec(`
    DELETE FROM crawl_js_paths;
    DELETE FROM crawl_js_files;
    DELETE FROM crawl_paths;
    DELETE FROM crawl_referers;
  `);
  return { kind: "Ok", value: undefined };
}

export async function clearHost(host: string): Promise<Result<void>> {
  const database = requireDb();
  const s1 = await database.prepare("DELETE FROM crawl_js_paths WHERE host = ?");
  await s1.run(host);
  const s2 = await database.prepare("DELETE FROM crawl_js_files WHERE host = ?");
  await s2.run(host);
  const s3 = await database.prepare("DELETE FROM crawl_paths WHERE host = ?");
  await s3.run(host);
  const s4 = await database.prepare("DELETE FROM crawl_referers WHERE host = ?");
  await s4.run(host);
  return { kind: "Ok", value: undefined };
}

/** Delete every host that belongs to the given root domain (eTLD+1). */
export async function clearRootDomain(rootDomain: string): Promise<Result<number>> {
  const database = requireDb();
  const hostsStmt = await database.prepare(`
    SELECT host FROM (
      SELECT host FROM crawl_paths
      UNION
      SELECT host FROM crawl_js_files
      UNION
      SELECT host FROM crawl_referers
    )
  `);
  const hostRows = (await hostsStmt.all()) as Array<{ host: string }>;
  const targets = hostRows
    .map((r) => r.host)
    .filter((h) => getRootDomain(h) === rootDomain);

  for (const host of targets) {
    await clearHost(host);
  }

  return { kind: "Ok", value: targets.length };
}
