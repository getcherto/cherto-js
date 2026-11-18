import { describe, expect, it, vi } from "vitest";
import { callGuarded, consoleLogger, createWarnOnce, guardLogger, loggerFrom } from "./logger.js";

describe("callGuarded", () => {
  it("routes a throw to onFailure", () => {
    const onFailure = vi.fn();
    callGuarded(() => {
      throw new Error("sync");
    }, onFailure);
    expect(onFailure).toHaveBeenCalledWith(new Error("sync"));
  });

  it("routes a returned rejection to onFailure", async () => {
    const onFailure = vi.fn();
    callGuarded(() => Promise.reject(new Error("async")), onFailure);
    await Promise.resolve();
    expect(onFailure).toHaveBeenCalledWith(new Error("async"));
  });
});

describe("guardLogger", () => {
  it("forwards each call, and swallows a throw or rejection from the logger", async () => {
    const warn = vi.fn(() => {
      throw new Error("warn");
    });
    const error = vi.fn(() => Promise.reject(new Error("error")));
    const logger = guardLogger({ warn, error });

    expect(() => logger.warn("w")).not.toThrow();
    expect(() => logger.error("e", { key: "k" })).not.toThrow();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledExactlyOnceWith("w");
    expect(error).toHaveBeenCalledExactlyOnceWith("e", { key: "k" });
  });
});

describe("createWarnOnce", () => {
  it("logs each experiment's warning once", () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const warn = createWarnOnce(logger);

    warn({ experimentKey: "checkout-copy" }, "skipped");
    warn({ experimentKey: "checkout-copy" }, "skipped");
    warn({ experimentKey: "pricing-page" }, "skipped");

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith("[cherto] skipped", {
      experimentKey: "checkout-copy",
    });
  });
});

describe("loggerFrom", () => {
  it("guards a logger with both methods, without reporting it", () => {
    const onInvalid = vi.fn();
    const warn = vi.fn(() => {
      throw new Error("boom");
    });
    const logger = loggerFrom({ warn, error: () => {} }, onInvalid);

    expect(() => logger.warn("hello", { a: 1 })).not.toThrow();
    expect(warn).toHaveBeenCalledExactlyOnceWith("hello", { a: 1 });
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it("falls back to console for a function, pointing at custom enrollment tracking", () => {
    const onInvalid = vi.fn();
    expect(loggerFrom(() => {}, onInvalid)).toBe(consoleLogger);
    expect(onInvalid).toHaveBeenCalledWith(expect.stringContaining('mode: "custom"'));
  });

  it("falls back to console for an object without both methods", () => {
    const onInvalid = vi.fn();
    expect(loggerFrom({ warn: () => {} }, onInvalid)).toBe(consoleLogger);
    expect(onInvalid).toHaveBeenCalledWith("logger must have warn and error methods");
  });
});
