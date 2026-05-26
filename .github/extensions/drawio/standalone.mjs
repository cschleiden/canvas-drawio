import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP_DIR = path.join(__dirname, "drawio-webapp");

const BLANK_XML = `<mxfile><diagram id="blank" name="Page-1"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`;

const state = { xml: BLANK_XML };

const html = `<!doctype html>
<html>
<head>
<base href="/drawio/index.html" />
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<title>draw.io offline</title>
<link rel="stylesheet" type="text/css" href="styles/grapheditor.css" />
<link rel="stylesheet" media="(forced-colors: active)" href="styles/high-contrast.css" id="high-contrast-stylesheet" />
<link rel="manifest" href="images/manifest.json" />
<style>
	body { overflow: hidden; padding: 0; }
	div.picker { z-index: 10007; }
	.geSidebarContainer .geTitle input { font-size: 8pt; color: #606060; }
	.geBlock { z-index: -3; margin: 100px; margin-top: 40px; margin-bottom: 30px; padding: 20px; text-align: center; min-width: 50%; }
	.geBlock h1, .geBlock h2 { margin-top: 0; padding-top: 0; }
</style>
<script>
	let editorUi;
	window.__drawioMessages = [];
	window.__drawioErrors = [];
	window.addEventListener("error", (event) => {
		window.__drawioErrors.push({
			message: event.message,
			filename: event.filename,
			lineno: event.lineno,
			colno: event.colno
		});
	});
	const vscodeBridge = {
		postMessage(msg) {
			window.__drawioMessages.push(msg);
			window.dispatchEvent(new MessageEvent("drawio-message", { data: msg }));
		}
	};

	Object.defineProperty(window, "mxIsElectron", { value: false });
	Object.defineProperty(document, "cookie", { value: "" });
	Object.defineProperty(window, "opener", {
		value: {
			postMessage(msg) {
				vscodeBridge.postMessage(msg);
			}
		}
	});

	const storage = {};
	Object.defineProperty(window, "localStorage", {
		value: {
			getItem(key) { return storage[key]; },
			setItem(key, val) { storage[key] = String(val); },
			removeItem(key) { delete storage[key]; }
		}
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
		chrome: "1"
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
				config: {
					compressXml: false,
					defaultLibraries: "general",
					libraries: "general",
					ui: "dark"
				}
			}), "*");
		} else if (msg.event === "init") {
			const r = await fetch("/state");
			const { xml } = await r.json();
			window.postMessage(JSON.stringify({ action: "load", xml, autosave: 1 }), "*");
		} else if (msg.event === "autosave" || msg.event === "save") {
			await fetch("/state", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ xml: msg.xml })
			});
		}
	});

	patchFn(Menus.prototype, "addSubmenu", (old) => function (...args) {
		if (args[0] === "exportAs" || args[0] === "importFrom") return;
		return old.apply(this, args);
	});

	patchFn(Menus.prototype, "addMenuItem", (old) => function (...args) {
		if (["print", "saveAndExit", "plugins", "exit"].includes(args[1])) return;
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
		return old.apply(this, args);
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
</script>
</body>
</html>`;

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
	[".ttf", "font/ttf"]
]);

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

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://127.0.0.1");
	if (req.method === "GET" && url.pathname === "/") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		return res.end(html);
	}
	if (req.method === "GET" && url.pathname === "/state") {
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify({ xml: state.xml }));
	}
	if (req.method === "POST" && url.pathname === "/state") {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
		if (typeof body.xml === "string") state.xml = body.xml;
		res.writeHead(204).end();
		return;
	}
	if (req.method === "GET" && url.pathname.startsWith("/drawio/")) {
		return serveFile(url.pathname, res);
	}
	res.writeHead(404).end("not found");
});

server.listen(0, "127.0.0.1", () => {
	const { port } = server.address();
	console.log(`http://127.0.0.1:${port}/`);
});
