# Build Versioning

Di2va now generates an automatic local build counter during `npm run build`.

## How it works

- Webpack computes a SHA-1 hash across tracked extension sources:
  - `src/`
  - `popup/`
  - `options/`
  - `manifest.json`
  - `package.json`
  - `webpack.config.js`
- The hash is compared with the previous value in `extension/.di2va-build.json`.
- If the hash changed, `buildNumber` increments by 1.
- If the hash is unchanged, `buildNumber` stays the same.

The build metadata is injected into the bundle and shown in the debug panel as:

`Build v<manifestVersion>.<buildNumber> (<gitShortHash>/<sourceHash>)`

## Notes

- `extension/.di2va-build.json` is local state and is gitignored.
- The counter increments when source changes are present and a rebuild is run.
- This is intended for development traceability, not release tagging.
