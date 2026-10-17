import assert from "node:assert/strict";
import test from "node:test";

const scriptUrl = new URL("../docs/architecture/pr-watcher/site/site.js", import.meta.url);

type SiteApi = {
  resolveLayout(hash: string): string;
  mountSwitcher(document: FakeDocument, window: FakeWindow): void;
};

type FakeElement = {
  textContent: string;
  attributes: Map<string, string>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

type FakeDocument = {
  title: string;
  querySelector(selector: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
};

type FakeWindow = {
  location: { hash: string };
  addEventListener(type: string, listener: () => void): void;
};

function element(attributes: Record<string, string> = {}): FakeElement {
  const values = new Map(Object.entries(attributes));
  return {
    textContent: "",
    attributes: values,
    getAttribute: (name) => values.get(name) ?? null,
    setAttribute: (name, value) => values.set(name, value),
    removeAttribute: (name) => values.delete(name),
  };
}

let moduleLoadSequence = 0;

async function loadSiteApi(): Promise<SiteApi> {
  Reflect.deleteProperty(globalThis, "PRWatcherArchitectureSite");
  // Cache-busting intentionally exercises repeat browser-script initialization in one test process.
  await import(`${scriptUrl.href}?test=${moduleLoadSequence++}`);
  return Reflect.get(globalThis, "PRWatcherArchitectureSite") as SiteApi;
}

test("layout resolution rejects unknown hashes and defaults to the guided desk", async () => {
  const site = await loadSiteApi();

  assert.equal(site.resolveLayout("#narrative-dossier"), "narrative-dossier.html");
  assert.equal(site.resolveLayout("guided-signal-desk"), "guided-signal-desk.html");
  assert.equal(site.resolveLayout("#layered-system-lens"), "layered-system-lens.html");
  assert.equal(site.resolveLayout(""), "guided-signal-desk.html");
  assert.equal(site.resolveLayout("#not-a-layout"), "guided-signal-desk.html");
});

test("the switcher follows hash navigation and exposes the active layout", async () => {
  const site = await loadSiteApi();
  const frame = element({ "data-layout-frame": "" });
  const current = element({ "data-current-layout": "" });
  const links = [
    element({ href: "#narrative-dossier", "data-layout-link": "" }),
    element({ href: "#guided-signal-desk", "data-layout-link": "" }),
    element({ href: "#layered-system-lens", "data-layout-link": "" }),
  ];
  const document: FakeDocument = {
    title: "Open Relay",
    querySelector(selector) {
      if (selector === "[data-layout-frame]") return frame;
      if (selector === "[data-current-layout]") return current;
      return null;
    },
    querySelectorAll: (selector) => (selector === "[data-layout-link]" ? links : []),
  };
  let onHashChange = () => {};
  const window: FakeWindow = {
    location: { hash: "#narrative-dossier" },
    addEventListener(type, listener) {
      if (type === "hashchange") onHashChange = listener;
    },
  };

  site.mountSwitcher(document, window);
  assert.equal(frame.getAttribute("src"), "narrative-dossier.html");
  assert.equal(current.textContent, "Narrative Dossier");
  assert.equal(links[0].getAttribute("aria-current"), "page");
  assert.equal(links[1].getAttribute("aria-current"), null);
  assert.equal(document.title, "Narrative Dossier — Open Relay PR Watcher");

  window.location.hash = "#layered-system-lens";
  onHashChange();
  assert.equal(frame.getAttribute("src"), "layered-system-lens.html");
  assert.equal(current.textContent, "Layered System Lens");
  assert.equal(links[0].getAttribute("aria-current"), null);
  assert.equal(links[2].getAttribute("aria-current"), "page");
});
