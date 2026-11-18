import type { ReactNode } from "react";
import { describe, it, expect } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import type { ChertoClient } from "@cherto/browser";
import { ChertoProvider } from "./provider.js";
import {
  useChertoVariant,
  useChertoVariantValue,
  useChertoVariantParam,
  useChertoAssignment,
} from "./hooks.js";
import { checkoutBootstrap, makeClient } from "./test-helpers.js";

function withProvider(client: ChertoClient, children: ReactNode) {
  return <ChertoProvider client={client}>{children}</ChertoProvider>;
}

const flushMicrotasks = () => act(async () => {});

describe("useChertoVariant", () => {
  it("returns the default before any assignment is loaded", () => {
    const { client } = makeClient();
    let value: string | undefined;
    function Probe() {
      value = useChertoVariant("checkout-copy", "control");
      return null;
    }
    render(withProvider(client, <Probe />));
    expect(value).toBe("control");
  });

  it("returns the assigned variant and enrolls after mount", async () => {
    const { client, events } = makeClient({ bootstrap: checkoutBootstrap() });
    let value: string | undefined;
    function Probe() {
      value = useChertoVariant("checkout-copy", "control");
      return null;
    }
    render(withProvider(client, <Probe />));
    expect(value).toBe("treatment");
    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      experimentKey: "checkout-copy",
      variantKey: "treatment",
      unitId: "u1",
    });
  });

  it("doesn't enroll with { track: false }", async () => {
    const { client, events } = makeClient({ bootstrap: checkoutBootstrap() });
    function Probe() {
      useChertoVariant("checkout-copy", "control", { track: false });
      return null;
    }
    render(withProvider(client, <Probe />));
    await flushMicrotasks();
    expect(events).toEqual([]);
  });

  it("re-renders and enrolls once assignments load", async () => {
    const { client, events } = makeClient();
    function Probe() {
      return <span data-testid="variant">{useChertoVariant("checkout-copy", "control")}</span>;
    }
    render(
      <ChertoProvider client={client} context={{ units: { user: "u1" } }}>
        <Probe />
      </ChertoProvider>,
    );
    expect(screen.getByTestId("variant").textContent).toBe("control");

    await waitFor(() => expect(screen.getByTestId("variant").textContent).toBe("treatment"));
    await waitFor(() => expect(events).toHaveLength(1));
  });

  it("doesn't enroll during a server render", async () => {
    const { client, events } = makeClient({ bootstrap: checkoutBootstrap() });
    function Probe() {
      return <span>{useChertoVariant("checkout-copy", "control")}</span>;
    }
    const html = renderToString(withProvider(client, <Probe />));
    expect(html).toContain("treatment");
    await flushMicrotasks();
    expect(events).toEqual([]);
  });
});

describe("useChertoVariantValue", () => {
  it("returns the variant's custom value", () => {
    const { client } = makeClient({ bootstrap: checkoutBootstrap() });
    let value: Record<string, unknown> | undefined;
    function Probe() {
      value = useChertoVariantValue("checkout-copy", {});
      return null;
    }
    render(withProvider(client, <Probe />));
    expect(value).toEqual({ headline: "Save big", discount: 10 });
  });

  it("returns the default when there is no assignment", () => {
    const { client } = makeClient({ bootstrap: checkoutBootstrap() });
    let value: Record<string, unknown> | undefined;
    function Probe() {
      value = useChertoVariantValue("unknown-experiment", { fallback: true });
      return null;
    }
    render(withProvider(client, <Probe />));
    expect(value).toEqual({ fallback: true });
  });

  it("returns the default when its type doesn't match the value's", () => {
    const { client } = makeClient({ bootstrap: checkoutBootstrap() });
    let value: string | undefined;
    function Probe() {
      value = useChertoVariantValue("checkout-copy", "plain");
      return null;
    }
    render(withProvider(client, <Probe />));
    expect(value).toBe("plain");
  });

  it("enrolls after mount", async () => {
    const { client, events } = makeClient({ bootstrap: checkoutBootstrap() });
    function Probe() {
      useChertoVariantValue("checkout-copy", {});
      return null;
    }
    render(withProvider(client, <Probe />));
    await waitFor(() => expect(events).toHaveLength(1));
  });
});

describe("useChertoVariantParam", () => {
  it("returns one param of the custom value", () => {
    const { client } = makeClient({ bootstrap: checkoutBootstrap() });
    let headline: string | undefined;
    function Probe() {
      headline = useChertoVariantParam("checkout-copy", "headline", "default headline");
      return null;
    }
    render(withProvider(client, <Probe />));
    expect(headline).toBe("Save big");
  });

  it("returns the default when the param is absent", () => {
    const { client } = makeClient({ bootstrap: checkoutBootstrap() });
    let missing: number | undefined;
    function Probe() {
      missing = useChertoVariantParam("checkout-copy", "missing-key", -1);
      return null;
    }
    render(withProvider(client, <Probe />));
    expect(missing).toBe(-1);
  });

  it("returns the default when its type doesn't match the param's", () => {
    const { client } = makeClient({ bootstrap: checkoutBootstrap() });
    let discount: string | undefined;
    function Probe() {
      discount = useChertoVariantParam("checkout-copy", "discount", "ten");
      return null;
    }
    render(withProvider(client, <Probe />));
    expect(discount).toBe("ten");
  });

  it("enrolls after mount, unless { track: false }", async () => {
    const { client, events } = makeClient({ bootstrap: checkoutBootstrap() });
    function Probe({ track }: { track: boolean }) {
      useChertoVariantParam("checkout-copy", "headline", "", { track });
      return null;
    }
    const { rerender } = render(withProvider(client, <Probe track={false} />));
    await flushMicrotasks();
    expect(events).toEqual([]);

    rerender(withProvider(client, <Probe track />));
    await waitFor(() => expect(events).toHaveLength(1));
  });
});

describe("useChertoAssignment", () => {
  it("returns the assignment without enrolling", async () => {
    const { client, events } = makeClient({ bootstrap: checkoutBootstrap() });
    let assignment: ReturnType<typeof useChertoAssignment> = null;
    function Probe() {
      assignment = useChertoAssignment("checkout-copy");
      return null;
    }
    render(withProvider(client, <Probe />));
    expect(assignment).toEqual({
      variant: "treatment",
      startedAt: "2026-01-01T00:00:00.000Z",
      customValue: { headline: "Save big", discount: 10 },
    });
    await flushMicrotasks();
    expect(events).toEqual([]);
  });

  it("returns null when the experiment has no assignment", () => {
    const { client } = makeClient();
    let assignment: ReturnType<typeof useChertoAssignment> = null;
    function Probe() {
      assignment = useChertoAssignment("checkout-copy");
      return null;
    }
    render(withProvider(client, <Probe />));
    expect(assignment).toBeNull();
  });
});
