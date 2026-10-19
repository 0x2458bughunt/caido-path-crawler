// Self-check for URL resolution + extraction: node --experimental-strip-types packages/backend/test/extract.check.ts
import assert from "node:assert/strict";

import { extractFromHtml, extractRefsFromJs, pathOf, resolveRef } from "../src/extract.ts";

const page = "https://app.t.com/a/b/page.html";
const path = (raw: string, base = page) => {
  const url = resolveRef(raw, base);
  const p = url === undefined ? undefined : pathOf(url);
  return url === undefined || p === undefined ? undefined : `${url.host}${p}`;
};

assert.equal(path("/api/users"), "app.t.com/api/users");
assert.equal(path("next.html"), "app.t.com/a/b/next.html");
assert.equal(path("../up"), "app.t.com/a/up");
assert.equal(path("//cdn.t.com/x.js"), "cdn.t.com/x.js");
assert.equal(path("https://evil.com/x"), "evil.com/x"); // attributed to its real host, not the page's
assert.equal(path("\\/api\\/escaped"), "app.t.com/api/escaped");
assert.equal(path("/api/u/${id}"), "app.t.com/api/u/${id}");
assert.equal(path("./chunk.js", "https://app.t.com/static/main.js"), "app.t.com/static/chunk.js");
for (const junk of ["javascript:void(0)", "mailto:a@b", "data:text/html,x", "/has space", "/api/undefined"]) {
  assert.equal(path(junk), undefined, junk);
}

const html = extractFromHtml(
  `<base href="/v2/"><a href=unquoted>x</a><img srcset="a.png 1x, b.png 2x"><script>fetch("/inline")</script>`,
);
assert.equal(html.base, "/v2/");
assert.deepEqual(html.refs.sort(), ["/v2/", "a.png", "b.png", "unquoted"]);
assert.deepEqual(extractRefsFromJs(html.scripts[0] ?? ""), ["/inline"]);

console.log("extract ok");
