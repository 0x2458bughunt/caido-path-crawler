import type { Caido } from "@caido/sdk-frontend";
import type { API, BackendEvents } from "backend";

export type FrontendSDK = Caido<API, BackendEvents>;

export type {
  CrawlStatus,
  CrawlTree,
  CrawlUpdate,
  DomainGroup,
  HostNode,
  JsFileEntry,
  JsPathEntry,
  PathEntry,
  Result,
  ScopeOption,
  Settings,
} from "backend";
