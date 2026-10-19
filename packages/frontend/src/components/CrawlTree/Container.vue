<script setup lang="ts">
import Button from "primevue/button";
import { computed, ref } from "vue";

import type { DomainGroup, HostNode } from "@/types";

const props = defineProps<{
  domains: DomainGroup[];
  filter: string;
}>();

const emit = defineEmits<{
  deleteHost: [host: string];
  deleteDomain: [rootDomain: string];
}>();

const expandedDomains = ref<Set<string>>(new Set());
const expandedHosts = ref<Set<string>>(new Set());
const expandedJs = ref<Set<string>>(new Set());

const filteredDomains = computed((): DomainGroup[] => {
  const q = props.filter.trim().toLowerCase();
  if (q.length === 0) {
    return props.domains;
  }

  return props.domains
    .map((domain) => {
      const rootMatch = domain.rootDomain.toLowerCase().includes(q);
      const hosts = domain.hosts
        .map((host) => filterHost(host, q, rootMatch))
        .filter((h): h is HostNode => h !== undefined);

      if (!rootMatch && hosts.length === 0) {
        return undefined;
      }

      return {
        rootDomain: domain.rootDomain,
        hosts: rootMatch ? domain.hosts : hosts,
        isCloudAsset: domain.isCloudAsset,
      };
    })
    .filter((d): d is DomainGroup => d !== undefined);
});

function filterHost(host: HostNode, q: string, parentMatch: boolean): HostNode | undefined {
  const refMatch = host.referers.some((r) => r.toLowerCase().includes(q));
  const hostMatch =
    parentMatch || host.host.toLowerCase().includes(q) || refMatch;
  const paths = host.paths.filter(
    (p) => hostMatch || p.path.toLowerCase().includes(q) || p.method.toLowerCase().includes(q),
  );
  const jsFiles = host.jsFiles
    .map((jf) => {
      const jfMatch = hostMatch || jf.path.toLowerCase().includes(q);
      const pathsInside = jf.paths.filter((p) => jfMatch || p.path.toLowerCase().includes(q));
      if (!jfMatch && pathsInside.length === 0) {
        return undefined;
      }
      return {
        ...jf,
        paths: jfMatch ? jf.paths : pathsInside,
      };
    })
    .filter((jf): jf is NonNullable<typeof jf> => jf !== undefined);

  if (!hostMatch && paths.length === 0 && jsFiles.length === 0) {
    return undefined;
  }

  return {
    host: host.host,
    paths: hostMatch ? host.paths : paths,
    jsFiles: hostMatch ? host.jsFiles : jsFiles,
    referers: host.referers,
    isCloudAsset: host.isCloudAsset,
  };
}

function refererBadges(host: HostNode): string[] {
  return host.referers.map((r) => r.toUpperCase());
}

function domainKey(root: string): string {
  return `domain:${root}`;
}

function hostKey(host: string): string {
  return `host:${host}`;
}

function jsKey(host: string, jsPath: string): string {
  return `js:${host}:${jsPath}`;
}

function toggleDomain(root: string): void {
  const key = domainKey(root);
  const next = new Set(expandedDomains.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  expandedDomains.value = next;
}

function toggleHost(host: string): void {
  const key = hostKey(host);
  const next = new Set(expandedHosts.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  expandedHosts.value = next;
}

function toggleJs(host: string, jsPath: string): void {
  const key = jsKey(host, jsPath);
  const next = new Set(expandedJs.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  expandedJs.value = next;
}

function isDomainOpen(root: string): boolean {
  return expandedDomains.value.has(domainKey(root));
}

function isHostOpen(host: string): boolean {
  return expandedHosts.value.has(hostKey(host));
}

function isJsOpen(host: string, jsPath: string): boolean {
  return expandedJs.value.has(jsKey(host, jsPath));
}

function expandAll(): void {
  const domains = new Set<string>();
  const hosts = new Set<string>();
  const js = new Set<string>();
  for (const d of props.domains) {
    domains.add(domainKey(d.rootDomain));
    for (const h of d.hosts) {
      hosts.add(hostKey(h.host));
      for (const jf of h.jsFiles) {
        js.add(jsKey(h.host, jf.path));
      }
    }
  }
  expandedDomains.value = domains;
  expandedHosts.value = hosts;
  expandedJs.value = js;
}

function collapseAll(): void {
  expandedDomains.value = new Set();
  expandedHosts.value = new Set();
  expandedJs.value = new Set();
}

defineExpose({ expandAll, collapseAll });

function hostCount(h: HostNode): number {
  return h.paths.length + h.jsFiles.length;
}

function domainHostCount(d: DomainGroup): number {
  return d.hosts.length;
}

function domainItemCount(d: DomainGroup): number {
  return d.hosts.reduce((n, h) => n + hostCount(h), 0);
}

function sourceBadge(source: string): string {
  return { html: "HTML", js: "JS", crawl: "CRAWL" }[source] ?? "REQ";
}

function statusClass(status: number): string {
  if (status < 300) {
    return "bg-green-900/40 text-green-300";
  }
  if (status < 400) {
    return "bg-blue-900/40 text-blue-300";
  }
  if (status === 401 || status === 403) {
    return "bg-yellow-900/40 text-yellow-300";
  }
  return "bg-surface-700 text-surface-400";
}

function onDeleteHost(event: Event, host: string): void {
  event.stopPropagation();
  emit("deleteHost", host);
}

function onDeleteDomain(event: Event, root: string): void {
  event.stopPropagation();
  emit("deleteDomain", root);
}
</script>

<template>
  <div class="flex flex-col gap-2 font-mono text-sm">
    <div
      v-if="filteredDomains.length === 0"
      class="flex flex-col items-center justify-center py-16 text-surface-400 gap-3"
    >
      <i class="fas fa-spider text-3xl opacity-50" />
      <p class="text-center">
        No paths discovered yet.<br />
        <span class="text-xs"
          >Pick a scope, then browse in-scope sites through Caido or hit Crawl.</span
        >
      </p>
    </div>

    <!-- Root domain (eTLD+1) -->
    <div
      v-for="d in filteredDomains"
      :key="d.rootDomain"
      class="border border-surface-600 rounded-md bg-surface-800 overflow-hidden"
    >
      <div
        class="flex items-center gap-1 px-2 py-2 hover:bg-surface-700 transition-colors"
      >
        <button
          type="button"
          class="flex items-center gap-2 flex-1 min-w-0 text-left px-1"
          @click="toggleDomain(d.rootDomain)"
        >
          <i
            class="fas fa-chevron-right text-xs text-surface-400 transition-transform w-3 shrink-0"
            :class="{ 'rotate-90': isDomainOpen(d.rootDomain) }"
          />
          <i
            class="fas shrink-0"
            :class="d.isCloudAsset ? 'fa-cloud text-secondary-400' : 'fa-sitemap text-primary-400'"
          />
          <span class="font-semibold text-surface-0 truncate">{{ d.rootDomain }}</span>
          <span
            v-if="d.isCloudAsset"
            class="text-[10px] px-1.5 py-0.5 rounded bg-secondary-900/50 text-secondary-300 uppercase tracking-wide shrink-0"
            title="CDN / cloud storage — hosts show which site loaded them"
          >
            CDN
          </span>
          <span class="text-xs text-surface-400 tabular-nums shrink-0">
            {{ domainHostCount(d) }}
            <span class="opacity-60">hosts</span>
            · {{ domainItemCount(d) }}
            <span class="opacity-60">items</span>
          </span>
        </button>
        <Button
          icon="fas fa-trash"
          severity="danger"
          size="small"
          text
          rounded
          title="Delete all hosts under this domain"
          @click="onDeleteDomain($event, d.rootDomain)"
        />
      </div>

      <!-- Hosts under root domain -->
      <div v-if="isDomainOpen(d.rootDomain)" class="border-t border-surface-700">
        <div
          v-for="h in d.hosts"
          :key="h.host"
          class="border-b border-surface-700/60 last:border-b-0"
        >
          <div
            class="flex items-center gap-1 pl-6 pr-2 py-1.5 hover:bg-surface-700/70 transition-colors"
          >
            <button
              type="button"
              class="flex items-center gap-2 flex-1 min-w-0 text-left px-1"
              @click="toggleHost(h.host)"
            >
              <i
                class="fas fa-chevron-right text-xs text-surface-400 transition-transform w-3 shrink-0"
                :class="{ 'rotate-90': isHostOpen(h.host) }"
              />
              <i
                class="fas text-xs shrink-0"
                :class="h.isCloudAsset ? 'fa-cloud text-secondary-400' : 'fa-globe text-primary-300'"
              />
              <span class="text-surface-100 truncate" :title="h.host">{{ h.host }}</span>
              <span
                v-for="ref in refererBadges(h)"
                :key="`ref:${h.host}:${ref}`"
                class="text-[10px] px-1.5 py-0.5 rounded bg-primary-900/50 text-primary-200 font-semibold tracking-wide shrink-0"
                :title="`Loaded by ${ref} (from Referer/Origin)`"
              >
                [{{ ref }}]
              </span>
              <span class="flex-1" />
              <span class="text-xs text-surface-400 tabular-nums shrink-0">
                {{ hostCount(h) }}
                <span class="opacity-60">items</span>
              </span>
            </button>
            <Button
              icon="fas fa-trash"
              severity="danger"
              size="small"
              text
              rounded
              title="Delete this host"
              @click="onDeleteHost($event, h.host)"
            />
          </div>

          <!-- Paths + JS under host -->
          <div v-if="isHostOpen(h.host)" class="bg-surface-900/30">
            <div
              v-for="p in h.paths"
              :key="`p:${h.host}:${p.path}`"
              class="flex items-center gap-2 px-3 py-1.5 pl-14 hover:bg-surface-700/50 border-t border-surface-700/40"
            >
              <i class="fas fa-link text-xs text-surface-500 w-3" />
              <span class="text-surface-200 truncate flex-1" :title="p.path">{{ p.path }}</span>
              <span
                v-if="p.status !== undefined"
                class="text-[10px] px-1.5 py-0.5 rounded tabular-nums"
                :class="statusClass(p.status)"
              >
                {{ p.status }}
              </span>
              <span
                class="text-[10px] px-1.5 py-0.5 rounded bg-surface-700 text-surface-300 uppercase tracking-wide"
              >
                {{ p.method }}
              </span>
              <span
                class="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide"
                :class="
                  p.source === 'request'
                    ? 'bg-primary-900/40 text-primary-300'
                    : 'bg-secondary-900/40 text-secondary-300'
                "
              >
                {{ sourceBadge(p.source) }}
              </span>
            </div>

            <div
              v-for="jf in h.jsFiles"
              :key="`js:${h.host}:${jf.path}`"
              class="border-t border-surface-700/40"
            >
              <button
                type="button"
                class="w-full flex items-center gap-2 px-3 py-1.5 pl-14 hover:bg-surface-700/50 text-left transition-colors"
                @click="toggleJs(h.host, jf.path)"
              >
                <i
                  class="fas fa-chevron-right text-xs text-surface-400 transition-transform w-3"
                  :class="{ 'rotate-90': isJsOpen(h.host, jf.path) }"
                />
                <i class="fas fa-file-code text-secondary-400 text-xs" />
                <span class="text-secondary-200 truncate flex-1" :title="jf.path">{{
                  jf.path
                }}</span>
                <span
                  v-if="!jf.fetched"
                  class="text-[10px] px-1.5 py-0.5 rounded bg-surface-700 text-surface-400 uppercase"
                >
                  fetching…
                </span>
                <span class="text-xs text-surface-400 tabular-nums">
                  {{ jf.paths.length }}
                  <span class="opacity-60">paths</span>
                </span>
              </button>

              <div v-if="isJsOpen(h.host, jf.path)" class="bg-surface-950/40">
                <div
                  v-if="jf.paths.length === 0"
                  class="px-3 py-2 pl-20 text-xs text-surface-500 italic"
                >
                  {{
                    jf.fetched
                      ? "No paths found in this file."
                      : "Fetching JS and extracting paths…"
                  }}
                </div>
                <div
                  v-for="jp in jf.paths"
                  :key="`jp:${h.host}:${jf.path}:${jp.path}`"
                  class="flex items-center gap-2 px-3 py-1.5 pl-20 hover:bg-surface-700/30 border-t border-surface-700/30"
                >
                  <i class="fas fa-code text-[10px] text-surface-500 w-3" />
                  <span class="text-surface-300 truncate flex-1" :title="jp.path">{{
                    jp.path
                  }}</span>
                  <span
                    class="text-[10px] px-1.5 py-0.5 rounded bg-surface-700 text-surface-400 uppercase tracking-wide"
                  >
                    JS
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
