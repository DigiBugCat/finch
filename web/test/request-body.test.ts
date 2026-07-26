import { describe, expect, it } from "vitest";

import { HttpError } from "@/lib/hub";
import { readJsonObject } from "@/lib/request-body";

function request(body?: BodyInit, headers?: HeadersInit): Request {
  const req = new Request("https://app.example.com/api/finch/test", {
    method: "POST",
    body,
    headers,
  });
  // happy-dom intentionally drops the forbidden browser Content-Length header,
  // while a deployed route receives it from the HTTP runtime. Restore it on
  // the test Request so the server-side preflight branch is exercised.
  if (headers && new Headers(headers).has("content-length") && !req.headers.has("content-length")) {
    Object.defineProperty(req, "headers", { value: new Headers(headers) });
  }
  return req;
}

async function expectHttpError(promise: Promise<unknown>, status: number) {
  await expect(promise).rejects.toBeInstanceOf(HttpError);
  await expect(promise).rejects.toMatchObject({ status });
}

describe("readJsonObject", () => {
  it("accepts an object exactly at the configured byte boundary", async () => {
    const body = '{"a":"1234"}';
    await expect(readJsonObject(request(body), body.length)).resolves.toEqual({ a: "1234" });
  });

  it("rejects an oversized stream even without Content-Length", async () => {
    const req = request('{"a":"12345"}');
    expect(req.headers.has("content-length")).toBe(false);
    await expectHttpError(readJsonObject(req, 12), 413);
  });

  it("rejects an advertised oversize before consuming the body", async () => {
    await expectHttpError(
      readJsonObject(request("{}", { "content-length": "999" }), 32),
      413,
    );
  });

  it.each(["null", "[]", '"text"', "1", "true"])(
    "rejects the valid JSON primitive %s as a request shape error",
    async (body) => {
      await expectHttpError(readJsonObject(request(body)), 400);
    },
  );

  it("rejects empty, malformed, and invalid UTF-8 bodies", async () => {
    await expectHttpError(readJsonObject(request()), 400);
    await expectHttpError(readJsonObject(request("{")), 400);
    await expectHttpError(readJsonObject(request(new Uint8Array([0xc3, 0x28]))), 400);
  });

  it("rejects a malformed Content-Length instead of trusting it", async () => {
    await expectHttpError(
      readJsonObject(request("{}", { "content-length": "-1" })),
      400,
    );
  });
});
