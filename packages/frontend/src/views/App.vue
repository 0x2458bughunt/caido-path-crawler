<script setup lang="ts">
import Button from "primevue/button";
import Card from "primevue/card";
import Checkbox from "primevue/checkbox";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import { computed, onMounted, ref } from "vue";

import { CrawlTree } from "@/components/CrawlTree";
import { useSDK } from "@/plugins/sdk";
import type {
  CrawlStatus,
  CrawlTree as CrawlTreeData,
  CrawlUpdate,
  DomainGroup,
  HostNode,
  ScopeOption,
  Settings,
} from "@/types";
import { confirmDialog } from "@/utils/confirm";

const sdk = useSDK();

const domains = ref<DomainGroup[]>([]);
const totalHosts = ref(0);
const totalPaths = ref(0);
const totalJsFiles = ref(0);
const totalJsPaths = ref(0);
const filter = ref("");
const loading = ref(true);
const exporting = ref(false);
const treeRef = ref<InstanceType<typeof CrawlTree> | null>(null);
const scopes = ref<ScopeOption[]>([]);
const settings = ref<Settings | undefined>(undefined);
const crawl = ref<CrawlStatus | undefined>(undefined);
const showSettings = ref(false);

const crawlLabel = computed(() => {
  const c = crawl.value;
  if (c === undefined || (!c.running && c.sent === 0)) {
    return "";
  }
  const errors = c.errors > 0 ? ` · ${c.errors} errors` : "";
  return `${c.running ? "Crawling" : "Done"}: ${c.sent}/${c.maxRequests} sent · ${c.queued} queued${errors}`;
});

async function loadSettings(): Promise<void> {
  const [s, sc, st] = await Promise.all([
    sdk.backend.getSettings(),
    sdk.backend.getScopes(),
    sdk.backend.getCrawlStatus(),
  ]);
  if (s.kind === "Ok") {
    settings.value = s.value;
  }
  if (sc.kind === "Ok") {
    scopes.value = sc.value;
  }
  if (st.kind === "Ok") {
    crawl.value = st.value;
  }
}

async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const result = await sdk.backend.setSettings(patch);
  if (result.kind === "Error") {
    sdk.window.showToast(result.error, { variant: "error" });
    return;
  }
  settings.value = result.value;
}

async function onToggleCrawl(): Promise<void> {
  const result =
    crawl.value?.running === true
      ? await sdk.backend.stopCrawl()
      : await sdk.backend.startCrawl();
  if (result.kind === "Error") {
    sdk.window.showToast(result.error, { variant: "error" });
    return;
  }
  crawl.value = result.value;
  if (!result.value.running && result.value.sent === 0) {
    sdk.window.showToast("Nothing to crawl — every in-scope path is already visited", {
      variant: "info",
    });
  }
}

const statsLabel = computed(() => {
  return `${domains.value.length} domains · ${totalHosts.value} hosts · ${totalPaths.value} paths · ${totalJsFiles.value} JS · ${totalJsPaths.value} in-JS`;
});

async function loadTree(): Promise<void> {
  loading.value = true;
  const result = await sdk.backend.getCrawlTree();
  loading.value = false;

  if (result.kind === "Error") {
    sdk.window.showToast(result.error, { variant: "error" });
    return;
  }

  applyTree(result.value);
}

function applyTree(tree: CrawlTreeData): void {
  domains.value = tree.domains;
  totalHosts.value = tree.totalHosts;
  totalPaths.value = tree.totalPaths;
  totalJsFiles.value = tree.totalJsFiles;
  totalJsPaths.value = tree.totalJsPaths;
}

function findOrCreateHost(
  hostName: string,
  rootDomain: string,
  isCloudAsset?: boolean,
): HostNode {
  let domain = domains.value.find((d) => d.rootDomain === rootDomain);
  if (domain === undefined) {
    domain = {
      rootDomain,
      hosts: [],
      isCloudAsset: isCloudAsset === true,
    };
    domains.value = [...domains.value, domain].sort((a, b) =>
      a.rootDomain.localeCompare(b.rootDomain, undefined, { sensitivity: "base" }),
    );
  } else if (isCloudAsset === true) {
    domain.isCloudAsset = true;
  }

  let host = domain.hosts.find((h) => h.host === hostName);
  if (host === undefined) {
    host = {
      host: hostName,
      paths: [],
      jsFiles: [],
      referers: [],
      isCloudAsset: isCloudAsset === true,
    };
    domain.hosts = [...domain.hosts, host].sort((a, b) =>
      a.host.localeCompare(b.host, undefined, { sensitivity: "base" }),
    );
    totalHosts.value += 1;
  } else if (isCloudAsset === true) {
    host.isCloudAsset = true;
  }
  return host;
}

function touchDomain(rootDomain: string, hostName: string): void {
  domains.value = domains.value.map((d) => {
    if (d.rootDomain !== rootDomain) {
      return d;
    }
    return {
      rootDomain: d.rootDomain,
      isCloudAsset: d.isCloudAsset,
      hosts: d.hosts.map((h) => {
        if (h.host !== hostName) {
          return h;
        }
        return {
          host: h.host,
          paths: [...h.paths],
          jsFiles: h.jsFiles.map((j) => ({ ...j, paths: [...j.paths] })),
          referers: [...h.referers],
          isCloudAsset: h.isCloudAsset,
        };
      }),
    };
  });
}

function applyUpdate(u: CrawlUpdate): void {
  const host = findOrCreateHost(u.host, u.rootDomain, u.isCloudAsset);

  if (u.kind === "referer" && u.referer !== undefined) {
    if (!host.referers.includes(u.referer)) {
      host.referers = [...host.referers, u.referer].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" }),
      );
    }
    host.isCloudAsset = true;
    touchDomain(u.rootDomain, u.host);
    return;
  }

  if (u.kind === "path") {
    const exists = host.paths.some((p) => p.path === u.path);
    if (!exists) {
      host.paths = [
        ...host.paths,
        {
          path: u.path,
          method: u.method ?? "GET",
          source: u.source ?? "request",
          firstSeen: u.firstSeen,
          status: u.status,
        },
      ].sort((a, b) => a.path.localeCompare(b.path));
      totalPaths.value += 1;
    } else {
      host.paths = host.paths.map((p) => {
        if (p.path !== u.path) {
          return p;
        }
        return {
          ...p,
          method: u.method ?? p.method,
          source: u.source ?? p.source,
          status: u.status ?? p.status,
        };
      });
    }
  }

  if (u.kind === "js-file") {
    const existing = host.jsFiles.find((j) => j.path === u.path);
    if (existing === undefined) {
      host.jsFiles = [
        ...host.jsFiles,
        {
          path: u.path,
          firstSeen: u.firstSeen,
          paths: [],
          fetched: u.fetched === true,
        },
      ].sort((a, b) => a.path.localeCompare(b.path));
      totalJsFiles.value += 1;
    } else if (u.fetched === true) {
      existing.fetched = true;
    }
  }

  if (u.kind === "js-path" && u.jsFile !== undefined) {
    let jf = host.jsFiles.find((j) => j.path === u.jsFile);
    if (jf === undefined) {
      jf = {
        path: u.jsFile,
        firstSeen: u.firstSeen,
        paths: [],
        fetched: false,
      };
      host.jsFiles = [...host.jsFiles, jf].sort((a, b) => a.path.localeCompare(b.path));
      totalJsFiles.value += 1;
    }
    const exists = jf.paths.some((p) => p.path === u.path);
    if (!exists) {
      jf.paths = [...jf.paths, { path: u.path, firstSeen: u.firstSeen }].sort((a, b) =>
        a.path.localeCompare(b.path),
      );
      totalJsPaths.value += 1;
    }
    // Paths arriving means fetch/parse succeeded
    jf.fetched = true;
  }

  touchDomain(u.rootDomain, u.host);
}

async function onClearAll(): Promise<void> {
  const ok = await confirmDialog(sdk, {
    title: "Delete all paths?",
    message:
      "This will permanently delete all collected paths, JS files, and hosts for every domain.\n\nThis cannot be undone.",
    confirmLabel: "Delete all",
    danger: true,
  });
  if (!ok) {
    return;
  }

  const result = await sdk.backend.clearCrawlData();
  if (result.kind === "Error") {
    sdk.window.showToast(result.error, { variant: "error" });
    return;
  }
  domains.value = [];
  totalHosts.value = 0;
  totalPaths.value = 0;
  totalJsFiles.value = 0;
  totalJsPaths.value = 0;
  sdk.window.showToast("All crawl data deleted", { variant: "success" });
}

async function onDeleteHost(host: string): Promise<void> {
  const ok = await confirmDialog(sdk, {
    title: "Delete host?",
    message: `Delete all collected paths for:\n\n${host}\n\nThis cannot be undone.`,
    confirmLabel: "Delete host",
    danger: true,
  });
  if (!ok) {
    return;
  }

  const result = await sdk.backend.clearCrawlHost(host);
  if (result.kind === "Error") {
    sdk.window.showToast(result.error, { variant: "error" });
    return;
  }
  await loadTree();
  sdk.window.showToast(`Deleted ${host}`, { variant: "success" });
}

async function onDeleteDomain(rootDomain: string): Promise<void> {
  const ok = await confirmDialog(sdk, {
    title: "Delete domain group?",
    message: `Delete all hosts under:\n\n${rootDomain}\n\nEvery subdomain's paths will be removed. This cannot be undone.`,
    confirmLabel: "Delete domain",
    danger: true,
  });
  if (!ok) {
    return;
  }

  const result = await sdk.backend.clearCrawlRootDomain(rootDomain);
  if (result.kind === "Error") {
    sdk.window.showToast(result.error, { variant: "error" });
    return;
  }
  await loadTree();
  const n = result.value;
  sdk.window.showToast(`Deleted ${n} host(s) under ${rootDomain}`, { variant: "success" });
}

function onExpandAll(): void {
  treeRef.value?.expandAll();
}

function onCollapseAll(): void {
  treeRef.value?.collapseAll();
}

async function onExportMd(): Promise<void> {
  exporting.value = true;
  const result = await sdk.backend.exportCrawlMarkdown();
  exporting.value = false;

  if (result.kind === "Error") {
    sdk.window.showToast(result.error, { variant: "error" });
    return;
  }

  const md = result.value;
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.href = url;
  a.download = `path-crawler-export-${stamp}.md`;
  a.click();
  URL.revokeObjectURL(url);
  sdk.window.showToast("Exported Markdown file", { variant: "success" });
}

onMounted(() => {
  void loadTree();
  void loadSettings();

  sdk.backend.onEvent("crawl-status", (status: CrawlStatus) => {
    crawl.value = status;
  });

  sdk.backend.onEvent("crawl-updated", (updates: CrawlUpdate[]) => {
    for (const u of updates) {
      applyUpdate(u);
    }
  });

  sdk.backend.onEvent("crawl-cleared", () => {
    void loadTree();
  });
});
</script>

<template>
  <div class="h-full p-3">
    <Card
      class="h-full bg-surface-700"
      :pt="{
        body: { class: 'h-full p-0' },
        content: { class: 'h-full flex flex-col p-0' },
      }"
    >
      <template #content>
        <!-- Toolbar -->
        <div
          class="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-surface-600 bg-surface-800"
        >
          <div class="flex items-center gap-2 mr-2">
            <i class="fas fa-spider text-primary-400" />
            <span class="font-semibold text-surface-0">Path Crawler</span>
          </div>

          <span class="text-xs text-surface-400 tabular-nums hidden md:inline">
            {{ statsLabel }}
          </span>

          <div class="flex-1" />

          <Select
            :model-value="settings?.scopeId"
            :options="scopes"
            option-label="name"
            option-value="id"
            placeholder="Pick a scope…"
            size="small"
            class="w-48"
            title="Only hosts in this Caido scope are recorded and crawled"
            @update:model-value="(id: string) => updateSettings({ scopeId: id })"
            @show="loadSettings"
          />
          <Button
            :icon="crawl?.running ? 'fas fa-stop' : 'fas fa-play'"
            :label="crawl?.running ? 'Stop' : 'Crawl'"
            :severity="crawl?.running ? 'danger' : 'primary'"
            size="small"
            :disabled="settings?.scopeId === undefined"
            title="Actively GET unvisited in-scope paths (rate-limited, excludes apply)"
            @click="onToggleCrawl"
          />
          <Button
            icon="fas fa-cog"
            severity="secondary"
            size="small"
            text
            title="Crawler settings"
            @click="showSettings = !showSettings"
          />

          <span class="p-input-icon-left">
            <i class="fas fa-search" />
            <InputText
              v-model="filter"
              placeholder="Filter domain, host or path…"
              class="w-56"
              size="small"
            />
          </span>

          <Button
            icon="fas fa-expand"
            label="Expand"
            severity="secondary"
            size="small"
            text
            @click="onExpandAll"
          />
          <Button
            icon="fas fa-compress"
            label="Collapse"
            severity="secondary"
            size="small"
            text
            @click="onCollapseAll"
          />
          <Button
            icon="fas fa-file-export"
            label="Export"
            severity="secondary"
            size="small"
            text
            :loading="exporting"
            @click="onExportMd"
          />
          <Button
            icon="fas fa-sync"
            severity="secondary"
            size="small"
            text
            :loading="loading"
            @click="loadTree"
          />
          <Button
            icon="fas fa-trash"
            label="Delete all"
            severity="danger"
            size="small"
            text
            @click="onClearAll"
          />
        </div>

        <!-- Settings -->
        <div
          v-if="showSettings && settings !== undefined"
          class="flex flex-wrap items-center gap-4 px-4 py-2 border-b border-surface-600 bg-surface-800 text-xs text-surface-300"
        >
          <label class="flex items-center gap-2">
            Depth
            <InputNumber
              :model-value="settings.maxDepth"
              :min="0"
              :max="10"
              size="small"
              input-class="w-14"
              @update:model-value="(v: number) => updateSettings({ maxDepth: v })"
            />
          </label>
          <label class="flex items-center gap-2">
            Max requests
            <InputNumber
              :model-value="settings.maxRequests"
              :min="1"
              size="small"
              input-class="w-20"
              @update:model-value="(v: number) => updateSettings({ maxRequests: v })"
            />
          </label>
          <label class="flex items-center gap-2">
            Req/s
            <InputNumber
              :model-value="settings.rps"
              :min="0.1"
              :max="50"
              :max-fraction-digits="1"
              size="small"
              input-class="w-14"
              @update:model-value="(v: number) => updateSettings({ rps: v })"
            />
          </label>
          <label class="flex items-center gap-2 flex-1 min-w-64">
            Exclude regex
            <InputText
              :model-value="settings.exclude"
              size="small"
              class="flex-1 font-mono"
              @change="(e: Event) => updateSettings({ exclude: (e.target as HTMLInputElement).value })"
            />
          </label>
          <label class="flex items-center gap-2">
            <Checkbox
              :model-value="settings.saveHistory"
              binary
              @update:model-value="(v: boolean) => updateSettings({ saveHistory: v })"
            />
            Save crawl requests to HTTP history
          </label>
        </div>

        <div
          v-if="settings !== undefined && settings.scopeId === undefined"
          class="px-4 py-2 text-xs text-yellow-300 bg-surface-800 border-b border-surface-600"
        >
          <i class="fas fa-exclamation-triangle mr-1" />
          Nothing is recorded or requested until you pick a scope.
        </div>
        <div
          v-else-if="crawlLabel.length > 0"
          class="px-4 py-1 text-xs text-surface-400 tabular-nums bg-surface-800 border-b border-surface-600"
        >
          {{ crawlLabel }}
        </div>

        <!-- Tree -->
        <div class="flex-1 overflow-auto p-3">
          <CrawlTree
            ref="treeRef"
            :domains="domains"
            :filter="filter"
            @delete-host="onDeleteHost"
            @delete-domain="onDeleteDomain"
          />
        </div>
      </template>
    </Card>
  </div>
</template>
