# @cherto/node

The Node.js server SDK for [Cherto](https://getcherto.com) experiments.

## Requirements

- Node.js 22.12 or later
- A Cherto server key

## Install

```sh
npm install @cherto/node
```

## Quick start

```ts
import { ChertoClient } from "@cherto/node";

const cherto = await ChertoClient.init({
  serverKey: process.env.CHERTO_SERVER_KEY!,
});

const ctx = cherto.context({ units: { user: "user-123" } });
const variant = ctx.getVariant("checkout-copy", "control");

// Branch on the variant where your app renders it.
const title = variant === "treatment" ? "Complete your order" : "Checkout";
```

Create one client at startup and share it.

## License

[MIT](https://github.com/getcherto/cherto-js/blob/main/sdks/node/LICENSE)
