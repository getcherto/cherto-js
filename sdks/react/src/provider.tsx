import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ChertoClient, type ChertoClientOptions, type ChertoContextInput } from "@cherto/browser";
import { VERSION } from "./version.js";

/** Pass exactly one of `client` and `clientOptions`; the provider throws otherwise. */
export type ChertoProviderProps = {
  /**
   * The context to load assignments for, in place of `clientOptions.context`. The provider
   * passes it to `client.identify()` on mount, before the hooks under it enroll, and again
   * whenever it changes by value. Without it, a `client` you pass in is yours to initialize.
   */
  context?: ChertoContextInput;
  children: ReactNode;
} & (
  | {
      /**
       * A client you built. The provider never closes it. To hydrate server-rendered HTML,
       * build it without `context` and pass `context` to the provider instead. A Suspense
       * boundary that hydrates after that reads the new context's assignments, so React
       * renders it on the client; `clientOptions` hydrates it with what the server rendered.
       */
      client: ChertoClient;
      clientOptions?: never;
    }
  | {
      client?: never;
      /**
       * Options for a client the provider builds, initializes and closes on unmount. Read
       * once, except that a `bootstrap` differing in more than `generatedAt`, such as the
       * server's after a sign-in, builds a new client from it.
       */
      clientOptions: ChertoClientOptions;
    }
);

interface ChertoContextValue {
  client: ChertoClient;
  /** Serves what the server rendered, for components still hydrating. */
  hydrationClient: ChertoClient | undefined;
  store: VersionStore;
}

/** The version hooks see while hydrating, when they must render what the server did. */
export const HYDRATING = -1;

const ChertoReactContext = createContext<ChertoContextValue | null>(null);

interface VersionStore {
  subscribe: (onChange: () => void) => () => void;
  getVersion: () => number;
}

const versionStores = new WeakMap<ChertoClient, VersionStore>();

/** Subscribes on first render, so a change before React subscribes still re-renders. */
function versionStoreOf(client: ChertoClient): VersionStore {
  const existing = versionStores.get(client);
  if (existing !== undefined) return existing;
  let version = 0;
  const listeners = new Set<() => void>();
  client.subscribe(() => {
    version++;
    for (const listener of [...listeners]) listener();
  });
  const store: VersionStore = {
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    getVersion: () => version,
  };
  versionStores.set(client, store);
  return store;
}

/** `@cherto/browser` keeps `sdkWrapper` out of its published types. */
type WrappedClientOptions = ChertoClientOptions & { sdkWrapper: { name: string; version: string } };

/** Owned clients whose provider unmounted and closed them. */
const retired = new WeakSet<ChertoClient>();
const closePending = new WeakSet<ChertoClient>();

/** Whether a provider closed `client`; consumers skip it until the provider replaces it. */
export function isRetired(client: ChertoClient): boolean {
  return retired.has(client);
}

/** `JSON.stringify` with keys sorted, so reordered keys compare equal. */
function stableStringify(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

const bootstrapKeys = new WeakMap<object, string>();

/** A bootstrap's content without `generatedAt`, so re-sent assignments aren't a new bootstrap. */
function bootstrapKeyOf(bootstrap: object): string {
  let key = bootstrapKeys.get(bootstrap);
  if (key === undefined) {
    const content: Record<string, unknown> = { ...bootstrap };
    delete content.generatedAt;
    key = stableStringify(content);
    bootstrapKeys.set(bootstrap, key);
  }
  return key;
}

export function useChertoContextValue(): ChertoContextValue {
  const ctx = useContext(ChertoReactContext);
  if (ctx === null) {
    throw new Error("@cherto/react hooks must be used within a <ChertoProvider>");
  }
  return ctx;
}

/**
 * The `ChertoClient` from the nearest `<ChertoProvider>`. The component re-renders whenever
 * the client's assignments or status change.
 */
export function useChertoClient(): ChertoClient {
  const { client, store } = useChertoContextValue();
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return client;
}

// Applies `context` before any child's passive effect enrolls against the bootstrap alone.
const useContextEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const quiet = { warn: () => {}, error: () => {} };
const noSubscription = () => () => {};
const notHydrating = () => false;
const hydratingOrServer = () => true;

/**
 * Hands a `ChertoClient` to the tree and re-renders consumers whenever its assignments change.
 * Starts no request during render. While hydrating, a client it builds has no context until
 * mount, so it serves what the server render did instead of what this browser saved.
 */
export function ChertoProvider({
  client: clientProp,
  clientOptions,
  context,
  children,
}: ChertoProviderProps): ReactNode {
  if ((clientProp === undefined) === (clientOptions === undefined)) {
    throw new Error("ChertoProvider requires exactly one of `client` or `clientOptions`.");
  }

  const hydrating = useSyncExternalStore(noSubscription, notHydrating, hydratingOrServer);
  const owned = useRef<{
    client: ChertoClient;
    hydrationClient: ChertoClient | undefined;
    context: ChertoContextInput | undefined;
    bootstrapKey: string | undefined;
  } | null>(null);
  const [, rebuild] = useReducer((n: number) => n + 1, 0);
  const bootstrap = clientOptions?.bootstrap;
  const bootstrapKey = bootstrap == null ? undefined : bootstrapKeyOf(bootstrap);
  if (
    clientOptions !== undefined &&
    (owned.current === null ||
      retired.has(owned.current.client) ||
      owned.current.bootstrapKey !== bootstrapKey)
  ) {
    const { context: optionsContext, ...options } = clientOptions;
    const initial = context ?? optionsContext ?? undefined;
    const wrapped: WrappedClientOptions = {
      sdkWrapper: { name: "react", version: VERSION },
      ...options,
      ...(initial !== undefined && !hydrating ? { context: initial } : {}),
    };
    owned.current = {
      client: new ChertoClient(wrapped),
      hydrationClient: hydrating
        ? new ChertoClient({
            ...wrapped,
            offline: true,
            storage: null,
            enrollmentTracking: { mode: "none" },
            logger: quiet,
          })
        : undefined,
      context: optionsContext ?? undefined,
      bootstrapKey,
    };
  }
  const ownsClient = clientProp === undefined;
  const client = clientProp ?? owned.current!.client;
  const hydrationClient = ownsClient ? owned.current!.hydrationClient : undefined;
  const store = versionStoreOf(client);

  const target = context ?? (ownsClient ? owned.current!.context : undefined);
  const targetKey = target === undefined ? undefined : stableStringify(target);
  useContextEffect(() => {
    if (retired.has(client)) return;
    // With the context the client already has, identify() only initializes it.
    if (target !== undefined) void client.identify(target);
    else if (ownsClient) void client.initialize();
    // targetKey stands in for target, a new object every render.
  }, [client, targetKey, ownsClient]);

  useEffect(() => {
    if (!ownsClient) return;
    // An Activity that was hidden closed the client; build another.
    if (retired.has(client)) {
      rebuild();
      return;
    }
    closePending.delete(client);
    return () => {
      // Deferred, so StrictMode's immediate re-run keeps the client open.
      closePending.add(client);
      queueMicrotask(() => {
        if (!closePending.delete(client)) return;
        retired.add(client);
        void client.close();
      });
    };
  }, [client, ownsClient]);

  // Holds no version, so an assignment change re-renders only subscribed hooks, never a
  // Suspense boundary still hydrating, which React would client-render instead.
  const value = useMemo<ChertoContextValue>(
    () => ({ client, hydrationClient, store }),
    [client, hydrationClient, store],
  );

  return <ChertoReactContext.Provider value={value}>{children}</ChertoReactContext.Provider>;
}
