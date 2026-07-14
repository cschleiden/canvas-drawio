# draw.io canvas for GitHub Copilot

A GitHub Copilot extension that contributes an interactive draw.io canvas backed
by the offline [diagrams.net](https://www.diagrams.net/) editor. It lets Copilot
create, inspect, edit, save, and export draw.io diagrams.

The extension keeps diagrams as standard draw.io XML and supports XML, SVG, and
PNG exports. The diagrams.net web application is packaged with the plugin, so
the canvas works offline without downloading assets on first use.

## Install

Add this repository as a Copilot plugin marketplace, then install the draw.io
plugin:

```sh
copilot plugin marketplace add cschleiden/canvas-drawio
copilot plugin install drawio@canvas-drawio
```

You can also install the plugin directly from its repository path:

```sh
copilot plugin install cschleiden/canvas-drawio:.github/extensions/drawio
```

Start a new Copilot session after installation, then ask Copilot to open the
**draw.io** canvas.

## Use

Ask Copilot to open the draw.io canvas and create or edit a diagram. Saved
diagrams use the `.drawio` file format and can also be exported as SVG or PNG.

For extension internals, supported actions, and development instructions, see
[the extension documentation](.github/extensions/drawio/README.md).
