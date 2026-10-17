(function attachPrWatcherSite(root) {
  "use strict";

  const layouts = Object.freeze({
    "narrative-dossier": Object.freeze({ file: "narrative-dossier.html", label: "Narrative Dossier" }),
    "guided-signal-desk": Object.freeze({ file: "guided-signal-desk.html", label: "Guided Signal Desk" }),
    "layered-system-lens": Object.freeze({ file: "layered-system-lens.html", label: "Layered System Lens" }),
  });
  const fallback = "guided-signal-desk";

  function resolveKey(hash) {
    const candidate = String(hash ?? "").replace(/^#/, "");
    return Object.hasOwn(layouts, candidate) ? candidate : fallback;
  }

  function resolveLayout(hash) {
    return layouts[resolveKey(hash)].file;
  }

  function mountSwitcher(documentObject, windowObject) {
    const frame = documentObject.querySelector("[data-layout-frame]");
    const current = documentObject.querySelector("[data-current-layout]");
    const links = Array.from(documentObject.querySelectorAll("[data-layout-link]"));
    if (!frame) return;

    function render() {
      const key = resolveKey(windowObject.location.hash);
      const layout = layouts[key];
      frame.setAttribute("src", layout.file);
      frame.setAttribute("title", `${layout.label} architecture layout`);
      if (current) current.textContent = layout.label;
      documentObject.title = `${layout.label} — Open Relay PR Watcher`;
      for (const link of links) {
        if (link.getAttribute("href") === `#${key}`) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
    }

    render();
    windowObject.addEventListener("hashchange", render);
  }

  const api = Object.freeze({ mountSwitcher, resolveLayout });
  root.PRWatcherArchitectureSite = api;

  if (typeof document !== "undefined" && typeof window !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => mountSwitcher(document, window), { once: true });
    } else {
      mountSwitcher(document, window);
    }
  }
})(globalThis);
