import http from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP_DIR = path.join(__dirname, "drawio-webapp");
let artifactsDir;

const BLANK_XML = `<mxfile><diagram id="blank" name="Page-1"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`;

const instances = new Map();

const mimeTypes = new Map([
	[".html", "text/html; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".svg", "image/svg+xml"],
	[".xml", "application/xml; charset=utf-8"],
	[".txt", "text/plain; charset=utf-8"],
	[".woff", "font/woff"],
	[".woff2", "font/woff2"],
	[".ttf", "font/ttf"],
]);

function defaultEditorState(title = "Untitled diagram") {
	return {
		diagram: { title, dirty: false },
		selection: { ids: [], elements: [] },
		viewport: null,
	};
}

function getInstance(instanceId) {
	let inst = instances.get(instanceId);
	if (!inst) {
		inst = {
			instanceId,
			xml: BLANK_XML,
			title: "Untitled diagram (unsaved)",
			filePath: null,
			artifactName: null,
			autosave: true,
			editorState: defaultEditorState(),
			sseClients: new Set(),
			pending: new Map(),
		};
		instances.set(instanceId, inst);
	}
	return inst;
}

function sendSse(inst, event) {
	const payload = `data: ${JSON.stringify(event)}\n\n`;
	for (const res of inst.sseClients) {
		try {
			res.write(payload);
		} catch {}
	}
}

function pushToEditor(inst, message, awaitReplyKind) {
	if (awaitReplyKind && inst.sseClients.size === 0) {
		throw new CanvasError("editor_not_connected", "The draw.io editor page is not connected yet.");
	}

	if (awaitReplyKind) {
		const requestId = randomUUID();
		const promise = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				inst.pending.delete(requestId);
				reject(new CanvasError("timeout", `Timed out waiting for ${awaitReplyKind}`));
			}, 15000);
			inst.pending.set(requestId, { resolve, reject, timer, kind: awaitReplyKind });
		});
		sendSse(inst, { ...message, requestId });
		return promise;
	}

	sendSse(inst, message);
	return undefined;
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			if (!raw) return resolve({});
			try {
				resolve(JSON.parse(raw));
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}

async function fileExists(filePath) {
	try {
		const st = await stat(filePath);
		return st.isFile();
	} catch {
		return false;
	}
}

function resolveDiagramPath(filePath) {
	if (typeof filePath !== "string" || filePath.length === 0) {
		throw new CanvasError("invalid_path", "path must be a non-empty string.");
	}
	return path.resolve(filePath);
}

async function writeDiagramFile(inst, xml) {
	if (!inst.filePath || inst.autosave === false) return;
	await mkdir(path.dirname(inst.filePath), { recursive: true });
	await writeFile(inst.filePath, xml, "utf8");
}

function normalizeArtifactName(name) {
	if (typeof name !== "string" || name.trim().length === 0) {
		throw new CanvasError("invalid_artifact_name", "Artifact name must be a non-empty filename.");
	}
	const trimmed = name.trim();
	if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
		throw new CanvasError("invalid_artifact_name", "Artifact name must be a filename, not a path.");
	}
	return trimmed.endsWith(".drawio") ? trimmed : `${trimmed}.drawio`;
}

function resolveArtifactPath(name) {
	if (!artifactsDir) {
		throw new CanvasError("artifacts_unavailable", "This session does not expose an artifacts directory.");
	}
	const artifactName = normalizeArtifactName(name);
	return {
		artifactName,
		filePath: path.join(artifactsDir, artifactName),
	};
}

async function bindArtifactFile(inst, name, { moveExisting = false } = {}) {
	const { artifactName, filePath } = resolveArtifactPath(name);
	if (moveExisting && inst.filePath && inst.filePath !== filePath && await fileExists(inst.filePath)) {
		await mkdir(path.dirname(filePath), { recursive: true });
		await rename(inst.filePath, filePath);
	} else {
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, inst.xml, "utf8");
	}
	inst.filePath = filePath;
	inst.artifactName = artifactName;
	inst.title = artifactName;
	inst.editorState = { ...inst.editorState, diagram: { ...inst.editorState.diagram, title: inst.title, dirty: false } };
	return { artifactName, path: filePath, title: inst.title };
}

async function bindDiagramFile(inst, filePath, { moveExisting = false } = {}) {
	const nextPath = resolveDiagramPath(filePath);
	if (moveExisting && inst.filePath && inst.filePath !== nextPath && await fileExists(inst.filePath)) {
		await mkdir(path.dirname(nextPath), { recursive: true });
		await rename(inst.filePath, nextPath);
	} else {
		await mkdir(path.dirname(nextPath), { recursive: true });
		await writeFile(nextPath, inst.xml, "utf8");
	}
	inst.filePath = nextPath;
	inst.artifactName = null;
	inst.title = path.basename(nextPath);
	inst.editorState = { ...inst.editorState, diagram: { ...inst.editorState.diagram, title: inst.title, dirty: false } };
	return { path: inst.filePath, title: inst.title };
}

function renderIndexHtml(instanceId) {
	return `<!doctype html>
<html>
<head>
<base href="/drawio/index.html" />
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<title>draw.io</title>
<link rel="stylesheet" type="text/css" href="styles/grapheditor.css" />
<link rel="stylesheet" media="(forced-colors: active)" href="styles/high-contrast.css" id="high-contrast-stylesheet" />
<link rel="manifest" href="images/manifest.json" />
<style>
	body { overflow: hidden; padding: 0; }
	div.picker { z-index: 10007; }
	#artifact-modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 1000000;
		background: rgba(0, 0, 0, 0.55);
		display: none;
		align-items: center;
		justify-content: center;
	}
	#artifact-modal {
		width: min(420px, calc(100vw - 48px));
		background: #252526;
		color: #ddd;
		border: 1px solid #555;
		border-radius: 8px;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
		font: 13px system-ui, sans-serif;
		padding: 16px;
	}
	#artifact-modal h2 { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
	#artifact-modal p { margin: 0 0 10px; color: #aaa; }
	#artifact-modal input {
		width: 100%;
		box-sizing: border-box;
		background: #1e1e1e;
		color: #ddd;
		border: 1px solid #666;
		border-radius: 4px;
		padding: 7px 8px;
	}
	#artifact-modal-error { min-height: 18px; margin-top: 6px; color: #ff8080; }
	#artifact-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
	#artifact-modal button {
		background: #333;
		color: #ddd;
		border: 1px solid #666;
		border-radius: 4px;
		padding: 5px 12px;
		cursor: pointer;
	}
	#artifact-modal button.primary { background: #0e639c; border-color: #1177bb; color: white; }
	.geSidebarContainer .geTitle input { font-size: 8pt; color: #606060; }
	.geBlock { z-index: -3; margin: 100px; margin-top: 40px; margin-bottom: 30px; padding: 20px; text-align: center; min-width: 50%; }
	.geBlock h1, .geBlock h2 { margin-top: 0; padding-top: 0; }
</style>
<script>
	const instanceId = ${JSON.stringify(instanceId)};
	let editorUi;
	let lastDirty = false;
	let currentArtifactName = "";

	function sendBackend(path, body) {
		return fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	function cellLabel(cell) {
		if (cell.value == null) return "";
		if (typeof cell.value === "string") return cell.value;
		if (cell.value.nodeType === 1) return cell.value.getAttribute("label") || cell.value.textContent || "";
		return String(cell.value);
	}

	function summarizeCell(cell) {
		const geometry = cell.geometry ? {
			x: cell.geometry.x,
			y: cell.geometry.y,
			width: cell.geometry.width,
			height: cell.geometry.height,
			relative: cell.geometry.relative,
		} : null;
		return {
			id: cell.id,
			kind: cell.edge ? "edge" : cell.vertex ? "vertex" : cell.children?.length ? "group" : "cell",
			label: cellLabel(cell),
			style: cell.style || "",
			geometry,
			source: cell.source?.id,
			target: cell.target?.id,
		};
	}

	function buildEditorState(eventMsg) {
		const graph = editorUi?.editor?.graph;
		const selection = graph ? graph.getSelectionCells().filter((c) => c?.id && c.id !== "0" && c.id !== "1") : [];
		return {
			diagram: {
				title: document.title || "draw.io",
				dirty: lastDirty,
			},
			selection: {
				ids: selection.map((c) => c.id),
				elements: selection.map(summarizeCell),
			},
			viewport: graph ? {
				zoom: graph.view.scale,
				scrollX: graph.container?.scrollLeft ?? 0,
				scrollY: graph.container?.scrollTop ?? 0,
				pageVisible: eventMsg?.pageVisible ?? graph.pageVisible,
				currentPage: eventMsg?.currentPage,
				bounds: eventMsg?.bounds,
				page: eventMsg?.page,
			} : null,
		};
	}

	async function exportXmlFromEditor() {
		return await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				window.removeEventListener("drawio-message", handler);
				reject(new Error("Timed out exporting XML"));
			}, 5000);
			function handler(event) {
				let msg;
				try { msg = typeof event.data === "string" ? JSON.parse(event.data) : event.data; } catch { return; }
				if (msg.event !== "export") return;
				clearTimeout(timeout);
				window.removeEventListener("drawio-message", handler);
				resolve(msg.xml ?? msg.data);
			}
			window.addEventListener("drawio-message", handler);
			window.postMessage(JSON.stringify({ action: "export", format: "xml" }), "*");
		});
	}

	async function saveToArtifact(artifactName, { moveExisting = false } = {}) {
		const xml = await exportXmlFromEditor();
		const result = await (await sendBackend("/artifact", { instanceId, artifactName, xml, moveExisting })).json();
		if (!result.ok) throw new Error(result.error || "Save failed");
		currentArtifactName = result.artifactName;
		document.title = result.title || "draw.io";
		lastDirty = false;
		return result;
	}

	function askArtifactName(message, defaultName) {
		return new Promise((resolve) => {
			const backdrop = document.getElementById("artifact-modal-backdrop");
			const title = document.getElementById("artifact-modal-title");
			const input = document.getElementById("artifact-modal-input");
			const error = document.getElementById("artifact-modal-error");
			const ok = document.getElementById("artifact-modal-ok");
			const cancel = document.getElementById("artifact-modal-cancel");
			title.textContent = message;
			input.value = defaultName || currentArtifactName || "diagram.drawio";
			error.textContent = "";
			backdrop.style.display = "flex";
			input.focus();
			input.select();
			const cleanup = (value) => {
				backdrop.style.display = "none";
				ok.onclick = null;
				cancel.onclick = null;
				input.onkeydown = null;
				resolve(value);
			};
			const submit = () => {
				const value = input.value.trim();
				if (!value) {
					error.textContent = "Enter an artifact filename.";
					return;
				}
				if (value.includes("/") || value.includes("\\\\") || value === "." || value === "..") {
					error.textContent = "Use a filename only, not a path.";
					return;
				}
				cleanup(value);
			};
			ok.onclick = submit;
			cancel.onclick = () => cleanup(null);
			input.onkeydown = (event) => {
				if (event.key === "Enter") submit();
				if (event.key === "Escape") cleanup(null);
			};
		});
	}

	async function saveArtifact() {
		const artifactName = currentArtifactName || await askArtifactName("Save artifact filename", "diagram.drawio");
		if (!artifactName) return;
		const result = await saveToArtifact(artifactName);
		editorUi?.editor?.setStatus?.("Autosaving to " + result.artifactName);
	}

	async function saveAsArtifact() {
		const artifactName = await askArtifactName("Save as artifact filename", currentArtifactName || "diagram.drawio");
		if (!artifactName) return;
		const result = await saveToArtifact(artifactName);
		editorUi?.editor?.setStatus?.("Autosaving to " + result.artifactName);
	}

	function installArtifactFileMenu(ui) {
		const fileMenu = ui?.menus?.get?.("file");
		if (!fileMenu || fileMenu.__artifactMenuInstalled) return;
		fileMenu.__artifactMenuInstalled = true;
		const original = fileMenu.funct;
		fileMenu.funct = function(menu, parent) {
			if (typeof original === "function") {
				original.apply(this, arguments);
			}
			if (typeof menu.addSeparator === "function") {
				menu.addSeparator(parent);
			}
			menu.addItem("Save", null, () => {
				saveArtifact().catch((e) => alert(String(e.message || e)));
			}, parent);
			menu.addItem("Save as...", null, () => {
				saveAsArtifact().catch((e) => alert(String(e.message || e)));
			}, parent);
		};
	}

	const vscodeBridge = {
		postMessage(msg) {
			window.dispatchEvent(new MessageEvent("drawio-message", { data: msg }));
		},
	};

	Object.defineProperty(window, "mxIsElectron", { value: false });
	Object.defineProperty(document, "cookie", { value: "" });
	Object.defineProperty(window, "opener", {
		value: { postMessage(msg) { vscodeBridge.postMessage(msg); } },
	});

	const storage = {};
	Object.defineProperty(window, "localStorage", {
		value: {
			getItem(key) { return storage[key]; },
			setItem(key, val) { storage[key] = String(val); },
			removeItem(key) { delete storage[key]; },
		},
	});

	window.addEventListener("message", (evt) => {
		if (evt.source === window.opener) return;
		let evtData = evt.data;
		let dataObj;
		try { dataObj = typeof evtData === "string" ? JSON.parse(evtData) : evtData; } catch {}
		if (dataObj?.action === "export" && editorUi?.fileNode) {
			const scale = Number.parseFloat(editorUi.fileNode.getAttribute("scale"));
			if (!Number.isNaN(scale)) dataObj.scale = scale;
			const border = Number.parseFloat(editorUi.fileNode.getAttribute("border"));
			if (!Number.isNaN(border)) dataObj.border = border;
			evtData = JSON.stringify(dataObj);
		}

		const fakedEvt = new Event("message");
		fakedEvt.source = window.opener;
		fakedEvt.data = evtData;
		const origFocus = window.focus;
		window.focus = function () {};
		try {
			window.dispatchEvent(fakedEvt);
		} finally {
			window.focus = origFocus;
		}
		evt.stopPropagation();
		evt.preventDefault();
	});

	const appearance = 1;
	const theme = "dark";
	const urlParams = {
		embed: "1",
		configure: "1",
		proto: "json",
		ui: theme,
		dark: "1",
		lang: "en",
		noSaveBtn: "1",
		noExitBtn: "1",
		chrome: "1",
	};

	function mxscript(src, onLoad, id, dataAppKey, noWrite) {
		if (onLoad != null || noWrite) {
			const s = document.createElement("script");
			s.setAttribute("type", "text/javascript");
			s.setAttribute("src", src);
			if (id != null) s.setAttribute("id", id);
			if (dataAppKey != null) s.setAttribute("data-app-key", dataAppKey);
			if (onLoad != null) {
				let r = false;
				s.onload = s.onreadystatechange = function () {
					if (!r && (!this.readyState || this.readyState === "complete")) {
						r = true;
						onLoad();
					}
				};
			}
			const t = document.getElementsByTagName("script")[0];
			t.parentNode.insertBefore(s, t);
		} else {
			document.write('<script src="' + src + '"' + (id != null ? ' id="' + id + '" ' : "") + (dataAppKey != null ? ' data-app-key="' + dataAppKey + '" ' : "") + "></scr" + "ipt>");
		}
	}

	function mxinclude(src) {
		const g = document.createElement("script");
		g.type = "text/javascript";
		g.async = true;
		g.src = src;
		const s = document.getElementsByTagName("script")[0];
		s.parentNode.insertBefore(g, s);
	}
</script>
<script src="js/PreConfig.js"></script>
<script src="js/app.min.js"></script>
<script src="js/extensions.min.js"></script>
<script src="js/stencils.min.js"></script>
<script src="js/shapes-14-6-5.min.js"></script>
<script src="js/PostConfig.js"></script>
</head>
<body class="geEditor">
<div id="artifact-modal-backdrop">
	<div id="artifact-modal" role="dialog" aria-modal="true" aria-labelledby="artifact-modal-title">
		<h2 id="artifact-modal-title">Save artifact filename</h2>
		<p>Saved diagrams are stored in this session's artifacts.</p>
		<input id="artifact-modal-input" autocomplete="off" spellcheck="false" />
		<div id="artifact-modal-error"></div>
		<div id="artifact-modal-actions">
			<button id="artifact-modal-cancel" type="button">Cancel</button>
			<button id="artifact-modal-ok" class="primary" type="button">Save</button>
		</div>
	</div>
</div>
<div id="geInfo">
	<div class="geBlock" style="text-align: center; min-width: 50%">
		<h1>Flowchart Maker and Online Diagram Software</h1>
		<p>diagrams.net is loading from local bundled assets.</p>
		<h2 id="geStatus">Loading...</h2>
	</div>
</div>
<script>
	function patchFn(clazz, fnName, fnFactory) {
		const old = clazz[fnName];
		clazz[fnName] = fnFactory(old);
	}

	window.addEventListener("drawio-message", async (event) => {
		let msg;
		try { msg = typeof event.data === "string" ? JSON.parse(event.data) : event.data; } catch { return; }
		if (msg.event === "configure") {
			window.postMessage(JSON.stringify({
				action: "configure",
				config: { compressXml: false, defaultLibraries: "general", libraries: "general", ui: "dark" },
			}), "*");
		} else if (msg.event === "init") {
			const r = await fetch("/state?instanceId=" + encodeURIComponent(instanceId));
			const { xml, artifactName, title } = await r.json();
			currentArtifactName = artifactName || "";
			document.title = currentArtifactName ? title : "Untitled diagram (unsaved)";
			window.postMessage(JSON.stringify({ action: "load", xml, autosave: 1 }), "*");
		} else if (msg.event === "autosave" || msg.event === "save") {
			lastDirty = msg.event === "autosave";
			await sendBackend("/state", { instanceId, xml: msg.xml, editorState: buildEditorState(msg) });
		} else if (msg.event === "export") {
			await sendBackend("/iframe-reply", {
				instanceId,
				requestId: msg.message && msg.message.requestId,
				kind: "export",
				format: msg.format,
				content: msg.xml ?? msg.data,
				xml: msg.xml,
				data: msg.data,
				editorState: buildEditorState(msg),
			});
		}
	});

	patchFn(Menus.prototype, "addSubmenu", (old) => function (...args) {
		if (args[0] === "exportAs" || args[0] === "importFrom") return;
		return old.apply(this, args);
	});
	patchFn(Menus.prototype, "addMenuItem", (old) => function (...args) {
		if (["print", "save", "saveAs", "saveAndExit", "plugins", "exit"].includes(args[1])) return;
		return old.apply(this, args);
	});
	Menus.prototype.defaultMenuItems = Menus.prototype.defaultMenuItems.filter((i) => i !== "help");
	patchFn(Menus.prototype, "put", (old) => function (...args) {
		if (["language", "help"].includes(args[0])) return args[1];
		return old.apply(this, args);
	});
	EditorUi.prototype.addEmbedButtons = () => {};
	patchFn(EditorUi.prototype, "init", (old) => function (...args) {
		editorUi = this;
		window.editorUi = this;
		const result = old.apply(this, args);
		installArtifactFileMenu(this);
		if (currentArtifactName) {
			this.editor?.setStatus?.("Autosaving to " + currentArtifactName);
		} else {
			this.editor?.setStatus?.("Unsaved diagram");
		}
		return result;
	});
	mxUrlConverter.prototype.baseUrl = "/drawio/";
	mxUrlConverter.prototype.updateBaseUrl = function () {
		this.baseDomain = location.origin;
		this.baseUrl = "/drawio/";
	};
	mxUrlConverter.prototype.isRelativeUrl = function (url) {
		return url != null && !/^(\\/\\/|[a-zA-Z][a-zA-Z\\d+\\-.]*:)/.test(url);
	};
	App.main();

	const sse = new EventSource("/events?instanceId=" + encodeURIComponent(instanceId));
	sse.onmessage = async (e) => {
		const cmd = JSON.parse(e.data);
		if (cmd.type === "load") {
			window.postMessage(JSON.stringify({ action: "load", xml: cmd.xml, autosave: 1 }), "*");
		} else if (cmd.type === "export") {
			window.postMessage(JSON.stringify({ action: "export", format: cmd.format, message: { requestId: cmd.requestId } }), "*");
		} else if (cmd.type === "editor_state") {
			await sendBackend("/iframe-reply", {
				instanceId,
				requestId: cmd.requestId,
				kind: "editor_state",
				editorState: buildEditorState(),
			});
		} else if (cmd.type === "page_title") {
			await sendBackend("/iframe-reply", {
				instanceId,
				requestId: cmd.requestId,
				kind: "page_title",
				title: document.title,
			});
		}
	};
</script>
</body>
</html>`;
}

async function serveFile(reqPath, res) {
	const decoded = decodeURIComponent(reqPath);
	const relative = decoded.replace(/^\/drawio\/?/, "");
	const filePath = path.resolve(WEBAPP_DIR, relative || "index.html");
	if (!filePath.startsWith(WEBAPP_DIR + path.sep)) {
		res.writeHead(403).end("forbidden");
		return;
	}
	try {
		const st = await stat(filePath);
		if (!st.isFile()) {
			res.writeHead(404).end("not found");
			return;
		}
		res.writeHead(200, { "content-type": mimeTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream" });
		createReadStream(filePath).pipe(res);
	} catch {
		res.writeHead(404).end("not found");
	}
}

let server;
let baseUrl;

async function ensureServer() {
	if (baseUrl) return baseUrl;
	server = http.createServer(async (req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const instanceId = url.searchParams.get("instanceId");

		try {
			if (req.method === "GET" && url.pathname === "/") {
				if (!instanceId) {
					res.writeHead(400).end("instanceId required");
					return;
				}
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(renderIndexHtml(instanceId));
				return;
			}

			if (req.method === "GET" && url.pathname === "/state") {
				const inst = getInstance(instanceId);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ xml: inst.xml, title: inst.title, filePath: inst.filePath, artifactName: inst.artifactName }));
				return;
			}

			if (req.method === "POST" && url.pathname === "/state") {
				const body = await readJsonBody(req);
				const inst = getInstance(body.instanceId);
				if (typeof body.xml === "string") {
					inst.xml = body.xml;
					await writeDiagramFile(inst, body.xml);
				}
				if (typeof body.title === "string") inst.title = body.title;
				if (body.editorState && typeof body.editorState === "object") inst.editorState = body.editorState;
				res.writeHead(204).end();
				return;
			}

			if (req.method === "POST" && url.pathname === "/artifact") {
				const body = await readJsonBody(req);
				const inst = getInstance(body.instanceId);
				if (typeof body.xml === "string") inst.xml = body.xml;
				const result = await bindArtifactFile(inst, body.artifactName, { moveExisting: body.moveExisting === true });
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, ...result }));
				return;
			}

			if (req.method === "POST" && url.pathname === "/file") {
				const body = await readJsonBody(req);
				const inst = getInstance(body.instanceId);
				if (typeof body.xml === "string") inst.xml = body.xml;
				const result = await bindDiagramFile(inst, body.path, { moveExisting: body.moveExisting === true });
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, ...result }));
				return;
			}

			if (req.method === "GET" && url.pathname === "/events") {
				const inst = getInstance(instanceId);
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				res.write(": connected\n\n");
				inst.sseClients.add(res);
				req.on("close", () => inst.sseClients.delete(res));
				return;
			}

			if (req.method === "POST" && url.pathname === "/iframe-reply") {
				const body = await readJsonBody(req);
				const inst = getInstance(body.instanceId);
				let pendingId = body.requestId;
				let pending = pendingId && inst.pending.get(pendingId);
				if (!pending && body.kind) {
					const candidates = [...inst.pending.entries()].filter(([, value]) => value.kind === body.kind);
					if (candidates.length === 1) {
						[pendingId, pending] = candidates[0];
					}
				}
				if (pending) {
					clearTimeout(pending.timer);
					inst.pending.delete(pendingId);
					if (body.editorState && typeof body.editorState === "object") inst.editorState = body.editorState;
					pending.resolve(body);
				}
				res.writeHead(204).end();
				return;
			}

			if (req.method === "GET" && url.pathname.startsWith("/drawio/")) {
				await serveFile(url.pathname, res);
				return;
			}

			res.writeHead(404).end("not found");
		} catch (e) {
			res.writeHead(500, { "content-type": "text/plain" });
			res.end(String(e && e.message || e));
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	baseUrl = `http://127.0.0.1:${port}`;
	return baseUrl;
}

const canvas = createCanvas({
	id: "drawio",
	displayName: "draw.io",
	description: "Edit diagrams.net diagrams through a stateful offline draw.io editor using XML-first actions.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			xml: { type: "string", description: "Optional initial mxGraphModel or mxfile XML to load." },
			artifactName: { type: "string", description: "Optional artifact filename under the session files directory, for example architecture.drawio." },
			path: { type: "string", description: "Optional .drawio file path to read from and autosave back to." },
			autosave: { type: "boolean", description: "When path is set, write editor autosaves and set_diagram changes back to the file. Defaults to true." },
			title: { type: "string", description: "Optional diagram title." },
			readOnly: { type: "boolean", description: "Whether to open the diagram in read-only mode." },
			theme: { enum: ["auto", "light", "dark"], description: "Initial editor theme preference." },
		},
	},
	actions: [
		{
			name: "get_editor_state",
			description: "Return high-level editor context: current title, dirty state, selection, and viewport metadata.",
			inputSchema: { type: "object", additionalProperties: false, properties: {} },
			async handler({ instanceId }) {
				const inst = instances.get(instanceId);
				if (!inst) throw new CanvasError("not_found", `Unknown instance ${instanceId}`);
				if (inst.sseClients.size > 0) {
					const result = await pushToEditor(inst, { type: "editor_state" }, "editor_state");
					return result.editorState ?? inst.editorState;
				}
				return inst.editorState;
			},
		},
		{
			name: "set_diagram",
			description: "Replace the current draw.io diagram with complete mxGraphModel or mxfile XML.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["xml"],
				properties: {
					xml: { type: "string", description: "Complete mxGraphModel or mxfile XML to load." },
					title: { type: "string" },
					path: { type: "string", description: "Optional .drawio file path to associate with this diagram." },
					autosave: { type: "boolean", description: "Whether to write the diagram XML to the associated file. Defaults to the instance setting." },
				},
			},
			async handler({ instanceId, input }) {
				const inst = getInstance(instanceId);
				if (typeof input.path === "string") {
					inst.filePath = resolveDiagramPath(input.path);
					inst.title = input.title ?? path.basename(inst.filePath);
				}
				if (typeof input.autosave === "boolean") inst.autosave = input.autosave;
				inst.xml = input.xml;
				if (typeof input.title === "string") inst.title = input.title;
				await writeDiagramFile(inst, input.xml);
				inst.editorState = {
					...inst.editorState,
					diagram: { ...inst.editorState.diagram, title: inst.title, dirty: false },
				};
				pushToEditor(inst, { type: "load", xml: input.xml });
				return { ok: true };
			},
		},
		{
			name: "export_diagram",
			description: "Export the current diagram as XML, SVG, SVG with embedded XML, PNG, or PNG with embedded XML.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["format"],
				properties: {
					format: {
						enum: ["xml", "svg", "xmlsvg", "png", "xmlpng"],
						description: "Export format. Use xml to inspect or patch the diagram model.",
					},
				},
			},
			async handler({ instanceId, input }) {
				const inst = instances.get(instanceId);
				if (!inst) throw new CanvasError("not_found", `Unknown instance ${instanceId}`);
				const result = await pushToEditor(inst, { type: "export", format: input.format }, "export");
				return {
					format: result.format || input.format,
					content: result.content,
				};
			},
		},
		{
			name: "get_page_title",
			description: "Return the current document.title inside the draw.io iframe.",
			inputSchema: { type: "object", additionalProperties: false, properties: {} },
			async handler({ instanceId }) {
				const inst = instances.get(instanceId);
				if (!inst) throw new CanvasError("not_found", `Unknown instance ${instanceId}`);
				const result = await pushToEditor(inst, { type: "page_title" }, "page_title");
				return { title: result.title };
			},
		},
	],
	async open({ instanceId, input }) {
		const url = await ensureServer();
		const inst = getInstance(instanceId);
		if (input && typeof input.artifactName === "string") {
			const { artifactName, filePath } = resolveArtifactPath(input.artifactName);
			inst.artifactName = artifactName;
			inst.filePath = filePath;
			inst.title = artifactName;
			if (typeof input.autosave === "boolean") inst.autosave = input.autosave;
			if (await fileExists(filePath)) {
				inst.xml = await readFile(filePath, "utf8");
			}
		}
		if (input && typeof input.path === "string") {
			inst.filePath = resolveDiagramPath(input.path);
			inst.artifactName = null;
			inst.title = path.basename(inst.filePath);
			if (typeof input.autosave === "boolean") inst.autosave = input.autosave;
			if (await fileExists(inst.filePath)) {
				inst.xml = await readFile(inst.filePath, "utf8");
			}
		}
		if (input && typeof input.xml === "string") {
			inst.xml = input.xml;
			await writeDiagramFile(inst, input.xml);
		}
		if (input && typeof input.title === "string") {
			inst.title = input.title;
			inst.editorState = { ...inst.editorState, diagram: { ...inst.editorState.diagram, title: input.title } };
		} else {
			inst.editorState = { ...inst.editorState, diagram: { ...inst.editorState.diagram, title: inst.title } };
		}
		return {
			url: `${url}/?instanceId=${encodeURIComponent(instanceId)}`,
			title: inst.title || "draw.io",
			status: "ready",
		};
	},
	onClose({ instanceId }) {
		const inst = instances.get(instanceId);
		if (!inst) return;
		for (const res of inst.sseClients) {
			try { res.end(); } catch {}
		}
		instances.delete(instanceId);
	},
});

const session = await joinSession({ canvases: [canvas] });
artifactsDir = session.workspacePath ? path.join(session.workspacePath, "files") : undefined;
if (artifactsDir) {
	await mkdir(artifactsDir, { recursive: true });
}
