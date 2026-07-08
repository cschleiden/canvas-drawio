import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_WEBAPP_DIR = path.join(__dirname, "drawio-webapp");
const ASSET_MANIFEST = JSON.parse(await readFile(path.join(__dirname, "assets-manifest.json"), "utf8"));
const COPILOT_HOME = process.env.COPILOT_HOME || path.join(homedir(), ".copilot");
const ASSET_CACHE_ROOT = path.join(COPILOT_HOME, "extensions", "drawio", "artifacts", "drawio-webapp");
const ASSET_CACHE_DIR = path.join(ASSET_CACHE_ROOT, ASSET_MANIFEST.version);
const ASSET_COMPLETE_FILE = path.join(ASSET_CACHE_DIR, ".complete.json");
let artifactsDir;
let session;

const BLANK_XML = `<mxfile><diagram id="blank" name="Page-1"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`;

const instances = new Map();
const assetSseClients = new Set();
const assetState = {
	status: "idle",
	message: "draw.io assets are not installed yet.",
	error: null,
	webappDir: null,
	promise: null,
};

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

function assetPayload() {
	return {
		status: assetState.status,
		message: assetState.message,
		error: assetState.error,
		version: ASSET_MANIFEST.version,
		downloadUrl: process.env.DRAWIO_ASSET_URL || ASSET_MANIFEST.downloadUrl,
	};
}

function notifyAssetClients() {
	const payload = `data: ${JSON.stringify(assetPayload())}\n\n`;
	for (const res of assetSseClients) {
		try {
			res.write(payload);
		} catch {}
	}
}

function updateAssetState(status, message, error = null) {
	assetState.status = status;
	assetState.message = message;
	assetState.error = error;
	notifyAssetClients();
}

async function directoryHasWebapp(dir) {
	try {
		const [index, app, styles] = await Promise.all([
			stat(path.join(dir, "index.html")),
			stat(path.join(dir, "js", "app.min.js")),
			stat(path.join(dir, "styles", "grapheditor.css")),
		]);
		return index.isFile() && app.isFile() && styles.isFile();
	} catch {
		return false;
	}
}

async function cacheIsComplete() {
	if (!await directoryHasWebapp(ASSET_CACHE_DIR)) return false;
	try {
		const complete = JSON.parse(await readFile(ASSET_COMPLETE_FILE, "utf8"));
		return complete.version === ASSET_MANIFEST.version && complete.sha256 === ASSET_MANIFEST.sha256;
	} catch {
		return false;
	}
}

async function getReadyWebappDir() {
	if (assetState.webappDir && await directoryHasWebapp(assetState.webappDir)) {
		return assetState.webappDir;
	}
	if (await cacheIsComplete()) {
		assetState.webappDir = ASSET_CACHE_DIR;
		updateAssetState("ready", "draw.io assets are installed.");
		return assetState.webappDir;
	}
	if (await directoryHasWebapp(BUNDLED_WEBAPP_DIR)) {
		assetState.webappDir = BUNDLED_WEBAPP_DIR;
		updateAssetState("ready", "Using bundled draw.io assets.");
		return assetState.webappDir;
	}
	return null;
}

function hashStream() {
	const hash = createHash("sha256");
	const stream = new Transform({
		transform(chunk, encoding, callback) {
			hash.update(chunk);
			callback(null, chunk);
		},
	});
	return { stream, digest: () => hash.digest("hex") };
}

async function downloadAssetArchive(targetPath) {
	const url = process.env.DRAWIO_ASSET_URL || ASSET_MANIFEST.downloadUrl;
	const { stream, digest } = hashStream();
	if (url.startsWith("file://")) {
		await pipeline(createReadStream(fileURLToPath(url)), stream, createWriteStream(targetPath));
	} else {
		const response = await fetch(url);
		if (!response.ok || !response.body) {
			throw new Error(`Failed to download draw.io assets from ${url}: HTTP ${response.status}`);
		}
		await pipeline(Readable.fromWeb(response.body), stream, createWriteStream(targetPath));
	}
	const actualSha256 = digest();
	if (actualSha256 !== ASSET_MANIFEST.sha256) {
		throw new Error(`Downloaded draw.io assets checksum mismatch. Expected ${ASSET_MANIFEST.sha256}, got ${actualSha256}.`);
	}
}

function tarString(buffer, start, length) {
	return buffer.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
}

function stripArchiveRoot(name) {
	const archiveRoot = ASSET_MANIFEST.archiveRoot || "";
	const normalized = name.replace(/\\/g, "/").replace(/^\.\/+/, "");
	if (!archiveRoot) return normalized;
	if (normalized === archiveRoot) return "";
	if (normalized.startsWith(`${archiveRoot}/`)) return normalized.slice(archiveRoot.length + 1);
	return normalized;
}

function parsePaxHeaders(buffer) {
	const headers = {};
	let text = buffer.toString("utf8");
	while (text.length > 0) {
		const space = text.indexOf(" ");
		if (space <= 0) break;
		const length = Number.parseInt(text.slice(0, space), 10);
		if (!Number.isFinite(length) || length <= space + 1 || length > text.length) break;
		const record = text.slice(space + 1, length - 1);
		const equals = record.indexOf("=");
		if (equals > 0) headers[record.slice(0, equals)] = record.slice(equals + 1);
		text = text.slice(length);
	}
	return headers;
}

async function extractTarGz(archivePath, outputDir) {
	const chunks = [];
	await pipeline(
		createReadStream(archivePath),
		createGunzip(),
		new Transform({
			transform(chunk, encoding, callback) {
				chunks.push(chunk);
				callback();
			},
		}),
	);
	const tar = Buffer.concat(chunks);
	let paxHeaders = {};
	for (let offset = 0; offset + 512 <= tar.length;) {
		let name = tarString(tar, offset, 100);
		if (!name) break;
		const sizeText = tarString(tar, offset + 124, 12).trim();
		const size = Number.parseInt(sizeText || "0", 8);
		const type = tarString(tar, offset + 156, 1) || "0";
		const contentOffset = offset + 512;
		const content = tar.subarray(contentOffset, contentOffset + size);
		if (type === "x") {
			paxHeaders = parsePaxHeaders(content);
			offset = contentOffset + Math.ceil(size / 512) * 512;
			continue;
		}
		if (paxHeaders.path) name = paxHeaders.path;
		paxHeaders = {};
		const relative = stripArchiveRoot(name);
		if (relative && !relative.startsWith("../") && !path.isAbsolute(relative)) {
			const outputPath = path.resolve(outputDir, relative);
			const relativeOutput = path.relative(outputDir, outputPath);
			if (!relativeOutput.startsWith("..") && !path.isAbsolute(relativeOutput)) {
				if (type === "5") {
					await mkdir(outputPath, { recursive: true });
				} else if (type === "0" || type === "") {
					await mkdir(path.dirname(outputPath), { recursive: true });
					await writeFile(outputPath, content);
				}
			}
		}
		offset = contentOffset + Math.ceil(size / 512) * 512;
	}
}

async function installAssets() {
	if (await getReadyWebappDir()) return assetState.webappDir;
	if (assetState.promise) return assetState.promise;
	assetState.promise = (async () => {
		updateAssetState("downloading", "Downloading draw.io assets...");
		await mkdir(ASSET_CACHE_ROOT, { recursive: true });
		const tmpDir = path.join(ASSET_CACHE_ROOT, `.tmp-${process.pid}-${Date.now()}`);
		const archivePath = path.join(tmpDir, ASSET_MANIFEST.archiveName);
		await rm(tmpDir, { recursive: true, force: true });
		await mkdir(tmpDir, { recursive: true });
		try {
			await downloadAssetArchive(archivePath);
			updateAssetState("extracting", "Extracting draw.io assets...");
			const extractDir = path.join(tmpDir, "extract");
			await mkdir(extractDir, { recursive: true });
			await extractTarGz(archivePath, extractDir);
			if (!await directoryHasWebapp(extractDir)) {
				throw new Error("Downloaded archive did not contain a valid draw.io webapp.");
			}
			await rm(ASSET_CACHE_DIR, { recursive: true, force: true });
			await rename(extractDir, ASSET_CACHE_DIR);
			await writeFile(ASSET_COMPLETE_FILE, JSON.stringify({
				version: ASSET_MANIFEST.version,
				sha256: ASSET_MANIFEST.sha256,
				installedAt: new Date().toISOString(),
				source: process.env.DRAWIO_ASSET_URL || ASSET_MANIFEST.downloadUrl,
			}, null, 2));
			assetState.webappDir = ASSET_CACHE_DIR;
			updateAssetState("ready", "draw.io assets are installed.");
			return assetState.webappDir;
		} catch (error) {
			updateAssetState("failed", "Failed to install draw.io assets.", String(error?.message || error));
			throw error;
		} finally {
			assetState.promise = null;
			await rm(tmpDir, { recursive: true, force: true });
		}
	})();
	return assetState.promise;
}

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
			extensionId: null,
			canvasId: "drawio",
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

function currentOpenInput(inst) {
	const input = { title: inst.title, xml: inst.xml, autosave: inst.autosave };
	if (inst.artifactName) return { artifactName: inst.artifactName, ...input };
	if (inst.filePath) return { path: inst.filePath, ...input };
	return { title: inst.title };
}
async function refreshCanvasChrome(inst) {
	const request = {
		canvasId: inst.canvasId || "drawio",
		instanceId: inst.instanceId,
		input: currentOpenInput(inst),
	};
	if (inst.extensionId) request.extensionId = inst.extensionId;
	await session.rpc.canvas.open(request);
}

function queueCanvasChromeRefresh(inst) {
	setTimeout(() => {
		refreshCanvasChrome(inst).catch((error) => {
			session.log(`Failed to refresh draw.io canvas title: ${error?.message || error}`, { level: "warning", ephemeral: true });
		});
	}, 0);
}

function renderAssetLoadingHtml(instanceId) {
	const payload = assetPayload();
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Installing draw.io assets</title>
<style>
	:root { color-scheme: dark; }
	body {
		margin: 0;
		min-height: 100vh;
		display: grid;
		place-items: center;
		background: #1e1e1e;
		color: #ddd;
		font: 13px system-ui, sans-serif;
	}
	main {
		width: min(520px, calc(100vw - 48px));
		background: #252526;
		border: 1px solid #444;
		border-radius: 8px;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
		padding: 20px;
	}
	h1 { margin: 0 0 10px; font-size: 18px; }
	p { margin: 8px 0; color: #bbb; line-height: 1.45; }
	code { color: #ddd; overflow-wrap: anywhere; }
	button {
		margin-top: 14px;
		background: #0e639c;
		border: 1px solid #1177bb;
		border-radius: 4px;
		color: white;
		cursor: pointer;
		padding: 6px 12px;
	}
	#error { color: #ff8a8a; white-space: pre-wrap; }
</style>
</head>
<body>
<main>
	<h1>Installing draw.io assets</h1>
	<p id="message"></p>
	<p>Version: <code>${escapeHtml(ASSET_MANIFEST.version)}</code></p>
	<p id="error"></p>
	<button id="retry" type="button" hidden>Retry download</button>
</main>
<script>
	const initial = ${JSON.stringify(payload)};
	const message = document.getElementById("message");
	const error = document.getElementById("error");
	const retry = document.getElementById("retry");
	function render(state) {
		message.textContent = state.message || "Preparing draw.io assets...";
		error.textContent = state.error || "";
		retry.hidden = state.status !== "failed";
		if (state.status === "ready") {
			location.replace("/?instanceId=${encodeURIComponent(instanceId)}");
		}
	}
	render(initial);
	new EventSource("/asset-events").onmessage = (event) => render(JSON.parse(event.data));
	retry.onclick = async () => {
		retry.hidden = true;
		await fetch("/asset-retry", { method: "POST" });
	};
</script>
</body>
</html>`;
}

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
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
	let currentFilePath = "";
	let currentSavedTitle = "";
	let hasBackingFile = false;
	let currentAutosave = true;

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
	function syncFileState(state) {
		currentArtifactName = state.artifactName || "";
		currentFilePath = state.filePath || "";
		currentSavedTitle = state.title || currentArtifactName || currentFilePath.split(/[\\\\/]/).pop() || "";
		hasBackingFile = Boolean(currentArtifactName || currentFilePath);
		if ("autosave" in state) currentAutosave = state.autosave !== false;
		document.title = hasBackingFile ? currentSavedTitle : "Untitled diagram (unsaved)";
	}
	function markEditorSaved(title) {
		currentSavedTitle = title || currentSavedTitle || currentArtifactName || "draw.io";
		document.title = currentSavedTitle;
		lastDirty = false;
		editorUi?.editor?.setFilename?.(currentSavedTitle);
		editorUi?.editor?.setModified?.(false);
		const file = editorUi?.getCurrentFile?.();
		if (file) {
			if (currentSavedTitle && typeof file.rename === "function" && file.getTitle?.() !== currentSavedTitle) {
				try {
					file.rename(currentSavedTitle, () => {}, () => {});
				} catch {
					if ("title" in file) file.title = currentSavedTitle;
					file.descriptorChanged?.();
				}
			} else if (currentSavedTitle && "title" in file && file.title !== currentSavedTitle) {
				file.title = currentSavedTitle;
				file.descriptorChanged?.();
			}
			file.setShadowModified?.(false);
			file.setModified?.(false);
		}
		editorUi?.updateDocumentTitle?.();
		document.title = currentSavedTitle;
		editorUi?.editor?.setStatus?.("Autosaving to " + currentSavedTitle);
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
		syncFileState({ artifactName: result.artifactName, filePath: result.path, title: result.title });
		markEditorSaved(result.title);
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
			const state = await r.json();
			const { xml } = state;
			syncFileState(state);
			window.postMessage(JSON.stringify({ action: "load", xml, autosave: 1 }), "*");
			if (hasBackingFile) {
				setTimeout(() => markEditorSaved(currentSavedTitle), 0);
			}
		} else if (msg.event === "autosave" || msg.event === "save") {
			lastDirty = !(hasBackingFile && currentAutosave);
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
		if (hasBackingFile) {
			setTimeout(() => markEditorSaved(currentSavedTitle), 0);
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
			syncFileState(cmd);
			window.postMessage(JSON.stringify({ action: "load", xml: cmd.xml, autosave: 1 }), "*");
			if (cmd.saved === false) {
				lastDirty = true;
			} else if (hasBackingFile) {
				setTimeout(() => markEditorSaved(currentSavedTitle), 0);
			}
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
	const webappDir = await getReadyWebappDir();
	if (!webappDir) {
		res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("draw.io assets are not installed yet");
		return;
	}
	const decoded = decodeURIComponent(reqPath);
	const relative = decoded.replace(/^\/drawio\/?/, "");
	const filePath = path.resolve(webappDir, relative || "index.html");
	const relativePath = path.relative(webappDir, filePath);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
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
				if (await getReadyWebappDir()) {
					res.end(renderIndexHtml(instanceId));
				} else {
					installAssets().catch((error) => {
						session?.log?.(`Failed to install draw.io assets: ${error?.message || error}`, { level: "warning", ephemeral: true });
					});
					res.end(renderAssetLoadingHtml(instanceId));
				}
				return;
			}

			if (req.method === "GET" && url.pathname === "/asset-state") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(assetPayload()));
				return;
			}

			if (req.method === "GET" && url.pathname === "/asset-events") {
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				res.write(`data: ${JSON.stringify(assetPayload())}\n\n`);
				assetSseClients.add(res);
				req.on("close", () => assetSseClients.delete(res));
				return;
			}

			if (req.method === "POST" && url.pathname === "/asset-retry") {
				installAssets().catch((error) => {
					session?.log?.(`Failed to install draw.io assets: ${error?.message || error}`, { level: "warning", ephemeral: true });
				});
				res.writeHead(202, { "content-type": "application/json" });
				res.end(JSON.stringify(assetPayload()));
				return;
			}

			if (req.method === "GET" && url.pathname === "/state") {
				const inst = getInstance(instanceId);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ xml: inst.xml, title: inst.title, filePath: inst.filePath, artifactName: inst.artifactName, autosave: inst.autosave }));
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
				queueCanvasChromeRefresh(inst);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, ...result }));
				return;
			}

			if (req.method === "POST" && url.pathname === "/file") {
				const body = await readJsonBody(req);
				const inst = getInstance(body.instanceId);
				if (typeof body.xml === "string") inst.xml = body.xml;
				const result = await bindDiagramFile(inst, body.path, { moveExisting: body.moveExisting === true });
				queueCanvasChromeRefresh(inst);
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
					inst.artifactName = null;
					inst.title = input.title ?? path.basename(inst.filePath);
				}
				if (typeof input.autosave === "boolean") inst.autosave = input.autosave;
				inst.xml = input.xml;
				if (typeof input.title === "string") inst.title = input.title;
				await writeDiagramFile(inst, input.xml);
				const saved = Boolean(inst.filePath && inst.autosave !== false);
				inst.editorState = {
					...inst.editorState,
					diagram: { ...inst.editorState.diagram, title: inst.title, dirty: !saved },
				};
				pushToEditor(inst, { type: "load", xml: input.xml, title: inst.title, filePath: inst.filePath, artifactName: inst.artifactName, autosave: inst.autosave, saved });
				queueCanvasChromeRefresh(inst);
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
	async open({ extensionId, canvasId, instanceId, input }) {
		const url = await ensureServer();
		const assetsReady = Boolean(await getReadyWebappDir());
		if (!assetsReady) {
			installAssets().catch((error) => {
				session?.log?.(`Failed to install draw.io assets: ${error?.message || error}`, { level: "warning", ephemeral: true });
			});
		}
		const inst = getInstance(instanceId);
		inst.extensionId = extensionId;
		inst.canvasId = canvasId;
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
			status: assetsReady ? "ready" : "installing draw.io assets",
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

session = await joinSession({ canvases: [canvas] });
artifactsDir = session.workspacePath ? path.join(session.workspacePath, "files") : undefined;
if (artifactsDir) {
	await mkdir(artifactsDir, { recursive: true });
}
