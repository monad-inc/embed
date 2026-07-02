# Changelog

## 0.2.0

### Minor Changes

- 42e44e3: Port the ENG-8845 connector name/description options into the connect SDK.

  Adds four optional, backward-compatible options to `createConnectorFrame` (and the underlying `init` protocol message):

  - `name` / `description` — set the created connector's name/description at creation time; omit on edit to keep existing values.
  - `isNameEditable` / `isDescriptionEditable` — render editable name/description inputs inside the iframe, prefilled from the resolved values. Both default to off.

All notable changes to `@monad-inc/embed` will be documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-05-26

### Added

- Initial release of the `@monad-inc/embed/connect` host SDK
  (`createConnectorFrame`) for embedding Monad's connector-config UI as a
  secure cross-origin iframe.
- Lifecycle helpers: `buildDevNullPipeline`, `findIntegrationPipeline`,
  `setIntegrationEnabled`, `disableIntegration`, `enableIntegration`,
  `deleteIntegration`.
- Cleanup policy presets: `CLEANUP_FULL`, `CLEANUP_KEEP_OUTPUT`,
  `CLEANUP_PIPELINE_ONLY`.
- Postmessage protocol exports: `PROTOCOL_SOURCE`, `PROTOCOL_VERSION`,
  `FrameMessage`, `HostMessage`, `InitMessage`.
- ESM + CJS dual build with TypeScript declarations.
