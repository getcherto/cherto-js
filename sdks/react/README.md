# @cherto/react

React bindings for [`@cherto/browser`](https://www.npmjs.com/package/@cherto/browser), the browser SDK for [Cherto](https://getcherto.com) experiments.

## Requirements

- React 18 or 19

## Install

```sh
npm install @cherto/react @cherto/browser
```

## Quick start

```tsx
import { ChertoProvider, useChertoVariant } from "@cherto/react";

export function App() {
  return (
    <ChertoProvider
      clientOptions={{ clientKey: "ck_your_client_key" }}
      context={{ units: { user: "u_123" } }}
    >
      <Checkout />
    </ChertoProvider>
  );
}

function Checkout() {
  const copy = useChertoVariant("checkout-copy", "control");
  return <h1>{copy === "treatment" ? "Almost there!" : "Checkout"}</h1>;
}
```

## License

[MIT](https://github.com/getcherto/cherto-js/blob/main/sdks/react/LICENSE)
