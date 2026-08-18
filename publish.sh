#!/usr/bin/env bash
# ==========================================================================
#  Публикация сайта на GitHub Pages.
#
#  Запускать из папки сайта:   ./publish.sh
#  Первый запуск заведёт репозиторий и отправит всё в main,
#  дальше просто отправляет изменения.
#
#  Что уйдёт в репозиторий, решает .gitignore: разметка, стили, скрипты,
#  переводы и только те картинки, которые реально просит страница.
# ==========================================================================
set -euo pipefail
cd "$(dirname "$0")"

REMOTE="https://github.com/nisonengineer-lab/engineer-against-dementia.net.git"
MSG="${1:-Обновление сайта}"

command -v git >/dev/null || { echo "git не установлен"; exit 1; }

if [ ! -d .git ]; then
  echo "→ Создаю репозиторий"
  git init -q -b main
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "→ Подключаю origin"
  git remote add origin "$REMOTE"
else
  git remote set-url origin "$REMOTE"
fi

echo "→ Что уйдёт:"
git add -A
git status --short | sed 's/^/   /'

if git diff --cached --quiet; then
  echo "→ Изменений нет, отправлять нечего"
  exit 0
fi

git commit -q -m "$MSG"
echo "→ Отправляю в main"
git push -u origin main

cat <<'DONE'

Готово. Дальше один раз в настройках репозитория:

  Settings → Pages → Build and deployment
      Source: Deploy from a branch
      Branch: main   /(root)   → Save

Файл CNAME уже лежит в корне, поэтому домен подставится сам.
Через пару минут проверить: https://engineeragainstdementia.net
DONE
