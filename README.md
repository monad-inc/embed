# @monad-inc/embed

Tools to embed Monad's UI in other apps using a secure iframe and safe cross-browser comms.

This repository hosts Monad's publicly published embed SDKs. The customer's page mounts a
Monad-hosted iframe; the connector form and every secret typed into it run inside that
iframe, so the host's JavaScript never sees credential material.

## Packages

| Package                                    | Description                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| [`@monad-inc/connect`](./packages/connect) | Host-side SDK — `createConnectorFrame()`, lifecycle helpers, and the postMessage protocol. Zero runtime dependencies. |

## Install

```sh
npm install @monad-inc/connect
# or
pnpm add @monad-inc/connect
```

See the [`@monad-inc/connect` README](./packages/connect/README.md) and
[`USAGE.md`](./packages/connect/USAGE.md) for the API and integration guide.

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
