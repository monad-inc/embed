# Changelog

All notable changes to `@monad-inc/connect` will be documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-05-26

### Added

- Initial private release of the `createConnectorFrame` host SDK for
  embedding Monad's connector-config UI as a secure cross-origin
  iframe.
- Lifecycle helpers: `buildDevNullPipeline`, `findIntegrationPipeline`,
  `setIntegrationEnabled`, `disableIntegration`, `enableIntegration`,
  `deleteIntegration`.
- Cleanup policy presets: `CLEANUP_FULL`, `CLEANUP_KEEP_OUTPUT`,
  `CLEANUP_PIPELINE_ONLY`.
- Postmessage protocol exports: `PROTOCOL_SOURCE`, `PROTOCOL_VERSION`,
  `FrameMessage`, `HostMessage`, `InitMessage`.
- ESM + CJS dual build with TypeScript declarations.
