import { config, llmConfigured, PUBLIC_BASE_URL } from './config.js'
import { getLocalModelStatus } from './local-model.js'
import { getMetrics } from './observe.js'
import type { JobStore } from './job-store.js'
import { adminKillConfigured } from './admin.js'

/** Public, unauthenticated status payload — no tokens, goals, or file contents. */
export function buildPublicStatus(store: JobStore): Record<string, unknown> {
  const counts = store.counts()
  const local = getLocalModelStatus()
  const metrics = getMetrics()
  const inference = config.llmBase ? 'remote' : 'local'
  const ready = inference === 'remote' || local.status === 'ready'

  const byStatus: Record<string, number> = {
    queued: 0,
    running: 0,
    done: 0,
    failed: 0,
    stopped: 0
  }
  for (const j of store.list(500)) {
    byStatus[j.status] = (byStatus[j.status] || 0) + 1
  }

  const recent = store.list(25).map((j) => ({
    id: j.id,
    status: j.status,
    agentId: j.agentId,
    agentName: j.agentName,
    plan: j.plan || null,
    step: j.step ?? 0,
    liveStatus: (j.liveStatus || '').slice(0, 120),
    hasArtifacts: Boolean(j.hasArtifacts),
    artifactCount: j.artifactCount || 0,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    finishedAt: j.finishedAt || null
  }))

  return {
    ok: true,
    service: 'eris-cloud-agent',
    version: config.version,
    generatedAt: new Date().toISOString(),
    publicBaseUrl: config.publicBaseUrl,
    apiPort: config.port,
    statusPort: config.statusPort,
    ready,
    gpuMode: config.gpu,
    inference,
    llmConfigured: llmConfigured(),
    authRequired: !config.allowAnonymous,
    maxParallel: config.maxParallel,
    maxQueue: config.maxQueue,
    jobs: {
      running: counts.running,
      queued: counts.queued,
      byStatus
    },
    localModel: {
      status: local.status,
      modelId: local.modelId,
      modelName: local.modelName,
      gpu: local.gpu ?? null,
      error: local.error || null
    },
    metrics,
    recentJobs: recent,
    adminKillAllConfigured: adminKillConfigured()
  }
}

export function statusPageHtml(): string {
  const title = 'Eris Cloud Agent'
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="30" />
  <title>${title}</title>
  <style>
    :root {
      --bg: #0f1419;
      --panel: #1a222c;
      --text: #e7ecf1;
      --muted: #8b9aab;
      --ok: #3dd68c;
      --warn: #f5a524;
      --bad: #f31260;
      --line: #2a3542;
      --accent: #6ea8fe;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      background: radial-gradient(1200px 600px at 10% -10%, #1b2a3d, transparent),
                  radial-gradient(900px 500px at 100% 0%, #18241c, transparent),
                  var(--bg);
      color: var(--text);
      min-height: 100vh;
    }
    main { max-width: 1100px; margin: 0 auto; padding: 28px 20px 48px; }
    header { display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: baseline; margin-bottom: 22px; }
    h1 { font-size: 1.45rem; font-weight: 650; margin: 0; letter-spacing: -0.02em; }
    .sub { color: var(--muted); font-size: 0.92rem; }
    .pill {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line);
      background: var(--panel); font-size: 0.85rem;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
    .dot.ok { background: var(--ok); box-shadow: 0 0 0 3px rgba(61,214,140,.15); }
    .dot.warn { background: var(--warn); }
    .dot.bad { background: var(--bad); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 18px 0; }
    .card {
      background: color-mix(in srgb, var(--panel) 92%, black);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px 14px 12px;
    }
    .card .label { color: var(--muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: .04em; }
    .card .value { font-size: 1.55rem; font-weight: 650; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .card .hint { color: var(--muted); font-size: 0.8rem; margin-top: 2px; }
    section { margin-top: 22px; }
    h2 { font-size: 0.95rem; margin: 0 0 10px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
    table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
    th { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: .04em; font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.82rem; }
    .muted { color: var(--muted); }
    pre {
      margin: 0; padding: 14px; background: var(--panel); border: 1px solid var(--line);
      border-radius: 12px; overflow: auto; font-size: 0.8rem; color: #c8d3de;
    }
    a { color: var(--accent); }
    footer { margin-top: 28px; color: var(--muted); font-size: 0.8rem; }
    .err { color: var(--bad); }
    .ops {
      display: grid; gap: 10px;
      margin: 4px 0 16px; padding: 16px;
      background: color-mix(in srgb, var(--bad) 10%, var(--panel));
      border: 1px solid color-mix(in srgb, var(--bad) 40%, var(--line));
      border-radius: 12px;
    }
    .ops h2 { margin: 0; color: var(--text); text-transform: none; letter-spacing: 0; font-size: 1rem; }
    .ops-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .ops button {
      appearance: none; border: 1px solid color-mix(in srgb, var(--bad) 55%, var(--line));
      background: color-mix(in srgb, var(--bad) 28%, var(--panel));
      color: var(--text); border-radius: 8px; padding: 10px 14px; cursor: pointer;
      font: inherit; font-weight: 700;
    }
    .ops button:disabled { opacity: 0.45; cursor: not-allowed; }
    .ops input {
      flex: 1; min-width: 220px; max-width: 420px;
      background: #0c1117; border: 1px solid var(--line); border-radius: 8px;
      color: var(--text); padding: 10px 12px; font: inherit;
    }
    .ops .note { color: var(--muted); font-size: 0.85rem; line-height: 1.4; }
    .ops code { color: var(--accent); font-size: 0.8rem; }
    #killMsg { font-size: 0.9rem; min-height: 1.2em; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${title}</h1>
      <span class="pill" id="readyPill"><span class="dot" id="readyDot"></span><span id="readyLabel">Loading…</span></span>
      <span class="sub" id="stamp"></span>
    </header>
    <section class="ops" id="opsRow" aria-label="Force kill all active jobs">
      <h2>Force kill all active jobs</h2>
      <p class="note" id="killHint">
        Aborts every queued and running job on this worker. Paste the admin token from
        <code>ERIS_CLOUD_ADMIN_TOKEN</code> or <code>/var/lib/eris-cloud/admin.token</code> inside the container.
      </p>
      <div class="ops-row">
        <button type="button" id="killBtn">Force kill all</button>
        <input type="password" id="adminToken" placeholder="Admin token" autocomplete="off" />
        <span id="killMsg" class="muted"></span>
      </div>
    </section>
    <div class="grid" id="cards"></div>
    <section>
      <h2>Recent jobs</h2>
      <div id="jobsWrap" class="muted">Loading…</div>
    </section>
    <section>
      <h2>Raw JSON</h2>
      <pre id="raw">Loading…</pre>
    </section>
    <footer>
      Auto-refreshes every 5s · API <span class="mono">${PUBLIC_BASE_URL}</span> ·
      <a href="/status.json">/status.json</a> ·
      <a href="/metrics">/metrics</a> ·
      GET public · kill-all needs admin token
    </footer>
  </main>
  <script>
    const fmtUptime = (s) => {
      s = Number(s) || 0;
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      if (h) return h + 'h ' + m + 'm';
      if (m) return m + 'm ' + sec + 's';
      return sec + 's';
    };
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);
    const killBtn = document.getElementById('killBtn');
    const killHint = document.getElementById('killHint');
    const killMsg = document.getElementById('killMsg');
    const adminToken = document.getElementById('adminToken');
    async function refresh() {
      try {
        const res = await fetch('/status.json', { cache: 'no-store' });
        const d = await res.json();
        const ready = !!d.ready;
        const modelErr = d.localModel && d.localModel.status === 'error';
        document.getElementById('readyDot').className = 'dot ' + (ready ? 'ok' : modelErr ? 'bad' : 'warn');
        document.getElementById('readyLabel').textContent = ready
          ? 'Ready'
          : (d.localModel && d.localModel.status === 'downloading' ? 'Downloading model' : 'Not ready');
        document.getElementById('stamp').textContent =
          (d.generatedAt || '') + ' · v' + (d.version || '') + ' · up ' + fmtUptime(d.metrics && d.metrics.uptimeSec);
        const killOk = d.adminKillAllConfigured !== false;
        killBtn.disabled = !killOk;
        killHint.innerHTML = killOk
          ? 'Aborts every queued and running job on this worker. Token: <code>ERIS_CLOUD_ADMIN_TOKEN</code> or <code>podman exec eris-cloud-agent cat /var/lib/eris-cloud/admin.token</code>.'
          : 'Admin kill-all is unavailable on this worker.';
        const m = d.metrics || {};
        const j = d.jobs || {};
        const cards = [
          ['Running', j.running ?? 0, 'active jobs'],
          ['Queued', j.queued ?? 0, 'waiting'],
          ['Done', (j.byStatus && j.byStatus.done) || m.jobsDone || 0, 'completed'],
          ['Failed', (j.byStatus && j.byStatus.failed) || m.jobsFailed || 0, 'errors'],
          ['Enqueues', m.enqueues ?? 0, 'total accepted'],
          ['Auth fails', m.authFailures ?? 0, 'rejected'],
          ['GPU mode', d.gpuMode ?? '—', d.localModel && d.localModel.gpu === false ? 'CPU' : (d.localModel && d.localModel.gpu) || ''],
          ['Model', (d.localModel && d.localModel.status) || '—', (d.localModel && d.localModel.modelName) || ''],
          ['Parallel', d.maxParallel ?? '—', 'max concurrent'],
          ['Requests', m.requests ?? 0, 'HTTP hits']
        ];
        document.getElementById('cards').innerHTML = cards.map(([label, value, hint]) =>
          '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' +
          esc(value) + '</div><div class="hint">' + esc(hint) + '</div></div>'
        ).join('');
        const rows = (d.recentJobs || []);
        if (!rows.length) {
          document.getElementById('jobsWrap').innerHTML = '<p class="muted">No jobs yet.</p>';
        } else {
          document.getElementById('jobsWrap').innerHTML =
            '<table><thead><tr><th>ID</th><th>Status</th><th>Agent</th><th>Step</th><th>Live</th><th>Updated</th></tr></thead><tbody>' +
            rows.map((r) => '<tr>' +
              '<td class="mono">' + esc(String(r.id).slice(0, 8)) + '</td>' +
              '<td>' + esc(r.status) + '</td>' +
              '<td>' + esc(r.agentName || r.agentId) + '</td>' +
              '<td>' + esc(r.step) + '</td>' +
              '<td class="muted">' + esc(r.liveStatus) + '</td>' +
              '<td class="mono muted">' + esc(r.updatedAt) + '</td>' +
              '</tr>').join('') +
            '</tbody></table>';
        }
        document.getElementById('raw').textContent = JSON.stringify(d, null, 2);
      } catch (e) {
        document.getElementById('readyLabel').textContent = 'Unreachable';
        document.getElementById('readyDot').className = 'dot bad';
        document.getElementById('raw').innerHTML = '<span class="err">' + esc(e && e.message ? e.message : e) + '</span>';
      }
    }
    killBtn.addEventListener('click', async () => {
      const token = (adminToken.value || '').trim();
      if (!token) {
        killMsg.textContent = 'Enter the admin token first.';
        killMsg.className = 'err';
        return;
      }
      if (!confirm('Force-kill ALL queued and running Cloud Agent jobs on this worker?')) return;
      killBtn.disabled = true;
      killMsg.textContent = 'Killing…';
      killMsg.className = 'muted';
      try {
        const headers = { 'X-Eris-Admin-Token': token, 'Content-Type': 'application/json' };
        let res = await fetch('/admin/kill-all', { method: 'POST', headers, body: '{}' });
        if (res.status === 404) {
          res = await fetch('/v1/admin/kill-all', { method: 'POST', headers, body: '{}' });
        }
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));
        killMsg.textContent = 'Stopped ' + (d.count ?? 0) + ' job(s).';
        killMsg.className = 'muted';
        refresh();
      } catch (e) {
        killMsg.textContent = e && e.message ? e.message : String(e);
        killMsg.className = 'err';
      } finally {
        killBtn.disabled = false;
      }
    });
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`
}
