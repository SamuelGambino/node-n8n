# HTTP API для n8n

Сервис принимает шесть CSV-файлов, выполняет детерминированный аудит и возвращает готовые результаты для последующего объяснения ИИ в n8n. ИИ не должен повторно анализировать CSV: для него предназначен объект `results.analysis`.

## Запуск

Скопируйте `.env.example` в `.env`, укажите `NGROK_AUTHTOKEN` и при необходимости `API_ACCESS_TOKEN`, затем выполните:

```bash
npm run build
npm run api:tunnel
```

Команда выводит публичный HTTPS URL ngrok. Временный URL доступен, пока работает процесс API и туннель.

## Проверка состояния

```http
GET /health
```

Пример ответа:

```json
{
  "status": "ok",
  "requiredFiles": [
    "works.csv",
    "projects.csv",
    "projects_history.csv",
    "service_changes.csv",
    "service_terms.csv",
    "report.csv"
  ],
  "accessTokenRequired": false
}
```

## Запуск аудита

```http
POST /v1/audit
Content-Type: multipart/form-data
```

В multipart должны присутствовать **ровно шесть** бинарных файлов. Имя каждого поля должно совпадать с именем файла:

| Имя multipart-поля | Файл |
|---|---|
| `works.csv` | `works.csv` |
| `projects.csv` | `projects.csv` |
| `projects_history.csv` | `projects_history.csv` |
| `service_changes.csv` | `service_changes.csv` |
| `service_terms.csv` | `service_terms.csv` |
| `report.csv` | `report.csv` |

Максимальный размер одного файла — 5 МБ. Если в `.env` задан `API_ACCESS_TOKEN`, добавьте заголовок:

```http
Authorization: Bearer <API_ACCESS_TOKEN>
```

Успешный ответ имеет статус `200` и содержит:

| Поле ответа | Назначение |
|---|---|
| `summary` | Краткие счётчики входных файлов, клиентов, флайтов, статусов, ошибок и вопросов. |
| `results.reportFixedCsv` | Текст готового `report_fixed.csv`. |
| `results.analysis` | Полный `analysis.json`: факты, аргументы, окружение ошибок и вопросы к заказчику. Это основной вход для ИИ в n8n. |
| `results.auditDiscrepancies` | Детализированные технические расхождения с исходным `report.csv`. |

## Настройка HTTP Request в n8n

В узле **HTTP Request** укажите метод `POST`, публичный URL с путём `/v1/audit` и тип тела `Form-Data`. Добавьте шесть параметров типа **n8n Binary File**, задав для каждого точное имя поля из таблицы выше. Для бесплатного URL ngrok добавьте HTTP-заголовок `ngrok-skip-browser-warning: 1`, иначе ngrok вернёт страницу предупреждения вместо API-ответа. После ответа передавайте `results.analysis` в ИИ-узел вместе с инструкцией: «Используй только факты и вопросы из analysis; не вычисляй новые ошибки и не выдумывай причины».

При ошибке API возвращает JSON со статусом `error`, кодом (`MISSING_FILES`, `UNEXPECTED_FILE`, `DUPLICATE_FILE`, `EMPTY_FILE`, `UNAUTHORIZED` или `AUDIT_FAILED`), объяснением и списком обязательных файлов.
