# Third-party notices

`vendor/wa-sqlite/` holds unmodified files from the npm package `@journeyapps/wa-sqlite` 2.0.4 (https://github.com/powersync-ja/wa-sqlite), a fork of wa-sqlite by Roy T. Hashimoto. `vendor/wa-sqlite/PROVENANCE.json` records the package integrity and each file's SHA-256.

- wa-sqlite: MIT License, see `vendor/wa-sqlite/LICENSE`.
- SQLite, compiled into the `.wasm` files: public domain, see https://sqlite.org/copyright.html.
- Emscripten runtime code in the `.mjs` loaders: MIT License or University of Illinois/NCSA Open Source License, see `vendor/wa-sqlite/LICENSE-emscripten`.

The `.wasm` files under `variants/` are `vendor/wa-sqlite/dist/wa-sqlite-async.wasm` rewritten by `tools/pad-wasm.mjs`; each directory's `manifest.json` records the change. Their `.mjs` loaders are unmodified copies.
