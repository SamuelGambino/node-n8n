# Асинхронный browser-first дашборд через n8n

Этот сценарий устраняет зависимость браузера от длительности двух ИИ-вызовов в n8n. Node.js сначала выполняет **детерминированный** аудит, создаёт временный `run_id` в JSON-хранилище, быстро запускает n8n и направляет браузер на страницу ожидания. Когда n8n закончит обработку, он сам отправляет итоговый CSV и `audit.md` в callback Node.js. Страница опрашивает короткий endpoint статуса и автоматически открывает готовый dashboard.

```text
Браузер → POST /v1/runs → детерминированный аудит → JSON run: processing
   ↓ 303
GET /runs/:runId?token=… → ожидание и GET /v1/runs/:runId/status

Node.js → быстрый POST в n8n Webhook → n8n немедленно подтверждает запуск
                                          ↓
                         ИИ №1 + ИИ №2 → Merge/Code → POST callback_url
                                                             ↓
                     временный JSON run: completed ← Node.js валидирует результат
                                                             ↓
                                              GET /runs/:runId?token=… → dashboard
```

## Запуск сервиса

Установите зависимости, соберите TypeScript и запустите приложение стандартной командой Node.js:

```bash
npm ci
npm run build
npm start
```

Для запуска в режиме разработки используйте имеющийся npm-скрипт разработки. На Render установите Build Command `npm ci && npm run build` и Start Command `npm start`.

| Переменная | Назначение | Рекомендуемое значение на Render |
|---|---|---|
| `PUBLIC_BASE_URL` | Публичный адрес Node.js-сервиса, из которого строится callback | `https://<service>.onrender.com` |
| `N8N_WEBHOOK_URL` | Production URL входящего webhook n8n для старта обработки | `https://<n8n>/webhook/<path>` |
| `N8N_WEBHOOK_TOKEN` | Необязательный Bearer-токен защиты входящего webhook n8n | секрет n8n |
| `N8N_CALLBACK_TOKEN` | Обязательный общий Bearer-секрет для callback из n8n | длинное случайное значение |
| `RUN_STORE_DIR` | Директория файлов запусков | `/var/data/audit-runs` с Persistent Disk |
| `RUN_TTL_MS` | Время хранения запуска | `86400000` (24 часа) |
| `N8N_START_TIMEOUT_MS` | Максимум времени только на подтверждение начала n8n | `20000` |

`API_ACCESS_TOKEN` продолжает защищать прямой программный `POST /v1/audit`. Он не применяется к browser-first форме, потому что HTML-форма не может безопасно хранить Bearer-секрет на стороне пользователя.

## Настройка временного хранилища на Render

По умолчанию сервис пишет временные файлы в `temp-db/` рядом с приложением. Эта папка исключена из Git. Файл одного запуска содержит только детерминированный payload, статус, результат n8n и секретный токен ссылки просмотра; загруженные исходные CSV удаляются сразу после детерминированного аудита.

> **Важно.** Файловая система Render по умолчанию эфемерна: записи теряются при redeploy или restart. Для сохранения незавершённых и готовых запусков в пределах TTL подключите Persistent Disk и задайте `RUN_STORE_DIR` внутри точки монтирования. Render сохраняет только изменения под mount path.[1]

В Render Dashboard откройте сервис, добавьте Persistent Disk с mount path `/var/data`, затем сохраните переменную `RUN_STORE_DIR=/var/data/audit-runs`. Диск доступен только одному экземпляру сервиса, поэтому такой вариант требует одного instance и отключает zero-downtime deploys.[1] Если disk не подключать, асинхронный поток всё равно работает, пока тот же экземпляр жив, но callback-результаты могут исчезнуть при restart/deploy.

## Контракт запуска

### `POST /v1/runs`

Browser-first форма отправляет тот же `multipart/form-data`, что раньше принимал `POST /v1/dashboard`: текстовое поле `metadata` и ровно шесть CSV. После успешного детерминированного аудита endpoint создаёт run, запускает n8n и отвечает `303 See Other`:

```http
Location: /runs/c88e2a23-…?token=<секретная-ссылка-просмотра>
```

Ссылка просмотра не является callback-секретом. Она нужна только браузеру для чтения статуса и dashboard до истечения TTL; не публикуйте её в общих каналах.

В n8n отправляется следующий объект. Поле `audit` — прежний готовый детерминированный payload; именно его нужно использовать как единственный источник фактов для двух ИИ-запросов.

```json
{
  "run_id": "c88e2a23-…",
  "callback_url": "https://<service>.onrender.com/v1/runs/c88e2a23-…/result",
  "audit": {
    "requestId": "…",
    "status": "completed",
    "request": { "submittedAt": "…", "formMode": "instanceAi" },
    "summary": { "issues": 15, "questions": 8 },
    "analysis": { "Issues": [], "Questions": [] },
    "files": {
      "report_fixed_csv": "client_id;…",
      "audit_discrepancies_json": { "discrepancies": [] }
    }
  }
}
```

Если n8n недоступен уже на этапе запуска, endpoint всё равно создаёт run, помечает его `failed` и перенаправляет пользователя на понятную страницу ошибки. При этом соединение не ждёт генерацию ИИ.

### Страница и JSON статуса

`GET /runs/:runId?token=<viewToken>` отдаёт либо страницу ожидания, либо итоговый dashboard. Пока статус `processing`, страница раз в три секунды запрашивает:

```text
GET /v1/runs/:runId/status?token=<viewToken>
```

Пример безопасного ответа статуса без CSV, Markdown, `analysis` и callback-секрета:

```json
{
  "run_id": "c88e2a23-…",
  "status": "processing",
  "created_at": "2026-08-27T10:00:00.000Z",
  "updated_at": "2026-08-27T10:00:00.000Z",
  "expires_at": "2026-08-28T10:00:00.000Z"
}
```

## Что настроить в n8n

Создайте один workflow, стартующий от **Webhook** с методом `POST`, и поместите его Production URL в `N8N_WEBHOOK_URL`. В webhook настройте немедленное подтверждение запроса (например, `Respond Immediately` или ранний `Respond to Webhook`), возвращающее `200` или `202`. После отправки короткого ответа workflow должен продолжить выполнение двух ИИ-веток.

Сохраните `run_id` и `callback_url` до конца workflow, в том числе через Merge/Code node. ИИ №1 получает `audit.analysis` и `audit.files.report_fixed_csv`, формирует **полный CSV** с дополнительной колонкой человеческих комментариев. ИИ №2 получает `audit.analysis` и технические расхождения и формирует чистый `audit_md`. ИИ не пересчитывает статусы и не ищет новые ошибки: он только объясняет предоставленные факты.

После объединения двух веток добавьте **HTTP Request** node:

| Параметр HTTP Request | Значение |
|---|---|
| Method | `POST` |
| URL | выражение с сохранённым `callback_url` |
| Content Type | JSON |
| Header | `Authorization: Bearer <значение N8N_CALLBACK_TOKEN>` |
| JSON body | объект из блока ниже |

```json
{
  "final_report_csv": "client_id;project_ids;…;comments\n…",
  "audit_md": "# AUDIT\n\n…",
  "analysis": { "Issues": [], "Questions": [] }
}
```

`analysis` можно не передавать: сервис использует исходный детерминированный `analysis` при отрисовке dashboard. Поля `final_report_csv` и `audit_md` обязательны. Callback отвечает `200` только после проверки формата CSV и сохранения результата; в ответе возвращаются `{ "status": "completed", "run_id": "…" }`.

`N8N_CALLBACK_TOKEN` не передаётся в стартовом JSON и не попадает в браузер. Задайте его в credentials или защищённой переменной n8n и тем же значением в Environment сервиса Render.

## Требования к ответам ИИ

Некоторые ИИ-ноды n8n возвращают объект сообщения, а не строку, например `{"parts":[{"text":"…"}]}`. В конечном Code/Merge node нужно извлечь только `parts[].text`; не сериализуйте весь объект в `final_report_csv` или `audit_md`. Сервис дополнительно умеет распаковать типовые обёртки, но не может восстановить CSV, если модель оборвала ответ посередине строки.

Для ИИ №1 увеличьте лимит output tokens и явно потребуйте: вернуть полный CSV с разделителем `;`, без Markdown-ограждений, вводного текста и сокращений. Сервис проверяет итоговый CSV перед записью; некорректный callback помечает run `failed`, а browser увидит диагностическую страницу вместо повреждённой таблицы.

## Очистка и ограничения

При каждом чтении или изменении runs сервис удаляет истёкшие и повреждённые JSON-файлы. Стандартный TTL — 24 часа; его можно менять через `RUN_TTL_MS`. После истечения TTL ссылка просмотра и callback дадут `404`, а скачать CSV/Markdown больше нельзя.

Файловое хранилище намеренно является лёгким решением для одного Render service. Если впоследствии понадобятся несколько экземпляров, высокая доступность или надёжное сохранение больших объёмов, замените `FileRunStore` на внешний datastore (например, Render Postgres или Key Value), а не делите локальную папку между экземплярами.[1]

## Ссылки

[1]: https://render.com/docs/disks "Render Persistent Disks"
