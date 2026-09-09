import { createServer, type Server } from "node:http";

export interface FakeGitHubRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface FakeGitHubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayUntilAbort?: boolean;
}

export type FakeGitHubScript = FakeGitHubResponse | ((request: FakeGitHubRequest, count: number) => FakeGitHubResponse | Promise<FakeGitHubResponse>);

export interface FakeGitHubServer {
  url: string;
  requests: FakeGitHubRequest[];
  count(path: string): number;
  close(): Promise<void>;
}

export async function fakeGitHubServer(scripts: Record<string, FakeGitHubScript | FakeGitHubScript[]>): Promise<FakeGitHubServer> {
  const requests: FakeGitHubRequest[] = [];
  const counts = new Map<string, number>();
  const server: Server = createServer(async (request, response) => {
    const item: FakeGitHubRequest = {
      method: request.method ?? "GET",
      url: request.url ?? "/",
      headers: { ...request.headers },
    };
    requests.push(item);
    const key = `${item.method} ${item.url}`;
    const count = counts.get(key) ?? 0;
    counts.set(key, count + 1);
    const script = scripts[item.url] ?? scripts[key] ?? { status: 404, body: { message: "not found" } };
    const selected = Array.isArray(script) ? script[Math.min(count, script.length - 1)] : script;
    const result = typeof selected === "function" ? await selected(item, count) : selected;
    if (result.delayUntilAbort) {
      await new Promise<void>((resolve) => {
        const finish = () => { request.off("aborted", finish); response.off("close", finish); resolve(); };
        request.once("aborted", finish);
        response.once("close", finish);
      });
      return;
    }
    response.writeHead(result.status ?? 200, result.headers ?? { "content-type": "application/json" });
    if (result.body !== undefined) response.end(JSON.stringify(result.body));
    else response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    count: (path) => requests.filter((request) => request.url === path).length,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

export function json(body: unknown, headers: Record<string, string> = {}): FakeGitHubResponse {
  return { body, headers: { "content-type": "application/json", ...headers } };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
