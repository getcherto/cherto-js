declare const __CHERTO_SDK_VERSION__: string | undefined;

/** This package's version. */
export const VERSION: string =
  // Undefined when the source is imported directly rather than built.
  typeof __CHERTO_SDK_VERSION__ === "string" ? __CHERTO_SDK_VERSION__ : "0.0.0-dev";
