import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DOWNLOAD =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

async function ensureCloudflared(root) {
  const dir = path.join(root, "bin");
  const exe = path.join(dir, "cloudflared.exe");
  if (existsSync(exe)) return exe;

  await mkdir(dir, { recursive: true });
  console.log("Скачиваю туннель, один раз. Это ненадолго...");
  const res = await fetch(DOWNLOAD, { redirect: "follow" });
  if (!res.ok) throw new Error(`не скачался туннель (${res.status})`);
  await writeFile(exe, Buffer.from(await res.arrayBuffer()));
  return exe;
}

function watchUrl(child, regex, onUrl) {
  const look = (buf) => {
    const text = buf.toString();
    const match = text.match(regex);
    if (match) onUrl(match[0]);
  };
  child.stdout.on("data", look);
  child.stderr.on("data", look);
}

function startCloudflare({ root, port }) {
  return new Promise((resolve, reject) => {
    let done = false;

    ensureCloudflared(root)
      .then((exe) => {
        const child = spawn(
          exe,
          [
            "tunnel",
            "--url",
            `http://127.0.0.1:${port}`,
            "--no-autoupdate",
            "--edge-ip-version",
            "4",
          ],
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );

        watchUrl(child, /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i, (url) => {
          if (done) return;
          done = true;
          resolve({ url, child });
        });

        child.on("error", (err) => {
          if (!done) reject(err);
        });
        child.on("exit", (code) => {
          if (!done) reject(new Error(`cloudflare закрылся (${code})`));
        });

        const stop = () => {
          try {
            child.kill();
          } catch {
            // уже закрыт
          }
        };
        process.on("exit", stop);
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      })
      .catch(reject);

    setTimeout(() => {
      if (!done) reject(new Error("cloudflare не ответил"));
    }, 45000);
  });
}

function startPhoneTunnel({ port, onUrl }) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const launch = () => {
      const child = spawn(
        "ssh",
        [
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=NUL",
          "-o",
          "ServerAliveInterval=30",
          "-o",
          "ExitOnForwardFailure=yes",
          "-R",
          `80:127.0.0.1:${port}`,
          "nokey@localhost.run",
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );

      watchUrl(child, /https:\/\/[a-z0-9]+\.lhr\.life/i, (url) => {
        onUrl?.(url);
        if (!settled) {
          settled = true;
          resolve({ url, child });
        }
      });

      child.on("error", (err) => {
        if (!settled) reject(err);
      });

      child.on("exit", () => {
        setTimeout(launch, 4000);
      });

      const stop = () => {
        try {
          child.kill();
        } catch {
          // уже закрыт
        }
      };
      process.on("exit", stop);
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    };

    launch();
    setTimeout(() => {
      if (!settled) reject(new Error("телефонный туннель не ответил"));
    }, 25000);
  });
}

export async function startTunnel({ root, port, onUrl }) {
  const urls = { phone: "", cloudflare: "" };

  const publish = () => {
    const primary = urls.phone || urls.cloudflare;
    if (primary) onUrl?.(primary);
  };

  const phone = startPhoneTunnel({
    port,
    onUrl: (url) => {
      urls.phone = url;
      console.log(`Для телефонов: ${url}`);
      publish();
    },
  }).catch((err) => {
    console.error("Телефонный туннель не поднялся:", err.message);
    return null;
  });

  const cloudflare = startCloudflare({ root, port })
    .then((result) => {
      urls.cloudflare = result.url;
      console.log(`Запасная ссылка: ${result.url}`);
      publish();
      return result;
    })
    .catch((err) => {
      console.error("Cloudflare туннель:", err.message);
      return null;
    });

  await Promise.all([phone, cloudflare]);
  const url = urls.phone || urls.cloudflare;
  if (!url) throw new Error("туннель не поднялся");
  return { url, urls };
}
