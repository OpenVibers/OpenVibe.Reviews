# Changelog

## Unreleased

- Every page is rendered through `openvibe-publishing/layout` (v1.2.0, on `openvibe-shared/shell` v2.6.0): the head, the Frame, the noscript navigation, the footer and its init come from the shared document; robots is still exactly what each route passes (the entity page now passes the indexability gate's decision instead of a prebuilt head block). The shell adds `web-runtime.js`, so the home page's JS budget is raised to 257 KB, 61.5 KB brotli (measured 239.1 / 56.3, was 212.2 / 49.9).
