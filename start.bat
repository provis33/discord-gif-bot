@echo off
chcp 65001 >nul
title GIF бот
cd /d "%~dp0"

echo Бот и галерея запускаются. Это окно не закрывай.
echo Галерея у тебя: http://127.0.0.1:3456
echo Ссылка для друзей появится здесь. С телефонов лучше открывать в Chrome, не внутри Discord.
echo Чтобы выключить — просто закрой окно.
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo Не найден Node.js. Поставь его с https://nodejs.org и нажми любую клавишу.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Первый запуск: ставлю нужные файлы...
  call npm install
  echo.
)

node bot.js
echo.
echo Бот остановился.
pause
