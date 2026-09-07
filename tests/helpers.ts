import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));

export async function fixtureProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-relay-fixture-"));
  await cp(join(fixtureRoot, "fixtures", "events"), join(root, "events"), { recursive: true });
  await cp(join(fixtureRoot, "fixtures", "schemas"), join(root, "schemas"), { recursive: true });
  await cp(join(fixtureRoot, "fixtures", "handlers"), join(root, "handlers"), { recursive: true });
  return root;
}
