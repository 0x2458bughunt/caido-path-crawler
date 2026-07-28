# Publishing Path Crawler (GitHub + Caido Store)

This guide follows the official Caido docs:

- [Set Up Repository](https://developer.caido.io/plugins/guides/repository.html)
- [Submit to Store](https://developer.caido.io/plugins/guides/store.html)
- [Plugin Signing](https://developer.caido.io/plugins/concepts/signing.html)
- [`plugin_packages.json` reference](https://developer.caido.io/plugins/reference/plugin_packages.html)

Plugin source code is already production-ready. This document only covers **repo setup, signing, releases, and store PR**.

---

## Checklist overview

```
[ ] 1. Create empty GitHub repository
[ ] 2. Enable Immutable releases
[ ] 3. Push this project to GitHub
[ ] 4. Add PRIVATE_KEY secret (from local private.pem)
[ ] 5. Run 🚀 Release workflow → signed GitHub Release
[ ] 6. Open PR on caido/store with plugin_packages entry
[ ] 7. Sign CLA + address review comments
```

---

## 1. Create the GitHub repository

1. Open https://github.com/new  
2. Name it e.g. `caido-path-crawler` (public)  
3. **Do not** initialize with README / license (this folder already has them)  
4. Create the repository  

If you prefer hosting under **caido-community**, request a repo on the [Caido Discord](https://links.caido.io/www-discord).

---

## 2. Enable Immutable Releases (required)

1. Repo → **Settings** → **General**  
2. Scroll to **Releases**  
3. Enable **Immutable releases**  

This prevents tags/releases from being rewritten after publish (required by Caido).

---

## 3. Push the project

From this folder (adjust remote URL to your account/org):

```bash
cd caido-path-crawler

git init
git add .
git status   # confirm private.pem is NOT listed

git commit -m "Initial release: Path Crawler for Caido"
git branch -M main
git remote add origin git@github.com:YOUR_USERNAME/caido-path-crawler.git
git push -u origin main
```

### If your GitHub username is not `0x2458`

Update these placeholders before the store PR:

| Location | Field |
|----------|--------|
| `store/plugin_packages.entry.json` | `"repository": "YOUR_USERNAME/caido-path-crawler"` |
| `package.json` | `"repository.url"` |
| `store/plugin_packages.entry.json` | `"author.url"` (optional) |

Plugin **id** stays `path-crawler` (must match `caido.config.ts` and be unique in the store).

---

## 4. Signing keys

An Ed25519 key pair was generated for this plugin:

| File | Commit? | Use |
|------|---------|-----|
| `public.pem` | ✅ Yes | Store `public_key` field |
| `private.pem` | ❌ **Never** | Sign releases (`PRIVATE_KEY` secret) |

Public key (Base64 only — already in `store/plugin_packages.entry.json`):

```text
MCowBQYDK2VwAyEALxJ9vDf8SKQOlKmL3UNm/VWuspD1mK1bZeN4uGBxRtU=
```

### Add the private key as a GitHub secret

1. Repo → **Settings** → **Secrets and variables** → **Actions**  
2. **New repository secret**  
3. Name: `PRIVATE_KEY`  
4. Value: **entire** contents of `private.pem`, including the header/footer lines:

```text
-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----
```

Show the local file (never paste into chat/issues):

```bash
cat private.pem
```

> **Lost `private.pem`?** Generate a new pair, update `public.pem` + store entry, and create a new release. You cannot re-sign with a different private key using the same store public key.

```bash
# Only if you need a NEW key pair (OpenSSL 3+)
openssl genpkey -algorithm ed25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
# public_key for store = body of public.pem without BEGIN/END lines
```

---

## 5. Create a signed GitHub Release

Version is taken from `caido.config.ts` → built `manifest.json` (currently **1.2.0**).

1. Ensure latest code is on `main`  
2. GitHub → **Actions** → **🚀 Release** → **Run workflow**  
3. Branch: `main`  
4. Wait for success  

The release will include:

- `plugin_package.zip` — installable package  
- `plugin_package.zip.sig` — Ed25519 signature  

Users (and the store) verify the zip with your public key.

### Bumping versions later

1. Change `version` in `caido.config.ts` (semver)  
2. Optionally sync root `package.json` version  
3. Commit + push to `main`  
4. Run **🚀 Release** again  

No new store PR is needed after the first acceptance — new releases are picked up from GitHub.

---

## 6. Submit to the Caido Store (one-time PR)

### 6.1 Prepare the entry

Ready-made entry: [`store/plugin_packages.entry.json`](../store/plugin_packages.entry.json)

```json
{
  "id": "path-crawler",
  "name": "Path Crawler",
  "license": "MIT",
  "description": "Passive path discovery from proxied traffic — host-grouped sitemap, JS path extraction, and CDN referer labels.",
  "author": {
    "name": "0x2458",
    "url": "https://github.com/0x2458"
  },
  "public_key": "MCowBQYDK2VwAyEALxJ9vDf8SKQOlKmL3UNm/VWuspD1mK1bZeN4uGBxRtU=",
  "repository": "0x2458/caido-path-crawler"
}
```

Optional: add `"email": "you@example.com"` under `author` if you want it public.

### 6.2 Open the PR

1. Edit  
   https://github.com/caido/store/edit/main/plugin_packages.json  
2. Add a **comma** after the previous entry’s closing `}`  
3. Paste your entry at the **end** of the JSON array  
4. Validate JSON (no trailing comma after the last entry)  
5. Commit → **Propose changes**  
6. PR title: `Add Path Crawler`  
7. Fill the PR template checkboxes with `[x]`  
8. Create the pull request  

### 6.3 CLA

Sign the [Contributor License Agreement](https://cla-assistant.io/caido/store) when the bot asks.

---

## 7. Review cycle

1. Caido reviews the PR and may request changes  
2. Fix code/docs if needed, push to your plugin repo  
3. Bump version + run **🚀 Release** so the store sees a new signed package  
4. Comment on the store PR that feedback was addressed  

After merge, users install **Path Crawler** from the in-app store.

Announce in Discord **Plugin #discussion** when live:  
https://links.caido.io/www-discord

---

## Local install (without the store)

```bash
pnpm install
pnpm build
# Install dist/plugin_package.zip via Caido → Plugins → Install from file
```

---

## Security notes

- One key pair **per plugin** (already done for Path Crawler)  
- Never commit `private.pem` or put it in issues/PRs  
- Be careful with PRs that modify `.github/workflows/*` (could exfiltrate `PRIVATE_KEY`)  
- Prefer reviewing workflow changes carefully on public repos  

---

## Quick reference

| Item | Value |
|------|--------|
| Plugin id | `path-crawler` |
| Display name | Path Crawler |
| License | MIT |
| Current version | `1.2.0` (see `caido.config.ts`) |
| Public key file | `public.pem` |
| Release workflow | `.github/workflows/release.yml` |
| Store entry | `store/plugin_packages.entry.json` |
