import { describe, it, expect, vi } from "vitest";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  ChertoClient,
  type ChertoClientOptions,
  type ChertoContextInput,
  type ChertoEnrollmentEvent,
} from "@cherto/browser";
import { ChertoProvider, useChertoClient } from "./provider.js";
import { useChertoVariant } from "./hooks.js";
import {
  checkoutBootstrap,
  clientOptions,
  makeClient,
  memoryStorage,
  saveAssignments,
} from "./test-helpers.js";

function VariantProbe() {
  const client = useChertoClient();
  return (
    <span data-testid="variant">
      {client.getVariant("checkout-copy", "control", { track: false })}
    </span>
  );
}

const flushMicrotasks = () => act(async () => {});
const enrollments = (events: ChertoEnrollmentEvent[]) =>
  events.map((e) => `${e.variantKey}@${e.unitId}`);

describe("useChertoClient", () => {
  it("throws when used outside a ChertoProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Probe() {
      useChertoClient();
      return null;
    }
    expect(() => render(<Probe />)).toThrow(
      "@cherto/react hooks must be used within a <ChertoProvider>",
    );
    spy.mockRestore();
  });

  it("returns the client passed to the provider", () => {
    const { client } = makeClient();
    let seen: ChertoClient | undefined;
    function Probe() {
      seen = useChertoClient();
      return null;
    }
    render(
      <ChertoProvider client={client}>
        <Probe />
      </ChertoProvider>,
    );
    expect(seen).toBe(client);
  });
});

describe("ChertoProvider", () => {
  it("builds one client from clientOptions and keeps it across renders", () => {
    const seen: ChertoClient[] = [];
    function Probe() {
      seen.push(useChertoClient());
      return null;
    }
    const tree = () => (
      <ChertoProvider clientOptions={clientOptions({ offline: true }).options}>
        <Probe />
      </ChertoProvider>
    );
    const { rerender } = render(tree());
    rerender(tree());

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeInstanceOf(ChertoClient);
    expect(seen[0]).toBe(seen[1]);
  });

  it("throws when both client and clientOptions are given", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        // @ts-expect-error exercising the runtime guard
        <ChertoProvider client={makeClient().client} clientOptions={clientOptions().options}>
          <div />
        </ChertoProvider>,
      ),
    ).toThrow("requires exactly one of `client` or `clientOptions`");
    spy.mockRestore();
  });

  it("throws when neither client nor clientOptions is given", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        // @ts-expect-error exercising the runtime guard
        <ChertoProvider>
          <div />
        </ChertoProvider>,
      ),
    ).toThrow("requires exactly one of `client` or `clientOptions`");
    spy.mockRestore();
  });
});

describe("ChertoProvider loading", () => {
  it("loads assignments for the context prop on mount", async () => {
    const { options, api } = clientOptions();
    render(
      <ChertoProvider clientOptions={options} context={{ units: { user: "u1" } }}>
        <VariantProbe />
      </ChertoProvider>,
    );
    expect(screen.getByTestId("variant").textContent).toBe("control");
    await waitFor(() => expect(screen.getByTestId("variant").textContent).toBe("treatment"));
    expect(api.requests).toEqual([{ user: "u1" }]);
  });

  it("loads assignments for clientOptions.context when there is no context prop", async () => {
    const { options, api } = clientOptions({ context: { units: { user: "u1" } } });
    render(
      <ChertoProvider clientOptions={options}>
        <VariantProbe />
      </ChertoProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("variant").textContent).toBe("treatment"));
    expect(api.requests).toEqual([{ user: "u1" }]);
  });

  it("doesn't load a client passed in without a context prop", async () => {
    const { client, api } = makeClient({ context: { units: { user: "u1" } } });
    render(
      <ChertoProvider client={client}>
        <div />
      </ChertoProvider>,
    );
    await flushMicrotasks();
    expect(api.requests).toEqual([]);
  });

  it("re-renders consumers when the client's assignments change", async () => {
    const { client } = makeClient();
    render(
      <ChertoProvider client={client}>
        <VariantProbe />
      </ChertoProvider>,
    );
    expect(screen.getByTestId("variant").textContent).toBe("control");

    await act(() => client.identify({ units: { user: "u1" } }));

    expect(screen.getByTestId("variant").textContent).toBe("treatment");
  });

  it("calls identify() when the context prop changes", async () => {
    const { client, api } = makeClient({}, (units) => (units.user === "u2" ? "b" : "a"));
    const identify = vi.spyOn(client, "identify");
    const { rerender } = render(
      <ChertoProvider client={client} context={{ units: { user: "u1" } }}>
        <VariantProbe />
      </ChertoProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("variant").textContent).toBe("a"));

    rerender(
      <ChertoProvider client={client} context={{ units: { user: "u2" } }}>
        <VariantProbe />
      </ChertoProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("variant").textContent).toBe("b"));
    expect(identify).toHaveBeenLastCalledWith({ units: { user: "u2" } });
    expect(api.requests).toEqual([{ user: "u1" }, { user: "u2" }]);
  });
});

describe("ChertoProvider with saved assignments", () => {
  const context = { units: { user: "u1" } };
  function Reader() {
    return <span>{useChertoVariant("checkout-copy", "control", { track: false })}</span>;
  }
  const tree = (options: ChertoClientOptions) => (
    <ChertoProvider clientOptions={options} context={context}>
      <Reader />
    </ChertoProvider>
  );

  it("serves them on the first render", async () => {
    const storage = memoryStorage();
    await saveAssignments(storage);

    const { container } = render(tree(clientOptions({ storage }).options));

    expect(container.textContent).toBe("treatment");
  });

  it("hydrates server HTML without a mismatch, then serves them", async () => {
    const storage = memoryStorage();
    await saveAssignments(storage);
    const container = document.createElement("div");
    container.innerHTML = renderToString(tree(clientOptions().options));
    expect(container.textContent).toBe("control");
    const recoverable: unknown[] = [];

    let root: Root | undefined;
    await act(async () => {
      root = hydrateRoot(container, tree(clientOptions({ storage }).options), {
        onRecoverableError: (err) => recoverable.push(err),
      });
    });

    expect(recoverable).toEqual([]);
    expect(container.textContent).toBe("treatment");
    act(() => root!.unmount());
  });
});

describe("ChertoProvider with a server bootstrap", () => {
  function Reader() {
    return <span>{useChertoVariant("checkout-copy", "control")}</span>;
  }

  async function hydrate(context: ChertoContextInput) {
    const tree = (options: ChertoClientOptions) => (
      <ChertoProvider clientOptions={options} context={context}>
        <Reader />
      </ChertoProvider>
    );
    const bootstrap = checkoutBootstrap();
    const container = document.createElement("div");
    container.innerHTML = renderToString(tree(clientOptions({ bootstrap }).options));
    const made = clientOptions({ bootstrap }, () => "control");
    let root: Root | undefined;
    await act(async () => {
      root = hydrateRoot(container, tree(made.options));
    });
    return { ...made, container, unmount: () => act(() => root!.unmount()) };
  }

  it("serves and enrolls a bootstrap that matches the context, with no request", async () => {
    const { container, events, api, unmount } = await hydrate({ units: { user: "u1" } });

    expect(container.textContent).toBe("treatment");
    await waitFor(() => expect(events).toHaveLength(1));
    expect(enrollments(events)).toEqual(["treatment@u1"]);
    expect(api.requests).toEqual([]);
    unmount();
  });

  it("loads and enrolls the context's unit when the bootstrap is for another", async () => {
    const { container, events, unmount } = await hydrate({ units: { user: "u2" } });

    await waitFor(() => expect(container.textContent).toBe("control"));
    expect(enrollments(events)).toEqual(["control@u2"]);
    unmount();
  });
});

describe("ChertoProvider closing", () => {
  it("closes the client it built when it unmounts", async () => {
    let client: ChertoClient | undefined;
    function Probe() {
      client = useChertoClient();
      return null;
    }
    const { unmount } = render(
      <ChertoProvider clientOptions={clientOptions({ offline: true }).options}>
        <Probe />
      </ChertoProvider>,
    );
    const close = vi.spyOn(client!, "close");

    unmount();
    await flushMicrotasks();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("never closes a client passed in", async () => {
    const { client } = makeClient({ offline: true });
    const close = vi.spyOn(client, "close");
    const { unmount } = render(
      <ChertoProvider client={client}>
        <div />
      </ChertoProvider>,
    );
    unmount();
    await flushMicrotasks();
    expect(close).not.toHaveBeenCalled();
  });
});
