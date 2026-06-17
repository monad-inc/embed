# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).

When you make a change that should be released, add a changeset:

```sh
pnpm changeset
```

Pick the affected package(s) and a semver bump (`patch` / `minor` / `major`), and write a
short summary. Commit the generated `.changeset/*.md` file with your PR.

On merge to `main`, the release workflow opens (or updates) a **Version Packages** PR that
bumps versions, updates each `CHANGELOG.md`, and rewrites internal `workspace:` ranges.
Merging that PR publishes the changed packages to npm with provenance.

See [the Changesets docs](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md).
