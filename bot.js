import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
} from "discord.js";
import dotenv from "dotenv";
import sharp from "sharp";
import { startGallery } from "./gallery.js";
import { createStore } from "./store.js";
import { startTunnel } from "./tunnel.js";
import { createVisionClient } from "./vision.js";

dotenv.config();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LIBRARY_DIR = path.join(ROOT, "library");
const CHANNEL_NAME = (process.env.CHANNEL_NAME || "GIF").toLowerCase();
const MAX_SIDE = 1280;
const MAX_PHOTOS = 10;
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|tiff?)$/i;
const vision = createVisionClient({ root: ROOT, libraryDir: LIBRARY_DIR });
const store = createStore(LIBRARY_DIR, vision);

const commands = [
  new SlashCommandBuilder()
    .setName("gif")
    .setDescription("Случайная гифка из архива")
    .addStringOption((option) =>
      option.setName("поиск").setDescription("слово, если ищешь конкретную").setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("fav")
    .setDescription("Гифка из избранного"),
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});

function isGif({ name, contentType, url }) {
  const type = (contentType || "").toLowerCase();
  const file = (name || "").toLowerCase();
  const link = (url || "").toLowerCase();
  return type.includes("gif") || file.endsWith(".gif") || link.includes(".gif");
}

function isImage({ name, contentType }) {
  const type = (contentType || "").toLowerCase();
  const file = (name || "").toLowerCase();
  return type.startsWith("image/") || IMAGE_EXT.test(file);
}

function collectImages(message) {
  const items = [];

  for (const att of message.attachments.values()) {
    if (!isImage(att) && !isGif(att)) continue;
    items.push({
      url: att.url,
      name: att.name || "image.png",
      contentType: att.contentType || "",
    });
  }

  if (!items.length) {
    for (const embed of message.embeds) {
      const url = embed.image?.url || embed.thumbnail?.url;
      if (!url) continue;
      items.push({
        url,
        name: "embed.png",
        contentType: "",
      });
    }
  }

  return items.slice(0, MAX_PHOTOS);
}

async function toGif(buffer) {
  let image = sharp(buffer, { animated: false, failOn: "none" }).rotate();
  const meta = await image.metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;

  if (width > MAX_SIDE || height > MAX_SIDE) {
    image = image.resize({
      width: MAX_SIDE,
      height: MAX_SIDE,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  return image.gif({ effort: 4 }).toBuffer();
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function gifButtons(mode, query = "") {
  const q = encodeURIComponent(query).slice(0, 70);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`again:${mode}:${q}`)
      .setLabel("ещё")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("star").setLabel("★").setStyle(ButtonStyle.Secondary),
  );
}

function gifFile(item) {
  return new AttachmentBuilder(store.filePath(item.name), { name: "meme.gif" });
}

async function sendPicked(interaction, { query, favoritesOnly, exclude }) {
  const item = await store.pickGif({ query, favoritesOnly, exclude });
  if (!item) {
    const text = favoritesOnly
      ? "В избранном пусто. Нажми ★ под гифкой."
      : query
        ? "Такой гифки нет."
        : "Архив пустой. Кинь фото в канал gif.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: text, files: [], components: [] });
    } else {
      await interaction.reply({ content: text, ephemeral: true });
    }
    return;
  }

  const payload = {
    content: "",
    files: [gifFile(item)],
    components: [gifButtons(favoritesOnly ? "fav" : "all", query)],
  };

  const msg =
    interaction.deferred || interaction.replied
      ? await interaction.editReply(payload)
      : await interaction.reply(payload);
  await store.rememberMessage(msg.id, item.name);
}

async function registerCommands() {
  for (const guild of client.guilds.cache.values()) {
    await guild.commands.set(commands);
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Бот запущен как ${readyClient.user.tag}`);
  console.log(`Слушаю канал: ${process.env.CHANNEL_NAME || "GIF"}`);
  try {
    await registerCommands();
    console.log("Команды Discord: /gif  /fav");
  } catch (err) {
    console.error("Не удалось повесить команды. Открой ссылку с applications.commands:", err);
  }
  vision.backfill().catch((err) => {
    console.error("Индекс картинок:", err.message || err);
  });
});

client.on(Events.GuildCreate, async (guild) => {
  try {
    await guild.commands.set(commands);
  } catch (err) {
    console.error("Команды на новом сервере не поставились:", err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const query = interaction.options.getString("поиск") || "";
      const favoritesOnly = interaction.commandName === "fav";
      await interaction.deferReply();
      await sendPicked(interaction, { query, favoritesOnly });
      return;
    }

    if (!interaction.isButton()) return;

    if (interaction.customId === "star") {
      await interaction.deferReply({ ephemeral: true });
      const name = await store.filenameForMessage(interaction.message.id);
      if (!name) {
        await interaction.editReply("Не понял, какая это гифка.");
        return;
      }
      const current = (await store.listGifs()).find((item) => item.name === name);
      const favorite = await store.setFavorite(name, !current?.favorite);
      await interaction.editReply(favorite ? "В избранном." : "Убрал из избранного.");
      return;
    }

    if (interaction.customId.startsWith("again:")) {
      const parts = interaction.customId.split(":");
      const mode = parts[1] || "all";
      const query = decodeURIComponent(parts.slice(2).join(":") || "");
      await interaction.deferUpdate();
      const current = await store.filenameForMessage(interaction.message.id);
      await sendPicked(interaction, {
        query,
        favoritesOnly: mode === "fav",
        exclude: current,
      });
    }
  } catch (err) {
    console.error("Команда не сработала:", err);
  }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.emoji.name !== "⭐") return;
    const name = await store.filenameForMessage(reaction.message.id);
    if (!name) return;
    await store.setFavorite(name, true);
  } catch (err) {
    console.error("Реакция не сохранилась:", err);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channel.name?.toLowerCase() !== CHANNEL_NAME) return;

  const images = collectImages(message);
  if (!images.length) return;

  const files = [];
  const saved = [];
  let failed = 0;

  try {
    await message.channel.sendTyping();
  } catch {
    // канал мог быть недоступен для индикатора печати
  }

  for (const image of images) {
    try {
      if (isGif(image)) continue;

      const source = await download(image.url);
      const gif = await toGif(source);
      const fullPath = await store.saveGif(gif, message.author.username, image.name);
      saved.push(path.basename(fullPath));
      vision.enqueueIndex(path.basename(fullPath));
      files.push(
        new AttachmentBuilder(gif, {
          name: `${path.parse(image.name).name || "image"}.gif`,
        }),
      );
    } catch (err) {
      failed += 1;
      console.error("Не удалось конвертировать:", err);
    }
  }

  if (!files.length) {
    if (failed) {
      try {
        await message.reply("Не смог сделать GIF из этих картинок.");
      } catch {
        // если и ответ не ушёл — просто пишем в консоль
      }
    }
    return;
  }

  try {
    const reply = await message.reply({
      files,
      components: files.length === 1 ? [gifButtons("all")] : [],
      allowedMentions: { repliedUser: false },
    });
    if (saved.length === 1) await store.rememberMessage(reply.id, saved[0]);
  } catch (err) {
    console.error("Не смог отправить GIF:", err);
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error("Нет DISCORD_TOKEN. Скопируй .env.example в .env и вставь токен.");
  process.exit(1);
}

const galleryPort = Number(process.env.GALLERY_PORT || 3456);
const gallery = await startGallery({
  root: ROOT,
  libraryDir: LIBRARY_DIR,
  port: galleryPort,
  store,
});

if (process.env.GALLERY_TUNNEL !== "0") {
  try {
    console.log("Открываю ссылку для друзей...");
    const tunnel = await startTunnel({
      root: ROOT,
      port: galleryPort,
      onUrl: gallery.setPublicUrl,
    });
    console.log(`Скинь друзьям (телефоны): ${tunnel.url}`);
  } catch (err) {
    console.error("Туннель не поднялся. Сайт пока только у тебя на ПК:", err.message);
  }
}

client.login(process.env.DISCORD_TOKEN);
