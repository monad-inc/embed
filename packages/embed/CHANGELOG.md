# Changelog

All notable changes to `@monad-inc/embed` will be documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-07-02

### Added

- Optional `name` and `description` options on `createConnectorFrame` (and
  the underlying `init` protocol message) so the host can set a created
  connector's name/description at creation time. On edit, omit them to keep
  the connector's existing values.
- Optional `isNameEditable` and `isDescriptionEditable` options that render
  editable name/description inputs inside the iframe, letting the end user set
  them at creation time. Prefilled from the host-provided `name`/`description`
  (or the type defaults) and, for the name, required when shown. Both default
  to off.

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
