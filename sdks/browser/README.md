# @cherto/browser

The browser SDK for [Cherto](https://getcherto.com) experiments.

## Requirements

- A browser that supports ES2020 and `fetch`
- A Cherto client key

## Install

```sh
npm install @cherto/browser
```

## Quick start

```ts
import { ChertoClient } from "@cherto/browser";

const cherto = new ChertoClient({
  clientKey: "ck_your_client_key",
  context: { units: { user: "u_123" } },
});

await cherto.initialize();
const variant = cherto.getVariant("checkout-copy", "control");
```

Create one client when your app starts and share it.

## License

[MIT](https://github.com/getcherto/cherto-js/blob/main/sdks/browser/LICENSE)
