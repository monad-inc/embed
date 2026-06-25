# @monad-inc/embed

Tools to embed Monad's UI in other apps using a secure iframe and safe cross-browser comms.

This repository hosts Monad's publicly published embed SDKs. The customer's page mounts a
Monad-hosted iframe; the connector form and every secret typed into it run inside that
iframe, so the host's JavaScript never sees credential material.

## Packages

| Package                                | Description                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`@monad-inc/embed`](./packages/embed) | Public embed SDK. Functionality is exposed through subpath modules. Zero runtime dependencies. |

### Modules

| Import                     | Description                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `@monad-inc/embed/connect` | Host-side SDK — `createConnectorFrame()`, lifecycle helpers, and the postMessage protocol. |

## Install

```sh
npm install @monad-inc/embed
# or
pnpm add @monad-inc/embed
```

```ts
import { createConnectorFrame } from '@monad-inc/embed/connect';
```

See the [`@monad-inc/embed` README](./packages/embed/README.md) and
[`USAGE.md`](./packages/embed/USAGE.md) for the API and integration guide.

## Guides

| Guide                                        | Description                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| [Connector icons](./docs/connector-icons.md) | Fetch vendor logos for the connectors you embed, via the public raw SVG icon endpoint. |

## Repo layout

This is a [pnpm](https://pnpm.io) workspace. Package sources live under `packages/*`.

```sh
pnpm install        # install all workspace deps
pnpm build          # build every package
pnpm typecheck      # type-check every package
pnpm test           # run every package's tests
pnpm lint           # lint the workspace
pnpm format         # format with Prettier
```

Releases are managed with [Changesets](https://github.com/changesets/changesets); see
`.changeset/` and `.github/workflows/release.yml`.

## License

[Apache-2.0](./LICENSE) © Monad Inc. See [`NOTICE`](./NOTICE).
