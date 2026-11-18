import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChertoError,
  asHttpError,
  asTransportError,
  codeForStatus,
  httpError,
  isChertoError,
  parseRetryAfter,
} from "./errors.js";

describe("ChertoError", () => {
  it("is an Error carrying its code and name", () => {
    const err = new ChertoError("bad_config", "nope");

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ChertoError");
    expect(err.code).toBe("bad_config");
    expect(err.message).toBe("nope");
  });

  it("is recognized by isChertoError", () => {
    expect(isChertoError(new ChertoError("network", "x"))).toBe(true);
    expect(isChertoError(new Error("x"))).toBe(false);
  });

  it("keeps the cause it was given", () => {
    const cause = new Error("root");
    expect(new ChertoError("network", "x", { cause }).cause).toBe(cause);
  });

  it.each([
    ["network", true],
    ["timeout", true],
    ["rate_limited", true],
    ["bad_response", true],
    ["unauthorized", false],
    ["bad_request", false],
    ["bad_config", false],
    ["origin_not_allowed", false],
    ["callback_failed", false],
  ] as const)("%s is retryable: %s", (code, retryable) => {
    expect(new ChertoError(code, "x").retryable).toBe(retryable);
  });
});

describe("codeForStatus", () => {
  it.each([
    [400, undefined, "bad_request"],
    [401, undefined, "unauthorized"],
    [403, undefined, "unauthorized"],
    [403, "ORIGIN_NOT_ALLOWED", "origin_not_allowed"],
    [401, "ORIGIN_NOT_ALLOWED", "unauthorized"],
    [408, undefined, "timeout"],
    [413, undefined, "bad_request"],
    [422, undefined, "bad_request"],
    [425, undefined, "bad_response"],
    [429, undefined, "rate_limited"],
    [500, undefined, "bad_response"],
    [503, undefined, "bad_response"],
  ] as const)("maps %s (%s) to %s", (status, apiError, code) => {
    expect(codeForStatus(status, apiError)).toBe(code);
  });
});

describe("parseRetryAfter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the delta-seconds form into milliseconds, rounding a fraction", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("1.5")).toBe(1500);
  });

  it("reads the HTTP-date form as a delay from now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T07:28:00Z"));

    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:30 GMT")).toBe(30_000);
  });

  it("clamps a past date to 0", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T07:28:00Z"));

    expect(parseRetryAfter("Wed, 21 Oct 2026 07:27:00 GMT")).toBe(0);
  });

  it.each([null, "", "   ", "soon", "-5"])("returns null for %o", (header) => {
    expect(parseRetryAfter(header)).toBeNull();
  });
});

describe("httpError", () => {
  it("takes its code and message from an API error body", () => {
    const err = httpError(
      {
        status: 403,
        retryAfter: null,
        body: JSON.stringify({ error: "ORIGIN_NOT_ALLOWED", message: "Origin not allowed" }),
      },
      "assignment request",
    );
    expect(err.code).toBe("origin_not_allowed");
    expect(err.status).toBe(403);
    expect(err.message).toBe("[cherto] assignment request failed: HTTP 403: Origin not allowed");
  });

  it("names the origin the API refused, and where to allow it", () => {
    const err = httpError(
      {
        status: 403,
        retryAfter: null,
        body: JSON.stringify({
          error: "ORIGIN_NOT_ALLOWED",
          message: "Origin not allowed",
          details: { origin: "https://app.example.com" },
        }),
      },
      "assignment request",
    );
    expect(err.code).toBe("origin_not_allowed");
    expect(err.message).toBe(
      "[cherto] origin https://app.example.com isn't allowed for this client key; add it " +
        "under Settings → SDK & keys → Allowed origins",
    );
  });

  it("quotes any other body, cut to 200 characters, and parses Retry-After", () => {
    const err = httpError(
      { status: 503, retryAfter: "2", body: `<html>${"x".repeat(300)}</html>` },
      "config fetch",
    );
    expect(err.code).toBe("bad_response");
    expect(err.retryAfterMs).toBe(2000);
    expect(err.message).toBe(`[cherto] config fetch failed: HTTP 503: <html>${"x".repeat(194)}`);
  });
});

describe("asHttpError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps the status onto a code and quotes the body in the message", async () => {
    const res = new Response('{"error":"UNAUTHORIZED"}', { status: 401 });

    const err = await asHttpError(res, "config fetch");

    expect(err.code).toBe("unauthorized");
    expect(err.status).toBe(401);
    expect(err.message).toBe('[cherto] config fetch failed: HTTP 401: {"error":"UNAUTHORIZED"}');
  });

  it.each([
    [429, "rate_limited"],
    [503, "bad_response"],
  ] as const)("reads Retry-After from an HTTP %i", async (status, code) => {
    const res = new Response("later", { status, headers: { "retry-after": "30" } });

    const err = await asHttpError(res, "config fetch");

    expect(err.code).toBe(code);
    expect(err.retryAfterMs).toBe(30_000);
  });
});

describe("asTransportError", () => {
  it.each(["TimeoutError", "AbortError"])("maps a %s to `timeout`", (name) => {
    const err = new Error("aborted");
    err.name = name;

    const wrapped = asTransportError(err, "config fetch");

    expect(wrapped.code).toBe("timeout");
    expect(wrapped.message).toContain("config fetch");
    expect(wrapped.cause).toBe(err);
  });

  it("maps anything else to `network`, keeping the original message and cause", () => {
    const err = new TypeError("fetch failed");

    const wrapped = asTransportError(err, "enrollment event delivery");

    expect(wrapped.code).toBe("network");
    expect(wrapped.message).toContain("enrollment event delivery");
    expect(wrapped.message).toContain("fetch failed");
    expect(wrapped.cause).toBe(err);
  });

  it("passes an existing ChertoError through untouched", () => {
    const original = new ChertoError("unauthorized", "already typed", { status: 401 });

    expect(asTransportError(original, "config fetch")).toBe(original);
  });
});
