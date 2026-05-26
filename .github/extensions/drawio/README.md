# draw.io canvas extension

A Copilot CLI canvas extension that embeds [diagrams.net](https://www.diagrams.net) (draw.io) and exposes a minimal XML-first action API for contextual diagram editing.

## Files

- `index.js` — extension entry; declares the `drawio` canvas via `@github/copilot-sdk/extension` and serves the iframe bridge from a loopback HTTP server.
- `extension.mjs` — Copilot CLI user/project extension entrypoint. Keep this in sync with `index.js` when packaging.
- `package.json` — Node ESM package with the `@github/copilot-sdk` dependency.
- `copilot-extension.json` — extension manifest (`entry: node index.js`).
- `drawio-webapp/` — generated offline diagrams.net assets, copied from the root `drawio` git submodule by `scripts/sync-drawio-webapp.sh`.

## How it works

1. `open` lazily starts a single shared loopback HTTP server on `127.0.0.1:<port>` and returns `http://127.0.0.1:<port>/?instanceId=<id>` as the iframe URL. Only loopback URLs are allowed.
2. The served HTML embeds `https://embed.diagrams.net/` with `proto=json` and dark UI. Messages from the editor (autosave, save, export) are forwarded to backend endpoints.
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

Initialize the draw.io submodule and generate the offline webapp assets:

```sh
git submodule update --init --recursive
./scripts/sync-drawio-webapp.sh
```

Place `.github/extensions/drawio/` at project scope or copy it to `~/.copilot/extensions/drawio/` for user scope.

For local standalone testing, install dependencies:

```sh
cd .github/extensions/drawio
npm install
```

The Copilot runtime starts `extension.mjs` and routes canvas callbacks to this process.

## Notes

- Internet access is required for the inner iframe to load `embed.diagrams.net`. The local `standalone.mjs` prototype demonstrates an offline bundled draw.io webapp.
- Diagram XML is held in-memory per `instanceId` unless `path` is provided, in which case the diagram is file-backed.
