import { Classic } from "@caido/primevue";
import PrimeVue from "primevue/config";
import { createApp } from "vue";

import { SDKPlugin } from "./plugins/sdk";
import "./styles/index.css";
import type { FrontendSDK } from "./types";
import App from "./views/App.vue";

export const init = (sdk: FrontendSDK) => {
  const app = createApp(App);

  app.use(PrimeVue, {
    unstyled: true,
    pt: Classic,
  });

  app.use(SDKPlugin, sdk);

  const root = document.createElement("div");
  Object.assign(root.style, {
    height: "100%",
    width: "100%",
  });

  // Must match prefixwrap id in caido.config.ts
  root.id = "plugin--path-crawler";

  app.mount(root);

  sdk.navigation.addPage("/path-crawler", {
    body: root,
  });

  sdk.sidebar.registerItem("Path Crawler", "/path-crawler", {
    icon: "fas fa-spider",
  });
};
