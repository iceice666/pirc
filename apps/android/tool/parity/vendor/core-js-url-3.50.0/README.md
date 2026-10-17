# URL ponyfill for the document isolate

Source: core-js-pure **3.50.0**, MIT; https://github.com/zloirock/core-js
Builder: esbuild **0.28.2**, MIT. Pinned npm integrity and transitive versions
are in package-lock.json. Only the URL and URLSearchParams entry points are bundled.
No network, filesystem or Node APIs are installed into the document isolate.

SHA-256 of url-ponyfill.js: `e9b958e8601c9b91176d20e032cf3491048a22cba25d127e26ac0533edb75966`.

Regenerate in a temporary directory by copying entry.js/package*.json, running
`npm ci --ignore-scripts`, then using esbuild:

```sh
esbuild entry.js --bundle --platform=browser --format=iife --global-name=pircUrlPolyfill --target=es2020 --legal-comments=inline --outfile=url-ponyfill.js
```

The main runtime builder verifies the checksum and wraps this vendored source
in its strict IIFE. Its local `pircUrlPolyfill` object exposes URL/URLSearchParams.
Keep this file/license/lock information together; remove temporary build tools
after regeneration. This bundle is checked in, so ordinary app builds need no
extra npm install.
