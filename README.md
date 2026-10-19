# Path Crawler

**Scope-aware path discovery for [Caido](https://caido.io)** — a Burp-style site map that grows from real traffic, plus an optional active crawl.

Every **in-scope** request you proxy, every HTML link, and every JavaScript file is mined for paths, then organized into an expandable tree by root domain and host. Hit **Crawl** to actively request the paths you haven't visited yet — still in-scope only.

<p align="center">
  <img alt="Caido" src="https://img.shields.io/badge/Caido-Plugin-a0213e?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.5-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="Vue" src="https://img.shields.io/badge/Vue-3-42b883?style=flat-square&logo=vuedotjs&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/License-MIT-green?style=flat-square" />
</p>

---

## Why Path Crawler?

During an engagement you visit pages, the browser fires a waterfall of XHR/fetch calls, and JS bundles hide half the API surface. Path Crawler sits on the proxy and quietly maps all of that into a structured view — no active spider required unless you want JS files fetched once for deeper extraction.

| Problem | What Path Crawler does |
|--------|-------------------------|
| Paths only live in HTTP history | Builds a host-centric tree you can browse |
| JS routes stay buried in minified code | Parses JS bodies for paths, routes, `fetch` / `axios` URLs |
| CDNs look orphaned (`*.cloudfront.net`) | Tags CDN hosts with **Referer / Origin** → `[ABC.COM]` |
| Hard to share findings | **Export Markdown** grouped by domain → host |

---

## Features

### Traffic mapping
- **Every proxied request** is recorded (pages + XHR/fetch/subresources)
- **HTML parsing** for `href`, `src`, `action`, `srcset`, data-url attributes, and inline scripts
- **JavaScript path extraction** from string literals, route maps, and common HTTP APIs
- **Active JS fetch (once)** — when a `.js` file is discovered, the plugin requests it a single time so the body can be parsed even if the browser never loaded it fully

### Organization
- **Root-domain grouping (eTLD+1)**  
  `test1.abc.com`, `test2.abc.com`, `api.abc.com` → under expandable **`abc.com`**
- **Per-host children** with paths and expandable JS files
- **CDN / cloud storage awareness** with referer labels (see below)

### Scope & active crawl
- **In-scope only** — pick a Caido scope in the toolbar. Until you do, nothing is recorded and nothing is requested. Out-of-scope traffic, links and JS references are ignored, and every active request is re-checked against the scope right before it is sent
- **Crawl / Stop** — GETs every unvisited in-scope path (from traffic, HTML, redirects and JS), follows new links up to the configured depth, and records the response status on each path
- **Guard rails** (⚙ settings): max depth, max requests per run, requests/second, exclude regex (default skips `logout|delete|remove|destroy|reset|…`), and static assets / templated routes (`/user/${id}`, `/:id`) are never requested
- Active requests reuse the `Cookie` / `Authorization` / `User-Agent` from your latest proxied request to that host, so authenticated areas get crawled
- Crawl requests are **not** saved to HTTP history unless you enable it in settings
- Relative links resolve properly (`<base href>`, `../`, protocol-relative), and absolute URLs are filed under their real host

### Workflow
- Live updates as traffic flows (no manual refresh required)
- Filter by domain, host, path, or referer
- Expand / collapse all
- Export to **Markdown** (`.md`)
- Delete all, a domain group, or a single host — **always with confirmation**
- SQLite persistence across Caido restarts

---

## Tree structure

```
▸ abc.com
    ▸ www.abc.com
        /home/user                          [GET] [REQ]
        /api/v1/account                     [GET] [HTML]
      ▸ /static/main.js
            /home/logout                              [JS]
            /posts                                    [JS]
    ▸ api.abc.com
        /v2/users

▸ cloudfront.net                                      [CDN]
    ▸ d111abc.cloudfront.net          [ABC.COM]
        /assets/app.js
        /assets/chunk-vendors.js
```

| Badge | Meaning |
|-------|---------|
| **REQ** | Seen as a real proxied request |
| **HTML** | Discovered from HTML attributes / inline script / redirect |
| **JS** | Extracted from a JavaScript file body |
| **CRAWL** | Found and requested by the active crawl |
| **200 / 302 / 403…** | Last response status seen for the path |
| **[ABC.COM]** | CDN/cloud host was loaded by this site (Referer or Origin) |
| **CDN** | Root domain is a known CDN / object-storage family |
| **fetching…** | Active one-shot JS request in progress |

---

## CDN & cloud storage referers

Third-party asset hosts are easy to lose context on. Path Crawler detects popular CDN and object-storage hosts and records **who loaded them**.

```
cloudfront.net
  └─ d111.cloudfront.net  [ABC.COM]
       └─ /static/app.js
```

**Sources:** `Referer` header, falling back to `Origin` (CORS subresources).

**Covered families (non-exhaustive):**

| Provider | Examples |
|----------|----------|
| AWS | `cloudfront.net`, `amazonaws.com` (S3, etc.) |
| Azure | `azureedge.net`, `azurefd.net`, `blob.core.windows.net` |
| Google | `googleapis.com`, `googleusercontent.com`, `gstatic.com` |
| Cloudflare | `cloudflarestorage.com`, `r2.dev`, `pages.dev`, `workers.dev` |
| Akamai | `akamaihd.net`, `akamaized.net`, `edgesuite.net`, `edgekey.net` |
| Fastly / others | `fastly.net`, `imgix.net`, `cloudinary.com`, `b-cdn.net`, `bunnycdn.com` |
| Object storage | DigitalOcean Spaces, Backblaze B2, Wasabi, Vercel Blob, Supabase |
| Common CDNs | jsDelivr, unpkg, BootstrapCDN, Shopify CDN, and more |

Full matcher list lives in [`packages/backend/src/cdn.ts`](packages/backend/src/cdn.ts).

---

## Install

### Option A — Install a release build

1. Download `plugin_package.zip` from the [Releases](../../releases) page  
   *(or build it yourself — Option B)*
2. Open **Caido → Plugins → Install from file**
3. Select the zip
4. Open **Path Crawler** in the sidebar (spider icon)

### Option B — Build from source

**Requirements:** Node.js 18+, [pnpm](https://pnpm.io)

```bash
git clone https://github.com/<you>/caido-path-crawler.git
cd caido-path-crawler

pnpm install
pnpm build
```

Install the generated package:

```
dist/plugin_package.zip
```

---

## Usage

1. Proxy your browser (or target app) through Caido as usual  
2. Browse the application — Path Crawler records passively  
3. Open the **Path Crawler** page  
4. Expand a root domain → host → JS file to explore  
5. Use **Export** for a Markdown report, or delete hosts/domains when done  

### Export format

Exported files look like:

```markdown
# Path Crawler Export

Exported: 2026-07-28T12:00:00.000Z

Hosts: 4 · Paths: 42 · JS files: 3 · Paths in JS: 18

## abc.com

### www.abc.com

#### Paths

- `/api/v1/users` (GET, request)

#### JavaScript files

- `/static/main.js`
  - `/home/logout`
  - `/posts`

## cloudfront.net _(CDN / cloud storage)_

### d111.cloudfront.net [ABC.COM]

**Loaded by:** abc.com

#### Paths

- `/assets/app.js` (GET, request)
```

---

## How it works

```
Browser ──proxy──► Caido
                     │
                     ├─ onInterceptRequest
                     │    • record host + path
                     │    • register .js nodes
                     │    • for CDN hosts: store Referer/Origin
                     │
                     └─ onInterceptResponse
                          • HTML → extract links / forms / scripts
                          • JS body → extract nested paths
                          • unknown JS files → GET once, then parse
```

| Event | Behavior |
|-------|----------|
| `onInterceptRequest` | Store path; register JS files; capture CDN referer |
| `onInterceptResponse` (JS) | Parse body → nest paths under that JS file |
| `onInterceptResponse` (HTML) | Parse links + inline scripts; queue JS fetch when needed |
| Active `sdk.requests.send` | One-shot GET for discovered JS (deduped per host+path) |

Data is stored in the plugin’s **SQLite** database (`sdk.meta.db()`).  
The UI receives live **`crawl-updated`** events and reloads after deletes via **`crawl-cleared`**.

### JavaScript extraction heuristics

- Quoted strings that look like absolute paths (`"/api/..."`) or full URLs  
- `fetch()`, `axios.*`, `open()`, navigation-style APIs  
- Object keys: `path`, `url`, `endpoint`, `route`, `href`, `src`  
- Relative `import` / `require` paths (`./`, `../`)

Bodies larger than ~2MB are truncated for performance.

---

## Development

```bash
pnpm install
pnpm watch          # rebuild on change
pnpm typecheck      # tsc + vue-tsc
pnpm check          # URL resolution / extraction self-check
pnpm build          # production → dist/plugin_package.zip
```

For hot reload inside Caido, install the community [**Devtools**](https://github.com/caido-community/devtools) plugin and connect it to the watch server.

### Project layout

```
caido-path-crawler/
├── caido.config.ts              # Plugin package config
├── packages/
│   ├── backend/src/
│   │   ├── index.ts             # Interceptors, API, JS fetch
│   │   ├── store.ts             # SQLite persistence
│   │   ├── extract.ts           # HTML / JS path extractors
│   │   ├── domain.ts            # eTLD+1 grouping
│   │   ├── cdn.ts               # CDN detection + referer labels
│   │   └── types.ts             # Shared types
│   └── frontend/src/
│       ├── index.ts             # Sidebar page registration
│       ├── views/App.vue        # Toolbar, export, delete
│       ├── components/
│       │   ├── CrawlTree/       # Expandable domain → host → JS tree
│       │   └── ConfirmDialog/   # Delete confirmations
│       └── utils/confirm.ts
└── dist/plugin_package.zip      # Installable artifact
```

### Tech stack

| Layer | Stack |
|-------|--------|
| Backend | TypeScript, Caido Backend SDK, SQLite |
| Frontend | Vue 3, PrimeVue, Tailwind (Caido theme) |
| Build | `@caido-community/dev`, Vite, pnpm workspaces |

---

## Privacy & safety

- **In-scope only**: no scope selected → no recording, no requests  
- **Passive by default**; the only automatic active requests are one GET per discovered in-scope JS file  
- **Active crawl only when you press Crawl** — GET only, rate-limited, capped, exclude regex applied  
- No telemetry, no external network calls except those in-scope GETs  
- All data stays in Caido’s local plugin database for the current project  

Use only on systems you are authorized to test.

---

## Contributing

1. Fork and create a feature branch  
2. Keep TypeScript strict; avoid `any`  
3. Run `pnpm typecheck` and `pnpm build` before opening a PR  
4. Describe the behavior change clearly (screenshots help for UI)


```
Plugin ID:     path-crawler
Public key:    public.pem  (committed)
Private key:   private.pem (local only → GitHub secret PRIVATE_KEY)
Store entry:   store/plugin_packages.entry.json
```

---

## Acknowledgments

- [Caido](https://caido.io) and the [Caido community](https://github.com/caido-community) plugin ecosystem  
- Inspired by Burp Suite’s site map / content discovery model  

---

## License

[MIT](LICENSE) © 0x2458

---

<p align="center">
  <sub>Built for pentesters who live in the proxy.</sub>
</p>
