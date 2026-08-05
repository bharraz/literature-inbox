import { describe, expect, it } from "vitest";
import {
  FetchError,
  NotFoundError,
  RateLimiter,
  buildUrl,
  getWithRetry,
  type Transport,
  type TransportResponse,
} from "../src/core/http";

/** Replays scripted responses in order and records every URL requested. */
class ScriptedTransport implements Transport {
  readonly requested: string[] = [];
  constructor(private readonly responses: (TransportResponse | Error)[]) {}

  async get(url: string): Promise<TransportResponse> {
    this.requested.push(url);
    const next = this.responses.shift();
    if (!next) throw new Error("ScriptedTransport ran out of responses");
    if (next instanceof Error) throw next;
    return next;
  }
}

const noSleep = async () => {};

describe("getWithRetry", () => {
  it("returns the body on success", async () => {
    const transport = new ScriptedTransport([{ status: 200, text: "hello" }]);
    await expect(getWithRetry(transport, "https://x/y", { sleep: noSleep })).resolves.toBe("hello");
  });

  it("retries a 429 and succeeds", async () => {
    const transport = new ScriptedTransport([
      { status: 429, text: "slow down" },
      { status: 200, text: "ok" },
    ]);
    await expect(getWithRetry(transport, "https://x/y", { sleep: noSleep })).resolves.toBe("ok");
    expect(transport.requested).toHaveLength(2);
  });

  it("retries a 500 and succeeds", async () => {
    const transport = new ScriptedTransport([
      { status: 503, text: "" },
      { status: 200, text: "ok" },
    ]);
    await expect(getWithRetry(transport, "https://x/y", { sleep: noSleep })).resolves.toBe("ok");
  });

  it("gives up after maxRetries and throws", async () => {
    const transport = new ScriptedTransport([
      { status: 500, text: "" },
      { status: 500, text: "" },
    ]);
    await expect(
      getWithRetry(transport, "https://x/y", { maxRetries: 1, sleep: noSleep }),
    ).rejects.toBeInstanceOf(FetchError);
    expect(transport.requested).toHaveLength(2); // initial + 1 retry
  });

  it("throws NotFoundError on 404 without retrying", async () => {
    const transport = new ScriptedTransport([{ status: 404, text: "" }]);
    await expect(
      getWithRetry(transport, "https://x/y", { sleep: noSleep }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(transport.requested).toHaveLength(1); // a 404 won't become found
  });

  it("does not retry a 400", async () => {
    const transport = new ScriptedTransport([{ status: 400, text: "" }]);
    await expect(getWithRetry(transport, "https://x/y", { sleep: noSleep })).rejects.toBeInstanceOf(
      FetchError,
    );
    expect(transport.requested).toHaveLength(1);
  });

  it("retries a thrown transport error (offline, DNS failure)", async () => {
    const transport = new ScriptedTransport([
      new Error("ENOTFOUND"),
      { status: 200, text: "recovered" },
    ]);
    await expect(getWithRetry(transport, "https://x/y", { sleep: noSleep })).resolves.toBe(
      "recovered",
    );
  });

  it("backs off exponentially", async () => {
    const delays: number[] = [];
    const transport = new ScriptedTransport([
      { status: 500, text: "" },
      { status: 500, text: "" },
      { status: 200, text: "ok" },
    ]);
    await getWithRetry(transport, "https://x/y", {
      backoffSeconds: 1,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(delays).toEqual([1000, 2000]);
  });
});

describe("RateLimiter", () => {
  it("does not wait before the first request", async () => {
    const delays: number[] = [];
    const limiter = new RateLimiter(100, async (ms) => { delays.push(ms); }, () => 0);
    await limiter.wait();
    expect(delays).toEqual([]);
  });

  it("waits out the remaining interval between requests", async () => {
    const delays: number[] = [];
    let now = 1000;
    const limiter = new RateLimiter(100, async (ms) => { delays.push(ms); }, () => now);
    await limiter.wait();
    now = 1030; // only 30ms elapsed
    await limiter.wait();
    expect(delays).toEqual([70]);
  });

  it("does not wait when the interval has already passed", async () => {
    const delays: number[] = [];
    let now = 1000;
    const limiter = new RateLimiter(100, async (ms) => { delays.push(ms); }, () => now);
    await limiter.wait();
    now = 5000;
    await limiter.wait();
    expect(delays).toEqual([]);
  });
});

describe("buildUrl", () => {
  it("appends params and percent-encodes them", () => {
    expect(buildUrl("https://api.test/works", { filter: "a|b", cursor: "*" })).toBe(
      "https://api.test/works?filter=a%7Cb&cursor=*",
    );
  });

  it("omits undefined and empty values", () => {
    expect(buildUrl("https://api.test/works", { a: "1", b: undefined, c: "" })).toBe(
      "https://api.test/works?a=1",
    );
  });

  it("returns the bare base when there are no params", () => {
    expect(buildUrl("https://api.test/works", {})).toBe("https://api.test/works");
  });
});
