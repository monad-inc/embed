---
'@monad-inc/embed': minor
---

Add `configMetaOverrides` for customizing connector field copy.

A new optional, backward-compatible option on `createConnectorFrame` (and the underlying `init` protocol message) that overrides the `name`, `description`, and `placeholder` of individual config-form fields, so embedders can word the form to fit their own product.

- Keys mirror the connector-type response, so they are the connector's own field keys (the Datadog output's source field is `ddsource`, not `source`). Keys that don't match the connector are ignored.
- Nested fields are reached with `children`, and multiple-choice variants with `discriminator.one_of`.
- Copy only: a field's type, requiredness, allowed values, and default are fixed by the connector. `placeholder` is a hint — a field the user never touches still submits an empty value.
