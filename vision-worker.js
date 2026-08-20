import { createVision } from "./vision.js";

const vision = createVision({
  root: process.env.VISION_ROOT,
  libraryDir: process.env.VISION_LIBRARY,
});

process.on("message", async (msg) => {
  try {
    if (msg.op === "backfill") {
      await vision.backfill();
      process.send({ id: msg.id, ok: true });
      return;
    }
    if (msg.op === "index") {
      await vision.enqueueIndex(msg.name);
      process.send({ id: msg.id, ok: true });
      return;
    }
    if (msg.op === "search") {
      const items = await vision.search(msg.query, msg.items);
      process.send({ id: msg.id, ok: true, items });
    }
  } catch (err) {
    process.send({ id: msg.id, ok: false, error: err.message || String(err) });
  }
});
