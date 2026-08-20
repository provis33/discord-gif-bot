import { exec, execFile } from "node:child_process";
import { existsSync, watch, createReadStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { createStore } from "./store.js";

const execFileAsync = promisify(execFile);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendNotFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}

function streamFile(res, filePath, mime, cache = true) {
  res.writeHead(200, {
    "Content-Type": mime,
    "Cache-Control": cache ? "public, max-age=86400" : "no-store",
  });
  createReadStream(filePath).pipe(res);
}

function readBody(req, limit = 8000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

async function copyToWindowsClipboard(filePath) {
  const escaped = filePath.replace(/'/g, "''");
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-STA", "-Command", `Set-Clipboard -LiteralPath '${escaped}'`],
    { windowsHide: true },
  );
}

export async function startGallery({ root, libraryDir, port = 3456, openBrowser = true, store }) {
  const publicDir = path.join(root, "public");
  const storeRef = store || createStore(libraryDir);
  await mkdir(libraryDir, { recursive: true });

  const live = new Set();
  let debounce;

  function ping() {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      for (const client of live) {
        client.write(`data: refresh\n\n`);
      }
    }, 200);
  }

  watch(libraryDir, ping);

  let publicUrl = "";

  function setPublicUrl(url) {
    publicUrl = url || "";
    ping();
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    try {
      if (url.pathname === "/api/gifs") {
        const query = url.searchParams.get("q") || "";
        const items = await storeRef.searchList(query);
        sendJson(
          res,
          items.map((item) => ({
            ...item,
            url: `/library/${encodeURIComponent(item.name)}`,
          })),
        );
        return;
      }

      if (url.pathname === "/api/tunnel") {
        sendJson(res, { url: publicUrl });
        return;
      }

      if (url.pathname === "/api/stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        res.write("data: hello\n\n");
        live.add(res);
        req.on("close", () => live.delete(res));
        return;
      }

      if (url.pathname === "/api/copy" && req.method === "POST") {
        const body = await readBody(req);
        const file = storeRef.filePath(body.name || "");
        if (!file || !existsSync(file) || !file.toLowerCase().endsWith(".gif")) {
          sendJson(res, { ok: false }, 404);
          return;
        }
        await copyToWindowsClipboard(file);
        sendJson(res, { ok: true });
        return;
      }

      if (url.pathname === "/api/favorite" && req.method === "POST") {
        const body = await readBody(req);
        const file = storeRef.filePath(body.name || "");
        if (!file || !file.toLowerCase().endsWith(".gif")) {
          sendJson(res, { ok: false }, 400);
          return;
        }
        const favorite = await storeRef.setFavorite(path.basename(file), !!body.on);
        ping();
        sendJson(res, { ok: true, favorite });
        return;
      }

      if (url.pathname.startsWith("/library/")) {
        const name = decodeURIComponent(url.pathname.slice("/library/".length));
        const file = storeRef.filePath(name);
        if (!file || !existsSync(file) || !file.toLowerCase().endsWith(".gif")) {
          sendNotFound(res);
          return;
        }
        streamFile(res, file, "image/gif", false);
        return;
      }

      const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = path.resolve(publicDir, relative);
      if (!file.startsWith(path.resolve(publicDir)) || !existsSync(file)) {
        sendNotFound(res);
        return;
      }

      const ext = path.extname(file).toLowerCase();
      const mime = MIME[ext] || "application/octet-stream";
      if (ext === ".html") {
        const html = await readFile(file);
        res.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control": "no-store",
          "Content-Length": html.length,
        });
        res.end(html);
        return;
      }

      streamFile(res, file, mime);
    } catch (err) {
      console.error(err);
      sendJson(res, { ok: false }, 500);
    }
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const href = `http://127.0.0.1:${port}`;
  console.log(`Галерея у тебя на ПК: ${href}`);

  if (openBrowser) {
    exec(`cmd /c start "" "${href}"`);
  }

  return { setPublicUrl };
}
