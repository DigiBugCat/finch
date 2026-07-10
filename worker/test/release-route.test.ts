import { describe, expect, it } from "vitest";
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";

const BASE = "http://hub.test";

type FakeRelease = {
  body: ReadableStream;
  size: number;
  httpEtag: string;
};

function releaseBucket(
  assets: Record<string, string>,
  reads: string[],
): Pick<R2Bucket, "get"> {
  return {
    async get(key: string): Promise<FakeRelease | null> {
      reads.push(key);
      const content = assets[key];
      if (content === undefined) return null;
      return {
        body: new Response(content).body!,
        size: new TextEncoder().encode(content).byteLength,
        httpEtag: '"test-etag"',
      };
    },
  } as Pick<R2Bucket, "get">;
}

async function get(path: string, releases: Pick<R2Bucket, "get">): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${BASE}${path}`, { headers: { host: "hub.test" } }),
    { ...(env as any), RELEASES: releases } as any,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("public release assets", () => {
  it("serves the exact checksums.txt content from the release bucket", async () => {
    const reads: string[] = [];
    const content =
      "0123456789abcdef  finch-linux-amd64\n" +
      "fedcba9876543210  finch-darwin-arm64\n";
    const response = await get(
      "/releases/checksums.txt",
      releaseBucket({ "checksums.txt": content }, reads),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toBe(content);
    expect(reads).toEqual(["checksums.txt"]);
  });

  it("does not turn traversal-shaped paths into release bucket reads", async () => {
    for (const path of [
      "/releases/..%2Fchecksums.txt",
      "/releases/%2e%2e%2fchecksums.txt",
      "/releases/checksums.txt%2f..%2fprivate-key",
    ]) {
      const reads: string[] = [];
      const response = await get(path, releaseBucket({}, reads));
      expect(response.status).not.toBe(200);
      expect(reads).toEqual([]);
    }
  });

  it("keeps serving allow-listed platform binaries as octet streams", async () => {
    const reads: string[] = [];
    const response = await get(
      "/releases/finch-linux-amd64",
      releaseBucket({ "finch-linux-amd64": "binary-bytes" }, reads),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
      "binary-bytes",
    );
    expect(reads).toEqual(["finch-linux-amd64"]);
  });
});
