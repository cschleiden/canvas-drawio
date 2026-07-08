# draw.io canvas extension

A Copilot CLI canvas extension that embeds [diagrams.net](https://www.diagrams.net) (draw.io) and exposes a minimal XML-first action API for contextual diagram editing.

## Files

- `extension.mjs` — Copilot CLI extension entrypoint; declares the `drawio` canvas via `@github/copilot-sdk/extension` and serves the iframe bridge from a loopback HTTP server.
- `index.js` — legacy standalone entry kept in sync with `extension.mjs` for older local testing flows.
- `package.json` — optional Node ESM metadata for local standalone testing. The Copilot runtime supplies `@github/copilot-sdk`; do not vendor or pin it here.
- `copilot-extension.json` — extension manifest (`entry: node extension.mjs`).
- `assets-manifest.json` — versioned first-run asset download metadata and SHA-256.
- `drawio-webapp/` — optional local/generated offline diagrams.net assets, ignored by Git. If missing, the extension downloads the versioned archive into the user's Copilot extension cache on first open.

## How it works

1. `open` lazily starts a single shared loopback HTTP server on `127.0.0.1:<port>` and returns `http://127.0.0.1:<port>/?instanceId=<id>` as the iframe URL. Only loopback URLs are allowed. Opens are idempotent: when the runtime restores a live open-canvas snapshot after an extension reload, the same input rehydrates the canvas from its artifact, file path, or supplied XML.
2. On first open, the extension serves a lightweight loading page while it downloads the draw.io webapp archive declared in `assets-manifest.json`, verifies the archive SHA-256, and extracts it under `~/.copilot/extensions/drawio/artifacts/drawio-webapp/<version>/`. If a local `drawio-webapp/` directory exists next to `extension.mjs`, it is used directly for development.
3. Agent-driven commands (`get_editor_state`, `set_diagram`, `export_diagram`) are pushed to the iframe over Server-Sent Events on `/events`. Replies come back through `/iframe-reply` and resolve a per-request promise.

The current extension uses the offline bundled draw.io webapp directly and injects artifact commands into draw.io's native **File** menu:

- **File > Save artifact** writes the current diagram XML to the bound artifact. If the diagram is not bound yet, it asks for an artifact filename.
- **File > Save as artifact...** always asks for an artifact filename and starts autosaving there.
- Unsaved diagrams are titled `Untitled diagram (unsaved)` until they are bound to an artifact.

## Actions

| Action | Input | Result |
| --- | --- | --- |
| `get_editor_state` | _none_ | `{ diagram, selection, viewport }` — high-level editor context |
| `set_diagram` | `{ xml, title? }` | Replaces the current diagram with complete mxGraphModel or mxfile XML |
| `export_diagram` | `{ format }` where format is `xml`, `svg`, `xmlsvg`, `png`, or `xmlpng` | `{ format, content }` — XML text or image data URI |

Per-canvas open input:

```json
{
  "artifactName": "diagram.drawio",
  "path": "/absolute/path/to/diagram.drawio",
  "xml": "<mxfile>...</mxfile>",
  "title": "My diagram",
  "autosave": true,
  "theme": "dark"
}
```

Use `artifactName` to bind the canvas to a `.drawio` XML file under the session `files/` artifact directory. If the artifact exists, it is loaded on open. If both `artifactName` and `xml` are supplied, the XML is loaded and written to the artifact. With `autosave: true` (default), editor autosaves and `set_diagram` updates are written back to the artifact.

`path` is still accepted for advanced programmatic use, but the toolbar intentionally accepts artifact filenames only, not arbitrary paths.

The intended editing loop is:

1. `get_editor_state()` to discover selection and viewport context.
2. `export_diagram({ "format": "xml" })` to fetch the current model.
3. Patch the XML deterministically.
4. `set_diagram({ "xml": patchedXml })` to reload the updated model.

## Install

The installable extension folder is intentionally small enough for the app's extension installer. It does not commit the generated offline webapp assets.

Install from the repo folder URL:

```text
https://github.com/cschleiden/canvas-drawio/tree/main/.github/extensions/drawio
```

The first canvas open downloads and caches the asset archive from the GitHub Release URL in `assets-manifest.json`.

To refresh and package the asset archive from the pinned draw.io submodule:

```sh
git submodule update --init --recursive
./scripts/sync-drawio-webapp.sh
./scripts/package-drawio-assets.sh
```

Upload the resulting `dist/drawio-webapp-<version>.tar.gz` to the release URL named in `assets-manifest.json`, then update `sha256` if the archive changed.

Place `.github/extensions/drawio/` at project scope or copy it to `~/.copilot/extensions/drawio/` for user scope.

For local standalone testing, run the extension through the Copilot CLI extension loader so the SDK import is resolved by the runtime:

```sh
copilot
```

The Copilot runtime starts `extension.mjs`, tracks live open canvas snapshots, and routes canvas callbacks to this process.

## Notes

- The current runtime snapshot stores open canvas metadata and input. Bind long-lived diagrams with `artifactName` or `path` so a restored canvas can rehydrate from durable XML after extension or app restarts.
- Diagram XML is held in-memory per `instanceId` unless `artifactName` or `path` is provided, in which case the diagram is file-backed.
- Set `DRAWIO_ASSET_URL=file:///absolute/path/to/drawio-webapp-<version>.tar.gz` when testing first-run asset installation locally.
