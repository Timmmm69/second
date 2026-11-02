# «Вещи» — Telegram Mini App, версия 1.2

Магазин **новых** вещей: единичные остатки, бесплатная бронь с примеркой, заявки в отделения Белпочты/Европочты и мобильная работа сотрудников. React/TypeScript/Vite, Fastify, PostgreSQL, Sharp. API и worker — процессы одного приложения. Платежи, касса и почтовые кабинеты работают вне Mini App.

Репозиторий: [Timmmm69/second](https://github.com/Timmmm69/second), ветка `codex/miniapp-v1.2`, [pull request №1](https://github.com/Timmmm69/second/pull/1). Главная ветка инициализирована по разрешению владельца.

Исходная согласованная спецификация, дизайн-система и макеты находятся в `reference/`. Трассировка требований — [docs/coverage.md](docs/coverage.md); фактические результаты — [docs/verification.md](docs/verification.md). Проверка реального Telegram и публикация отделены от локальных тестов.

Итог локальной проверки: **60/60 тестов на настоящей PostgreSQL**, TypeScript/lint/build проходят. [GitHub Actions](https://github.com/Timmmm69/second/actions/runs/41428213058) также прошёл на PostgreSQL 16 и 17: по 59 успешных тестов, один opt-in тест перезапуска пропущен. Ключевой сценарий покупателя и сотрудника проверен в браузере. Снимки: [docs/screenshots/mobile-review.jpg](docs/screenshots/mobile-review.jpg). Реальные Telegram iOS/Android и целевой VPS остаются отдельной приёмкой.

## Локальный запуск

Нужны Node.js 24 LTS, npm и PostgreSQL 17 (допускается поддерживаемая PostgreSQL с совместимой схемой). Docker — удобный вариант для локальной БД, приложение можно запустить обычными процессами.

```bash
npm ci
docker compose -f infra/compose.dev.yaml up -d
```

Создайте локальную конфигурацию в `.env` (не добавляйте её в git):

```dotenv
APP_MODE=local
NODE_ENV=development
DATABASE_URL=postgresql://veshi_dev:local-development-only@127.0.0.1:5432/veshi_dev
APP_ORIGIN=http://localhost:5173
HOST=127.0.0.1
PORT=3000
MEDIA_DIR=var/media
BOT_DELIVERY_MODE=dry-run
```

Локальный режим задаётся **явно** через `APP_MODE=local`. Он включает изолированный вход тестовых ролей; в production такой режим запрещён. В локальной конфигурации допустим только тестовый каталог, без реальных персональных данных.

```bash
node --env-file=.env --import tsx server/migrate.ts
ALLOW_DEV_SEED=1 node --env-file=.env --import tsx scripts/seed.ts
node --env-file=.env --import tsx server/main.ts
```

В другом терминале:

```bash
node --env-file=.env --import tsx server/worker.ts
npx vite --host 127.0.0.1
```

Откройте `http://localhost:5173`. Кнопка локального входа позволяет проверить покупателя, сотрудника и владельца. Тестовые вещи обозначены явно; синтетические изображения не являются ассортиментом магазина. Не запускайте seed на рабочей базе.

## Проверки

Для тестов создайте отдельную БД `veshi_test` с тем же локальным пользователем (например `docker compose -f infra/compose.dev.yaml exec db createdb -U veshi_dev veshi_test`). Тестовый запуск требует имя БД, заканчивающееся `_test`; локальный режим задаётся скриптом `npm test`. Рабочая БД не должна использоваться для тестового `TRUNCATE` и фикстур.

```bash
npm run typecheck
npm run lint
DATABASE_URL=postgresql://veshi_dev:local-development-only@127.0.0.1:5432/veshi_test npm test
npm run build
```

Команды и фактические результаты текущей передачи записываются в [docs/verification.md](docs/verification.md). Проверка остатков требует настоящей PostgreSQL; успешный unit test не доказывает корректность конкурентных транзакций.

## Запуск на VPS

Конфигурация: [infra/compose.yaml](infra/compose.yaml), [infra/.env.example](infra/.env.example), [infra/Caddyfile](infra/Caddyfile). Развёртывание на VPS, изменение DNS/webhook и внешние сообщения выполняются только после отдельного согласования. Инструкция: [docs/launch.md](docs/launch.md).

Производственная конфигурация не запускает seed, не разрешает локальный вход и не содержит фиктивного владельца. Первый владелец создаётся только серверным CLI по проверенному Telegram ID уже вошедшего пользователя. Сотрудников владелец приглашает из приложения.

[Инструкция сотруднику](docs/staff.md) описывает проверку, выдачу, продажу у кассы, ручные отправки и осмотр возвратов. [docs/contract.md](docs/contract.md) фиксирует маршрутный контракт; [docs/api.md](docs/api.md) поясняет сессии, права и безопасные повторы команд.

## Что требуется для публикации

Фактический адрес/график, реквизиты и документы магазина; аккаунт поддержки; токен бота, домен и доступ к выбранному VPS через защищённые настройки; подтверждённые договоры и схема оплаты при получении для каждой почты. Пока эти сведения не заполнены, оформление в новой рабочей БД выключено, способы доставки не включены.

Обязательных SaaS-подписок нет. Услуги не покупались; подтверждённого счёта VPS ещё нет. Жёсткий предел — 50 BYN/месяц со всеми обязательными дополнениями и налогами, домен отдельно. Число товаров и объём фото нужно измерить перед выбором диска.

Постоянные тома переживают пересборку и обычный перезапуск. Резервные копии по решению владельца не настраиваются. Потерю единственного диска нельзя восстановить откатом кода.
