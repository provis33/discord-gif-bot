import { execFile, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INDEX_VERSION = 2;
const STOP = new Set([
  "не",
  "ну",
  "да",
  "же",
  "бы",
  "ли",
  "это",
  "как",
  "что",
  "вот",
  "уже",
  "на",
  "по",
  "от",
  "за",
  "из",
  "для",
  "и",
  "а",
  "но",
  "the",
  "a",
  "an",
  "to",
  "of",
  "in",
  "on",
]);

function compact(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function norm(text) {
  return compact(text)
    .replaceAll("ё", "е")
    .replace(/[^a-z0-9а-я]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text) {
  return [...new Set(norm(text).split(" ").filter(Boolean))];
}

function queryWords(query) {
  const all = tokens(query);
  const key = all.filter((word) => word.length >= 3 && !STOP.has(word));
  return key.length ? key : all.filter((word) => word.length >= 2);
}

function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[b.length];
}

function wordHit(word, hayNorm, hayToks) {
  if (!word || !hayNorm) return 0;
  if (hayNorm.includes(word)) return 1;
  for (const tok of hayToks) {
    if (tok === word) return 1;
    const maxLen = Math.max(word.length, tok.length);
    if (maxLen < 5 || Math.abs(word.length - tok.length) > 2) continue;
    const dist = lev(word, tok);
    if (dist <= 1) return 0.85;
    if (maxLen >= 7 && dist <= 2) return 0.7;
  }
  return 0;
}

function textScore(query, hay) {
  const qNorm = norm(query);
  const hayNorm = norm(hay);
  if (!qNorm || !hayNorm) return 0;
  if (hayNorm.includes(qNorm)) return 12;

  const words = queryWords(query);
  if (!words.length) return 0;
  const hayToks = tokens(hay);

  let hits = 0;
  let weight = 0;
  let longHit = false;
  for (const word of words) {
    const hit = wordHit(word, hayNorm, hayToks);
    if (!hit) continue;
    hits += 1;
    weight += hit;
    if (word.length >= 5) longHit = true;
  }

  const ratio = hits / words.length;
  if (!hits) return 0;
  if (words.length === 1) return 5 + weight;
  if (ratio >= 1) return 6 + weight;
  if (longHit && ratio >= 0.5) return 4 + weight;
  return 0;
}

export function createVision({ root, libraryDir }) {
  const dataDir = path.join(root, "data");
  const indexFile = path.join(dataDir, "vision.json");
  const modelsDir = path.join(root, "models");

  let ready = null;
  let ocr = null;
  let captioner = null;
  let chain = Promise.resolve();

  async function readIndex() {
    try {
      const data = JSON.parse(await readFile(indexFile, "utf8"));
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  async function writeIndex(data) {
    await mkdir(dataDir, { recursive: true });
    const tmp = `${indexFile}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, indexFile);
  }

  async function ensure() {
    if (ready) return ready;
    ready = (async () => {
      console.log("Готовлю чтение текста с картинок.");
      const { createWorker } = await import("tesseract.js");
      const { env, pipeline } = await import("@xenova/transformers");
      env.cacheDir = modelsDir;
      env.allowLocalModels = true;

      ocr = await createWorker("rus+eng");
      captioner = await pipeline("image-to-text", "Xenova/vit-gpt2-image-captioning", {
        quantized: true,
      });
      console.log("Чтение текста готово.");
    })();
    return ready;
  }

  async function toPngs(gifPath) {
    const stamp = path.basename(gifPath).replace(/[^\w.-]/g, "");
    const colorPath = path.join(os.tmpdir(), `vision-c-${stamp}.png`);
    const inkPath = path.join(os.tmpdir(), `vision-i-${stamp}.png`);
    const script = `
      import sharp from "sharp";
      const img = sharp(${JSON.stringify(gifPath)}, { animated: false, failOn: "none" }).rotate();
      const big = img.resize({ width: 1800, height: 1800, fit: "inside" });
      await big.clone().png().toFile(${JSON.stringify(colorPath)});
      await big.clone().greyscale().normalize().sharpen().png().toFile(${JSON.stringify(inkPath)});
    `;
    await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      windowsHide: true,
    });
    return [colorPath, inkPath];
  }

  async function readText(pngPath) {
    await ocr.setParameters({ tessedit_pageseg_mode: "6" });
    const block = await ocr.recognize(pngPath);
    await ocr.setParameters({ tessedit_pageseg_mode: "11" });
    const sparse = await ocr.recognize(pngPath);
    return compact(`${block?.data?.text || ""} ${sparse?.data?.text || ""}`);
  }

  async function indexGif(name) {
    const gifPath = path.join(libraryDir, path.basename(name));
    if (!existsSync(gifPath)) return;
    await ensure();
    console.log("Читаю текст:", path.basename(name));
    const pngs = await toPngs(gifPath);
    try {
      const capRes = await captioner(pngs[0]).catch(() => []);
      const parts = [];
      for (const png of pngs) {
        parts.push(await readText(png));
      }
      const text = compact(parts.join(" "));
      const caption = compact(capRes?.[0]?.generated_text || "");
      const idx = await readIndex();
      idx[path.basename(name)] = { v: INDEX_VERSION, text, caption };
      await writeIndex(idx);
    } finally {
      await Promise.all(pngs.map((png) => unlink(png).catch(() => {})));
    }
  }

  function enqueueIndex(name) {
    chain = chain.then(() => indexGif(name)).catch((err) => {
      console.error("Не проиндексировал гифку:", err.message || err);
    });
    return chain;
  }

  async function search(query, items) {
    const q = compact(query);
    if (!q) return items;
    const idx = await readIndex();
    const cyrillic = /[а-яё]/i.test(q);

    const ranked = items
      .map((item) => {
        const rec = idx[item.name] || {};
        const ocrScore = textScore(q, rec.text || "");
        const capScore = cyrillic ? 0 : textScore(q, rec.caption || "");
        return { item, score: Math.max(ocrScore, capScore * 0.6) };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score);

    return ranked.map((row) => row.item);
  }

  async function backfill() {
    if (!existsSync(libraryDir)) return;
    const names = (await readdir(libraryDir)).filter((name) => name.toLowerCase().endsWith(".gif"));
    const idx = await readIndex();
    for (const name of names) {
      if (idx[name]?.v === INDEX_VERSION) continue;
      await enqueueIndex(name);
    }
  }

  return { enqueueIndex, search, backfill };
}

export function createVisionClient({ root, libraryDir }) {
  const worker = fork(fileURLToPath(new URL("./vision-worker.js", import.meta.url)), [], {
    env: { ...process.env, VISION_ROOT: root, VISION_LIBRARY: libraryDir },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  let nextId = 0;
  const pending = new Map();

  worker.on("message", (msg) => {
    const job = pending.get(msg.id);
    if (!job) return;
    pending.delete(msg.id);
    if (msg.ok) job.resolve(msg.items);
    else job.reject(new Error(msg.error || "vision error"));
  });

  worker.on("exit", (code) => {
    console.error("Поиск по картинкам остановился:", code);
    for (const job of pending.values()) job.reject(new Error("vision worker exit"));
    pending.clear();
  });

  function call(payload) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.send({ ...payload, id });
    });
  }

  return {
    enqueueIndex(name) {
      call({ op: "index", name }).catch((err) => {
        console.error("Не проиндексировал гифку:", err.message);
      });
    },
    async search(query, items) {
      try {
        return (await call({ op: "search", query, items })) || [];
      } catch (err) {
        console.error("Поиск по картинке:", err.message);
        return [];
      }
    },
    backfill() {
      return call({ op: "backfill" }).catch((err) => {
        console.error("Индекс картинок:", err.message);
      });
    },
  };
}
