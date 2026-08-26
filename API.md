# HTTP API аудита CSV

Сервис рассчитан на обычный Node.js-хостинг. Он не зависит от ngrok: хостинг предоставляет собственный HTTPS URL, а n8n вызывает один endpoint `POST /v1/audit`.

API принимает шесть бинарных CSV с **произвольными именами**. Их назначение определяется единственным текстовым multipart-полем `metadata`; это избавляет n8n от переименования файлов перед передачей.

## Запуск на хостинге

```bash
npm ci
npm run build
npm run api:start
```

Порт берётся из переменной `PORT` (по умолчанию `3000`). Необязательный `API_ACCESS_TOKEN` задаёт проверку заголовка `Authorization: Bearer <токен>`.

## Проверка состояния

```http
GET /health
```

## Единственный запрос аудита

```http
POST /v1/audit
Content-Type: multipart/form-data
```

Добавьте одно текстовое поле `metadata` со значением:

```json
[
  {
    "submittedAt": "2026-08-26T11:30:37.227Z",
    "formMode": "instanceAi",
    "checked_report": "report.csv",
    "raw_monthly_shipments": "shipments.csv",
    "projects_directory": "projects.csv",
    "projects_change_history": "history.csv",
    "service_changes": "service.csv",
    "flight_length": "flight.csv"
  }
]
```

Каждое значение роли указывает на **имя поля бинарного файла** в том же `multipart/form-data` запросе. В примере добавьте шесть параметров типа Binary File с именами `report.csv`, `shipments.csv`, `projects.csv`, `history.csv`, `service.csv` и `flight.csv`.

| Поле metadata | Какую таблицу ожидает аудит |
|---|---|
| `checked_report` | Старый проверяемый отчёт |
| `raw_monthly_shipments` | Помесячные отгрузки / `works` |
| `projects_directory` | Справочник проектов |
| `projects_change_history` | История смен `project_id` |
| `service_changes` | История смен услуг |
| `flight_length` | Сроки флайтов по услугам |

Фактические имена бинарных полей могут быть любыми. Например, `raw_monthly_shipments` может ссылаться на `file_42.csv`, если поле Binary File в запросе имеет имя `file_42.csv`.

## Ответ

Успешный вызов возвращает один JSON-объект:

```json
{
  "requestId": "…",
  "status": "completed",
  "request": { "…": "исходные metadata" },
  "summary": {
    "historicalReportCutoff": "2025-09-01",
    "outputReportGeneratedAt": "2026-08-26",
    "uniqueClients": 11,
    "flights": 17,
    "statuses": { "…": 0 },
    "issues": 15,
    "questions": 8
  },
  "analysis": {
    "Issues": ["готовые факты, аргументы и окружение ошибок"],
    "Questions": ["готовые вопросы к заказчику с влиянием на расчёт"]
  },
  "files": {
    "report_fixed_csv": "client_id;project_ids;…",
    "audit_discrepancies_json": ["детализированные технические расхождения"]
  }
}
```

Для следующего ИИ-узла n8n передавайте `analysis` целиком и задайте инструкцию: «Используй только факты и вопросы из `analysis`; не ищи новые ошибки и не придумывай причины». Исправленный CSV можно взять из `files.report_fixed_csv`.

При ошибке API возвращает JSON со статусом `error`, машиночитаемым кодом и понятным описанием. Основные коды: `MISSING_METADATA`, `INVALID_METADATA`, `MISSING_FILES`, `UNEXPECTED_FILE`, `DUPLICATE_UPLOAD`, `DUPLICATE_FILE_REFERENCE`, `EMPTY_FILE`, `UNAUTHORIZED` и `AUDIT_FAILED`.
