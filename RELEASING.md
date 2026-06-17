# Releasing

Packages in this repo publish to the **public** npm registry under the `@monad-inc` scope,
with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) via GitHub
Actions OIDC trusted publishing (no long-lived `NPM_TOKEN`).

## Day-to-day (after bootstrap)

1. In your PR, run `pnpm changeset`, pick the affected package(s) + bump, write a summary,
   and commit the generated `.changeset/*.md`.
2. On merge to `main`, the **Release** workflow opens/updates a **Version Packages** PR.
3. Merge that PR → the workflow runs `changeset publish`, which publishes the changed
   packages with provenance and pushes git tags. Fully tokenless.

## One-time bootstrap (first publish of a new package)

npm's trusted publisher can only be attached to a package that already exists, so the very
first publish of `@monad-inc/connect` is done by hand. **Requires npm ≥ 11.5 and an npm
account in the `monad-inc` org with publish rights.**

1. `npm install -g npm@latest` (local npm is 10.x; provenance needs ≥ 11.5).
2. `npm login`.
3. Publish once to create the package. Two options:
   - **Preferred — provenance from commit one:** temporarily give the `Release` workflow an
     `NPM_TOKEN` secret (automation token) and let it publish via the existing
     `release.yml` (it already has `id-token: write`, so provenance attaches). Delete the
     token immediately after.
   - **Fallback — laptop publish (no provenance on first version):** from
     `packages/connect/`, `npm publish --access public`. Provenance only attaches on
     subsequent CI publishes.
4. On npmjs.com: **`@monad-inc/connect` → Settings → Trusted Publisher → GitHub Actions**,
   set org `monad-inc`, repo `embed`, workflow `release.yml`. Then **delete any temporary
   `NPM_TOKEN`**. All future releases are tokenless.

## Verifying a publish

```sh
# in a scratch dir with NO .npmrc auth / NO NPM_TOKEN:
npm view @monad-inc/connect          # shows the version
npm install @monad-inc/connect       # succeeds anonymously => access:public worked
npm audit signatures                 # confirms provenance attestation
```

The npmjs.com package page should show the **"Built and signed on GitHub Actions"**
provenance badge linking back to the `release.yml` run.
