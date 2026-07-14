# draw.io Copilot extension

A Copilot CLI extension that contributes a canvas embedding [diagrams.net](https://www.diagrams.net) (draw.io) and exposes a minimal XML-first action API for contextual diagram editing.

## Files

- `extension.mjs` — Copilot CLI extension entrypoint; declares the `drawio` canvas via `@github/copilot-sdk/extension` and serves the iframe bridge from a loopback HTTP server.
- `index.js` — legacy standalone entry kept in sync with `extension.mjs` for older local testing flows.
- `package.json` — optional Node ESM metadata for local standalone testing. The Copilot runtime supplies `@github/copilot-sdk`; do not vendor or pin it here.
- `copilot-extension.json` — extension manifest (`entry: node extension.mjs`).
- `drawio-webapp/` — vendored offline diagrams.net assets, copied from the root `drawio` git submodule by `scripts/sync-drawio-webapp.sh`.

## How it works

1. `open` lazily starts a single shared loopback HTTP server on `127.0.0.1:<port>` and returns `http://127.0.0.1:<port>/?instanceId=<id>` as the iframe URL. Only loopback URLs are allowed. Opens are idempotent: when the runtime restores a live open-canvas snapshot after an extension reload, the same input rehydrates the canvas from its artifact, file path, or supplied XML.
2. The served HTML loads the bundled offline diagrams.net webapp with `proto=json` and dark UI. Messages from the editor (autosave, save, export) are forwarded to backend endpoints.
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

The plugin includes the generated offline webapp assets in `drawio-webapp/`, so it has everything needed to load the canvas without a first-run download.

Add the marketplace and install the plugin:

```sh
copilot plugin marketplace add cschleiden/canvas-drawio
copilot plugin install drawio@canvas-drawio
```

To refresh the vendored assets from the pinned draw.io submodule:

```sh
git submodule update --init --recursive
./scripts/sync-drawio-webapp.sh
```

For local standalone testing, run the extension through the Copilot CLI extension loader so the SDK import is resolved by the runtime:

```sh
copilot
```

The Copilot runtime starts `extension.mjs`, tracks live open canvas snapshots, and routes canvas callbacks to this process.

## Notes

- The current runtime snapshot stores open canvas metadata and input. Bind long-lived diagrams with `artifactName` or `path` so a restored canvas can rehydrate from durable XML after extension or app restarts.
- Diagram XML is held in-memory per `instanceId` unless `artifactName` or `path` is provided, in which case the diagram is file-backed.
