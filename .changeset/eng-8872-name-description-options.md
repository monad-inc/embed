---
'@monad-inc/embed': minor
---

Port the ENG-8845 connector name/description options into the connect SDK.

Adds four optional, backward-compatible options to `createConnectorFrame` (and the underlying `init` protocol message):

- `name` / `description` — set the created connector's name/description at creation time; omit on edit to keep existing values.
- `isNameEditable` / `isDescriptionEditable` — render editable name/description inputs inside the iframe, prefilled from the resolved values. Both default to off.
