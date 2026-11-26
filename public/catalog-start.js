// Runs from the document head while the application bundle is downloading.
(() => {
  if (window.luchokCatalogStarted || window.luchokCatalogRequest ||
      (location.hash && location.hash !== "#/catalog") ||
      new URLSearchParams(location.search).has("tgWebAppStartParam")) return;

  let path = "/catalog?limit=16&sort=new";
  try {
    const saved = localStorage.getItem("catalogFilters");
    if (saved && saved !== "null" && saved !== '{"sort":"new"}') {
      const startup = JSON.parse(localStorage.getItem("catalogStartup") || "null");
      if (startup?.filters !== saved || typeof startup.path !== "string" ||
          !startup.path.startsWith("/catalog?")) return;
      path = startup.path;
    }
  } catch {
    return;
  }
  const controller = new AbortController();
  const response = fetch("/api" + path, { credentials: "same-origin", signal: controller.signal });
  // React may attach after the request has already failed.
  response.catch(() => {});
  window.luchokCatalogRequest = { path, response, controller };
})();
