const FILE_FIELDS = [
  ["checked_report", "Проверяемый старый отчёт"],
  ["raw_monthly_shipments", "Помесячные отгрузки"],
  ["projects_directory", "Справочник проектов"],
  ["projects_change_history", "История смен project_id"],
  ["service_changes", "История смен услуг"],
  ["flight_length", "Справочник сроков флайтов"],
] as const;

/** Страница не хранит файлы: браузер отправляет их единственным POST /v1/dashboard. */
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
    <p>Загрузите шесть CSV. Файлы передаются на аудит, затем n8n создаёт итоговый отчёт и аудит; результат откроется в этой вкладке без сохранения данных на сервере.</p>
    <form id="audit-form" action="/v1/dashboard" method="post" enctype="multipart/form-data">
      <input id="metadata" name="metadata" type="hidden">
      <input name="form_mode" type="hidden" value="instanceAi">
      <div class="grid">${fields}</div>
      <div class="actions"><span id="progress">Поддерживаются CSV до 5 МБ каждый.</span><button id="submit" type="submit">Сформировать дашборд</button></div>
    </form>
  <script>
    const form = document.getElementById('audit-form'); const metadata = document.getElementById('metadata'); const submit = document.getElementById('submit'); const progress = document.getElementById('progress');
    form.addEventListener('submit', () => { const data = new FormData(form); metadata.value = JSON.stringify([{ submittedAt: new Date().toISOString(), formMode: String(data.get('form_mode') || 'instanceAi'), checked_report: 'checked_report', raw_monthly_shipments: 'raw_monthly_shipments', projects_directory: 'projects_directory', projects_change_history: 'projects_change_history', service_changes: 'service_changes', flight_length: 'flight_length' }]); submit.disabled = true; progress.textContent = 'Аудит и подготовка ИИ-ответов выполняются. Не закрывайте вкладку…'; });
  </script>
</body>
</html>`;
}
