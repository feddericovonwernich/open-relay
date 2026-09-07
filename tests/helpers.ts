import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, type DefinitionRevision } from "../src/registry.ts";
import { openStore, type AcceptInput, type Store } from "../src/store.ts";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));

export async function fixtureProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-relay-fixture-"));
  await cp(join(fixtureRoot, "fixtures", "events"), join(root, "events"), { recursive: true });
  await cp(join(fixtureRoot, "fixtures", "schemas"), join(root, "schemas"), { recursive: true });
  await cp(join(fixtureRoot, "fixtures", "handlers"), join(root, "handlers"), { recursive: true });
  return root;
}


export function testStore(): { store: Store; revision: DefinitionRevision } {
  const revision = loadRegistry(join(fixtureRoot, "fixtures"), "events").resolve("ui.variant.requested", 1);
  const store = openStore(":memory:", { now: () => 1_700_000_000_000 });
  store.installRevisions([revision]);
  return { store, revision };
}

export function acceptInput(overrides: Partial<Omit<AcceptInput, "revision">> = {}): Omit<AcceptInput, "revision"> {
  return {
    producerId: "browser:test",
    idempotencyKey: "test:1",
    payload: { variant: "dark" },
    ...overrides,
  };
}

export function errorWithCode(code: string): { code: string } {
  return { code };
}
