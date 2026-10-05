# Changelog

## Unreleased

- openvibe-contracts moves from v0.76.0 to v0.96.0 (pin, lockfile and `node_modules`); nothing in the range breaks Reviews, and the contracts' own service check is green. All eight `reviews.*` ids are now defined by the release, so `server/auth/capabilities.js` drops its local fallback for proposed ids and sends every check through the library's grant rule; `test/capabilities.test.js` pins that every guarded id is defined and that exact, prefix, denied and unknown ids answer as `capabilities.check()` does. README and STATUS.json name v0.96.0.
- Every page is rendered through `openvibe-publishing/layout` (v1.2.0, on `openvibe-shared/shell` v2.6.0): the head, the Frame, the noscript navigation, the footer and its init come from the shared document; robots is still exactly what each route passes (the entity page now passes the indexability gate's decision instead of a prebuilt head block). The shell adds `web-runtime.js`, so the home page's JS budget is raised to 257 KB, 61.5 KB brotli (measured 239.1 / 56.3, was 212.2 / 49.9).
