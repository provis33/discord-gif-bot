import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

function jsonFile(libraryDir, name) {
  return path.join(libraryDir, name);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function niceName(name) {
  return String(name)
    .replace(/\.gif$/i, "")
    .replace(/^\d{4}-\d{2}-\d{2}T[\d-]+_/, "")
    .replaceAll("_", " ");
}

export function createStore(libraryDir, vision = null) {
  const favFile = jsonFile(libraryDir, "favorites.json");
  const msgFile = jsonFile(libraryDir, "messages.json");
  const root = path.resolve(libraryDir);

  function filePath(name) {
    const full = path.resolve(libraryDir, path.basename(name || ""));
    if (!full.startsWith(root)) return null;
    return full;
  }

  async function readFavorites() {
    const data = await readJson(favFile, []);
    return Array.isArray(data) ? data.filter((item) => typeof item === "string") : [];
  }

  async function setFavorite(name, on) {
    const base = path.basename(name);
    const favs = new Set(await readFavorites());
    if (on) favs.add(base);
    else favs.delete(base);
    await writeFile(favFile, JSON.stringify([...favs], null, 2));
    return favs.has(base);
  }

  async function listGifs() {
    if (!existsSync(libraryDir)) return [];
    const favs = new Set(await readFavorites());
    const names = await readdir(libraryDir);
    const items = [];

    for (const name of names) {
      if (!name.toLowerCase().endsWith(".gif")) continue;
      const full = path.join(libraryDir, name);
      try {
        const info = await stat(full);
        if (!info.isFile()) continue;
        items.push({
          name,
          added: info.mtimeMs,
          favorite: favs.has(name),
        });
      } catch {
        // файл могли удалить пока читали папку
      }
    }

    items.sort((a, b) => b.added - a.added);
    return items;
  }

  async function pickGif({ query = "", favoritesOnly = false, exclude = "" } = {}) {
    const q = query.trim().toLowerCase();
    let list = await listGifs();
    if (favoritesOnly) list = list.filter((item) => item.favorite);
    if (q) {
      if (vision) {
        list = await vision.search(q, list);
      } else {
        list = list.filter(
          (item) =>
            niceName(item.name).toLowerCase().includes(q) || item.name.toLowerCase().includes(q),
        );
      }
      if (!list.length) return null;
      const pool = exclude ? list.filter((item) => item.name !== exclude) : list;
      const use = pool.length ? pool : list;
      return use[0];
    }
    const pool = exclude ? list.filter((item) => item.name !== exclude) : list;
    const use = pool.length ? pool : list;
    if (!use.length) return null;
    return use[Math.floor(Math.random() * use.length)];
  }

  async function rememberMessage(id, filename) {
    if (!id || !filename) return;
    const map = await readJson(msgFile, {});
    map[id] = path.basename(filename);
    const keys = Object.keys(map);
    if (keys.length > 4000) {
      for (const key of keys.slice(0, keys.length - 4000)) delete map[key];
    }
    await writeFile(msgFile, JSON.stringify(map));
  }

  async function filenameForMessage(id) {
    const map = await readJson(msgFile, {});
    return map[id] || null;
  }

  function safeName(value) {
    return String(value || "user")
      .replace(/[^\w.-]+/g, "_")
      .slice(0, 40);
  }

  async function saveGif(buffer, author, originalName) {
    await mkdir(libraryDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const base = path.parse(originalName || "image").name;
    const filename = `${stamp}_${safeName(author)}_${safeName(base)}.gif`;
    const fullPath = path.join(libraryDir, filename);
    await writeFile(fullPath, buffer);
    return fullPath;
  }

  async function searchList(query, favoritesOnly = false) {
    let list = await listGifs();
    if (favoritesOnly) list = list.filter((item) => item.favorite);
    const q = query.trim();
    if (!q) return list;
    if (vision) return vision.search(q, list);
    const needle = q.toLowerCase();
    return list.filter(
      (item) =>
        niceName(item.name).toLowerCase().includes(needle) || item.name.toLowerCase().includes(needle),
    );
  }

  return {
    filePath,
    listGifs,
    searchList,
    setFavorite,
    pickGif,
    rememberMessage,
    filenameForMessage,
    saveGif,
  };
}
