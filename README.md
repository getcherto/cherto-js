# Cherto JavaScript SDKs

[![CI](https://github.com/getcherto/cherto-js/actions/workflows/ci.yml/badge.svg)](https://github.com/getcherto/cherto-js/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Official JavaScript and TypeScript SDKs for [Cherto](https://getcherto.com) experiments.

| Package                            | Version                                                                                               | Description                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [`@cherto/node`](sdks/node/)       | [![npm](https://img.shields.io/npm/v/@cherto/node)](https://www.npmjs.com/package/@cherto/node)       | Node.js server SDK that evaluates experiments locally.        |
| [`@cherto/browser`](sdks/browser/) | [![npm](https://img.shields.io/npm/v/@cherto/browser)](https://www.npmjs.com/package/@cherto/browser) | Browser SDK that reads the variants Cherto assigns a visitor. |
| [`@cherto/react`](sdks/react/)     | [![npm](https://img.shields.io/npm/v/@cherto/react)](https://www.npmjs.com/package/@cherto/react)     | React provider and hooks for `@cherto/browser`.               |

`packages/core` and `packages/eval-core` hold the logic the SDKs bundle; they are not published separately.

## Getting started

```sh
npm install @cherto/node                   # on your server
npm install @cherto/browser                # in your web app
npm install @cherto/react @cherto/browser  # in a React app
```

On your server, `@cherto/node` evaluates experiments locally, with no request per read:

```ts
import { ChertoClient } from "@cherto/node";

const cherto = await ChertoClient.init({ serverKey: process.env.CHERTO_SERVER_KEY! });

const ctx = cherto.context({ units: { user: "u_123" } });
const variant = ctx.getVariant("checkout-copy", "control");
```

In the browser, `@cherto/browser` loads a visitor's assignments and serves them synchronously:

```ts
import { ChertoClient } from "@cherto/browser";

const cherto = new ChertoClient({
  clientKey: "ck_your_client_key",
  context: { units: { user: "u_123" } },
});

await cherto.initialize();
const variant = cherto.getVariant("checkout-copy", "control");
```

In both, `getVariant` also records enrollment, the record that the user saw their variant, which is what experiment results count.

Each package's README covers setup and use: [`@cherto/node`](sdks/node/README.md), [`@cherto/browser`](sdks/browser/README.md), [`@cherto/react`](sdks/react/README.md).

## Versioning

Each package is versioned on its own and follows semantic versioning. While a version is 0.x, a minor release may contain breaking changes, which its changelog marks: [`@cherto/node`](sdks/node/CHANGELOG.md), [`@cherto/browser`](sdks/browser/CHANGELOG.md), [`@cherto/react`](sdks/react/CHANGELOG.md). Every release is tagged `<package>@<version>`, for example `@cherto/node@0.4.1`.

## Support

- Bugs and feature requests: [Issues](../../issues). Issues are public, so leave out keys and anything that identifies your users.
- Security vulnerabilities: see [SECURITY.md](SECURITY.md).

## Development

Requires Node.js 24.11 or later and pnpm 12.

```sh
pnpm install
pnpm build
pnpm test
pnpm check:package  # checks each package's packed tarball
```

## Contributing

Bug reports and feature requests are welcome in [Issues](../../issues). We don't accept pull requests on this repository.

## License

[MIT](LICENSE)
