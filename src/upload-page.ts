const FILE_FIELDS = [
  ["checked_report", "Проверяемый старый отчёт"],
  ["raw_monthly_shipments", "Помесячные отгрузки"],
  ["projects_directory", "Справочник проектов"],
  ["projects_change_history", "История смен project_id"],
  ["service_changes", "История смен услуг"],
  ["flight_length", "Справочник сроков флайтов"],
] as const;

/**
 * Стартовая страница не удерживает соединение во время двух ИИ-запросов.
 * POST /v1/runs создаёт временный run_id и перенаправляет браузер на ожидание.
 */
export function renderUploadPage(): string {
  const fields = FILE_FIELDS.map(([name, label]) => `
    <label class="file-field"><span>${label}</span><input type="file" name="${name}" accept=".csv,text/csv" required><small>CSV-файл</small></label>`,
  ).join("");

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Аудит отчёта</title>
  <style>
    :root { --navy:#132d4f; --blue:#1463d8; --ink:#1d2632; --muted:#617085; --line:#d9e1eb; --bg:#f4f7fb; } * { box-sizing:border-box; }
    body { min-height:100vh; margin:0; display:grid; place-items:center; padding:24px; background:linear-gradient(150deg,#e8f1ff,var(--bg) 45%); color:var(--ink); font:14px/1.45 Inter,ui-sans-serif,system-ui,sans-serif; }
    main { width:min(850px,100%); padding:34px; background:#fff; border:1px solid var(--line); border-radius:16px; box-shadow:0 16px 42px rgb(25 54 93 / 12%); } h1 { margin:0 0 9px; color:var(--navy); font-size:28px; } p { margin:0 0 24px; color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; } .file-field { display:grid; gap:6px; padding:13px; border:1px solid var(--line); border-radius:10px; background:#fbfcff; font-weight:600; } input[type=file] { max-width:100%; font-weight:400; } small { color:var(--muted); font-weight:400; }
    .actions { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-top:26px; } button { border:0; border-radius:9px; padding:11px 17px; background:var(--blue); color:#fff; font:600 14px inherit; cursor:pointer; } button:disabled { cursor:wait; opacity:.65; } #progress { color:var(--muted); } @media (max-width:620px) { main { padding:22px; } .grid { grid-template-columns:1fr; } .actions { align-items:flex-start; flex-direction:column; } }
  </style>
</head>
<body>
  <main>
    <h1>Проверка отчёта</h1>
    <p>Загрузите шесть CSV. Сайт выполнит аудит, запустит обработку в n8n и откроет итоговый dashboard после готовности. Вкладку можно не держать открытой: результат временно хранится на сервере.</p>
    <form id="audit-form" action="/v1/runs" method="post" enctype="multipart/form-data">
      <input id="metadata" name="metadata" type="hidden">
      <input name="form_mode" type="hidden" value="instanceAi">
      <div class="grid">${fields}</div>
      <div class="actions"><span id="progress">Поддерживаются CSV до 5 МБ каждый.</span><button id="submit" type="submit">Запустить аудит</button></div>
    </form>
  <script>
    const form = document.getElementById('audit-form'); const metadata = document.getElementById('metadata'); const submit = document.getElementById('submit'); const progress = document.getElementById('progress');
    form.addEventListener('submit', () => { const data = new FormData(form); metadata.value = JSON.stringify([{ submittedAt: new Date().toISOString(), formMode: String(data.get('form_mode') || 'instanceAi'), checked_report: 'checked_report', raw_monthly_shipments: 'raw_monthly_shipments', projects_directory: 'projects_directory', projects_change_history: 'projects_change_history', service_changes: 'service_changes', flight_length: 'flight_length' }]); submit.disabled = true; progress.textContent = 'Аудит запускается. Сейчас откроется страница статуса…'; });
  </script>
</body>
</html>`;
}

/** Страница опрашивает короткий endpoint статуса, а не удерживает ответ n8n открытым. */
export function renderWaitingPage(runId: string, viewToken: string): string {
  const encodedToken = encodeURIComponent(viewToken);
  const statusUrl = `/v1/runs/${encodeURIComponent(runId)}/status?token=${encodedToken}`;
  const dashboardUrl = `/runs/${encodeURIComponent(runId)}?token=${encodedToken}`;
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Подготовка дашборда</title>
  <style>
    :root { --navy:#132d4f; --blue:#1463d8; --ink:#1d2632; --muted:#617085; --line:#d9e1eb; --bg:#f4f7fb; } * { box-sizing:border-box; }
    body { min-height:100vh; margin:0; display:grid; place-items:center; padding:24px; background:linear-gradient(150deg,#e8f1ff,var(--bg) 45%); color:var(--ink); font:16px/1.5 Inter,ui-sans-serif,system-ui,sans-serif; }
    main { width:min(620px,100%); padding:34px; background:#fff; border:1px solid var(--line); border-radius:16px; box-shadow:0 16px 42px rgb(25 54 93 / 12%); } h1 { margin:0 0 12px; color:var(--navy); font-size:26px; } p { color:var(--muted); } .spinner { width:38px; height:38px; margin:20px 0; border:4px solid #dfeaff; border-top-color:var(--blue); border-radius:50%; animation:spin 1s linear infinite; } code { display:block; overflow-wrap:anywhere; padding:9px; border-radius:7px; background:#f4f7fb; color:#45566f; font-size:12px; } .error { color:#a43c2d; } @keyframes spin { to { transform:rotate(360deg); } }
  </style>
</head>
<body>
  <main>
    <h1>Формируем результат</h1>
    <div class="spinner" aria-hidden="true"></div>
    <p id="message">Аудит завершён. n8n готовит комментарии и аудит. Эта страница проверяет результат каждые 3 секунды.</p>
    <code>Запуск: ${runId}</code>
  </main>
  <script>
    const message = document.getElementById('message');
    const statusUrl = ${JSON.stringify(statusUrl)};
    const dashboardUrl = ${JSON.stringify(dashboardUrl)};
    async function check() {
      try {
        const response = await fetch(statusUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error('Статус временно недоступен');
        const run = await response.json();
        if (run.status === 'completed') { window.location.replace(dashboardUrl); return; }
        if (run.status === 'failed') { message.className = 'error'; message.textContent = run.error?.message || 'Обработка в n8n завершилась ошибкой.'; return; }
        message.textContent = 'n8n продолжает обработку. Страница обновится автоматически после готовности.';
        window.setTimeout(check, 3000);
      } catch (error) {
        message.className = 'error'; message.textContent = error instanceof Error ? error.message : 'Не удалось получить статус.';
        window.setTimeout(check, 5000);
      }
    }
    window.setTimeout(check, 1000);
  </script>
</body>
</html>`;
}
