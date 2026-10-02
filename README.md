# Discord GIF bot

Кидаешь фото в канал `GIF`  бот отвечает GIF-файлом, сохраняет копию в `library` и показывает её на локальном сайте http://127.0.0.1:3456

## Запуск

1. Создай приложение на https://discord.com/developers/applications
2. Bot → Reset Token → скопируй токен
3. Bot → Privileged Gateway Intents → включи **Message Content Intent**
4. OAuth2 → URL Generator:
   - Scopes: `bot`
   - Permissions: View Channels, Send Messages, Attach Files, Read Message History
5. Открой ссылку и добавь бота на свой сервер
6. Скопируй `.env.example` в `.env` и вставь токен
7. `npm install`
8. Двойной клик по ярлыку **GIF бот** или `start.bat`

Канал должен называться `GIF` (можно сменить в `.env`).
Ярлык сразу включает бота и открывает галерею.

## Запуск

1. Создай приложение на https://discord.com/developers/applications
2. Bot → Reset Token → скопируй токен
3. Bot → Privileged Gateway Intents → включи **Message Content Intent**
4. OAuth2 → URL Generator:
   - Scopes: `bot`
   - Permissions: View Channels, Send Messages, Attach Files, Read Message History
5. Открой ссылку и добавь бота на свой сервер
6. Скопируй `.env.example` в `.env` и вставь токен
7. `npm install`
8. `npm start` или двойной клик по `start.bat`

Канал должен называться `GIF` (можно сменить в `.env`).
