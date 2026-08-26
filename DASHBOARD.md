# Browser-first дашборд через n8n

Этот поток предназначен для пользователя, который открывает страницу сервиса в браузере. Данные существуют только в пределах одного HTTP-запроса: после ответа n8n backend возвращает готовый HTML-дашборд в ту же вкладку и удаляет временные CSV.

```text
Браузер → POST /v1/dashboard → детерминированный аудит → n8n webhook
       ← HTML-дашборд       ← JSON: итоговый CSV + audit.md  ← 2 ИИ-вызова
```

## Запуск

```bash
npm ci
npm run build
N8N_WEBHOOK_URL="https://<ваш-n8n>/webhook/<path>" npm run api:start
```

Откройте `/` на домене хостинга. Страница покажет шесть полей загрузки CSV и после отправки автоматически перейдёт на HTML-дашборд.

## Что backend передаёт в n8n

Backend сначала выполняет тот же детерминированный аудит, что и `POST /v1/audit`, затем передаёт в n8n JSON:

```json
{
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
```

В n8n используйте `analysis` и `files.report_fixed_csv` как фактическую основу двух ИИ-запросов. ИИ не должен заново искать ошибки: он только формирует понятные комментарии в новом отчёте и читабельный `audit.md`.

## Что n8n обязан вернуть

Последний webhook-ответ n8n должен быть **одним JSON-объектом**:

```json
{
  "final_report_csv": "client_id;project_ids;project_name;…;comments\n…",
  "audit_md": "# AUDIT\n\n…",
  "analysis": {
    "Issues": [],
    "Questions": []
  }
}
```

Поле `analysis` можно не возвращать: backend подставит исходный детерминированный `analysis` в дашборд. Поля `final_report_csv` и `audit_md` обязательны. Первый должен быть корректным CSV с разделителем `;`; второй — Markdown как обычная строка.

## Настройка workflow n8n

1. Создайте **Webhook** с методом `POST` и используйте его production URL в `N8N_WEBHOOK_URL`.
2. Настройте webhook на ответ **Using Respond to Webhook node** либо **When Last Node Finishes**.
3. Подайте `analysis` и `files.report_fixed_csv` в ИИ №1; его выход должен быть `final_report_csv` с колонкой комментариев.
4. Подайте `analysis` и технические расхождения в ИИ №2; его выход должен быть `audit_md`.
5. Через Merge/Code node соберите единственный JSON из двух ответов и передайте его в **Respond to Webhook**. Выберите JSON-ответ, не HTML.

Backend сам рендерит HTML. Это исключает передачу скриптов или разметки от ИИ напрямую в браузер.

## Ограничения

Синхронный запрос ожидает n8n не более `N8N_TIMEOUT_MS` (по умолчанию 120 секунд). Если два ИИ-вызова стабильно выполняются дольше, для такого сценария потребуется фоновой режим с сохранением результата и ссылкой на него. При обычном времени ответа пользователь увидит дашборд в той же вкладке сразу после обработки.
