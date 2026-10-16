import { config, llmConfigured, PUBLIC_BASE_URL } from './config.js'
import { getLocalModelStatus } from './local-model.js'
import { getMetrics, readPublicAudit } from './observe.js'
import { getUsageOverview, maskOwner } from './entitlements.js'
import type { JobStore } from './job-store.js'
import { adminKillConfigured } from './admin.js'
import { fleetConfigured, getFleetIdentity } from './fleet.js'
import { publicRemoteConfig } from './runtime-config.js'

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function isToday(iso: string | null | undefined): boolean {
  return Boolean(iso && iso.startsWith(todayKey()))
}

/** Public, unauthenticated status payload — no tokens, goals, or file contents. */
export function buildPublicStatus(store: JobStore): Record<string, unknown> {
  const counts = store.counts()
  const local = getLocalModelStatus()
  const metrics = getMetrics()
  const daily = getUsageOverview()
  const inference = config.llmBase ? 'remote' : 'local'
  const ready = inference === 'remote' || local.status === 'ready'

  const byStatus: Record<string, number> = {
    queued: 0,
    running: 0,
    done: 0,
    failed: 0,
    stopped: 0
  }
  const byPlan: Record<string, number> = { free: 0, pro: 0, unknown: 0 }
  const today = {
    created: 0,
    done: 0,
    failed: 0,
    stopped: 0,
    running: 0,
    queued: 0,
    stepsSum: 0,
    stepsN: 0
  }

  const all = store.list(500)
  for (const j of all) {
    byStatus[j.status] = (byStatus[j.status] || 0) + 1
    const plan = j.plan === 'pro' || j.plan === 'free' ? j.plan : 'unknown'
    byPlan[plan] = (byPlan[plan] || 0) + 1
    if (isToday(j.createdAt)) {
      today.created++
      if (j.status === 'done') today.done++
      else if (j.status === 'failed') today.failed++
      else if (j.status === 'stopped') today.stopped++
      else if (j.status === 'running') today.running++
      else if (j.status === 'queued') today.queued++
      if (typeof j.step === 'number' && j.step > 0) {
        today.stepsSum += j.step
        today.stepsN++
      }
    }
  }

  const todayTerminal = today.done + today.failed + today.stopped
  const todaySuccessRate =
    todayTerminal > 0 ? Math.round((today.done / todayTerminal) * 1000) / 10 : null

  const recent = all.slice(0, 30).map((j) => ({
    id: j.id,
    status: j.status,
    agentId: j.agentId,
    agentName: j.agentName,
    plan: j.plan || null,
    owner: maskOwner(j.ownerId || 'anonymous'),
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
      byStatus,
      byPlan,
      stored: all.length
    },
    localModel: {
      status: local.status,
      modelId: local.modelId,
      modelName: local.modelName,
      gpu: local.gpu ?? null,
      cached: local.cached,
      error: local.error || null
    },
    metrics,
    usage: {
      day: daily.day,
      freeJobsPerDay: daily.freeJobsPerDay,
      freeEnqueuesToday: daily.freeEnqueuesToday,
      freeEnqueuesWindow: daily.freeEnqueuesWindow,
      freeUsersToday: daily.freeUsersToday,
      freeUsersWindow: daily.freeUsersWindow,
      freeUsersAtCap: daily.freeUsersAtCap,
      topFreeUsers: daily.topFreeUsers,
      today: {
        ...today,
        avgSteps: today.stepsN ? Math.round((today.stepsSum / today.stepsN) * 10) / 10 : null,
        successRate: todaySuccessRate
      },
      limits: {
        maxParallel: config.maxParallel,
        maxQueue: config.maxQueue,
        freeJobsPerDay: config.freeJobsPerDay,
        maxConcurrentFree: config.maxConcurrentFree,
        maxConcurrentPro: config.maxConcurrentPro
      }
    },
    recentJobs: recent,
    recentAudit: readPublicAudit(24),
    adminKillAllConfigured: adminKillConfigured(),
    fleet: {
      linked: fleetConfigured(),
      agentId: getFleetIdentity()?.agentId || null,
      displayName: getFleetIdentity()?.displayName || null,
      lastHeartbeatAt: getFleetIdentity()?.lastHeartbeatAt || null,
      config: publicRemoteConfig()
    }
  }
}

export function statusPageHtml(): string {
  const title = 'Eris Cloud Agent · Usage'
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --bg: #0c1016;
      --panel: #151c26;
      --panel2: #1a2431;
      --text: #e8eef5;
      --muted: #8b9aab;
      --ok: #3dd68c;
      --warn: #f5a524;
      --bad: #f31260;
      --line: #2a3542;
      --accent: #6ea8fe;
      --pro: #c4a4ff;
      --free: #7dd3c0;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      background:
        radial-gradient(1000px 520px at 8% -12%, #1a2d42, transparent),
        radial-gradient(800px 420px at 100% 0%, #15261f, transparent),
        var(--bg);
      color: var(--text);
      min-height: 100vh;
    }
    main { max-width: 1180px; margin: 0 auto; padding: 28px 20px 56px; }
    header { display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: baseline; margin-bottom: 8px; }
    h1 { font-size: 1.5rem; font-weight: 650; margin: 0; letter-spacing: -0.02em; }
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
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 12px; }
    .card {
      background: color-mix(in srgb, var(--panel) 94%, black);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px 14px 12px;
    }
    .card .label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: .04em; }
    .card .value { font-size: 1.55rem; font-weight: 650; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .card .hint { color: var(--muted); font-size: 0.8rem; margin-top: 2px; }
    .card.warn .value { color: var(--warn); }
    .card.bad .value { color: var(--bad); }
    .card.ok .value { color: var(--ok); }
    section { margin-top: 26px; }
    h2 {
      font-size: 0.82rem; margin: 0 0 12px; color: var(--muted);
      font-weight: 650; text-transform: uppercase; letter-spacing: .06em;
    }
    .split { display: grid; grid-template-columns: 1.2fr 1fr; gap: 14px; }
    @media (max-width: 860px) { .split { grid-template-columns: 1fr; } }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px;
      min-height: 120px;
    }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
    th { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: .04em; font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.82rem; }
    .muted { color: var(--muted); }
    .bar-row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
    .bar-label { width: 64px; color: var(--muted); font-size: 0.82rem; }
    .bar-track {
      flex: 1; height: 10px; border-radius: 999px; background: #0c1117;
      border: 1px solid var(--line); overflow: hidden;
    }
    .bar-fill { height: 100%; border-radius: 999px; background: var(--accent); }
    .bar-fill.free { background: var(--free); }
    .bar-fill.pro { background: var(--pro); }
    .bar-fill.ok { background: var(--ok); }
    .bar-fill.bad { background: var(--bad); }
    .bar-fill.warn { background: var(--warn); }
    .bar-n { width: 42px; text-align: right; font-variant-numeric: tabular-nums; font-size: 0.85rem; }
    .tag {
      display: inline-block; padding: 2px 7px; border-radius: 999px;
      border: 1px solid var(--line); font-size: 0.75rem; color: var(--muted);
    }
    .tag.pro { color: var(--pro); border-color: color-mix(in srgb, var(--pro) 40%, var(--line)); }
    .tag.free { color: var(--free); border-color: color-mix(in srgb, var(--free) 40%, var(--line)); }
    .tag.done { color: var(--ok); }
    .tag.failed, .tag.bad { color: var(--bad); }
    .tag.running { color: var(--accent); }
    .tag.queued, .tag.stopped { color: var(--warn); }
    pre {
      margin: 0; padding: 14px; background: var(--panel); border: 1px solid var(--line);
      border-radius: 12px; overflow: auto; font-size: 0.78rem; color: #c8d3de; max-height: 320px;
    }
    details.raw > summary {
      cursor: pointer; color: var(--muted); font-size: 0.82rem;
      text-transform: uppercase; letter-spacing: .05em; font-weight: 650; margin-bottom: 10px;
    }
    a { color: var(--accent); }
    footer { margin-top: 28px; color: var(--muted); font-size: 0.8rem; }
    .err { color: var(--bad); }
    .ops {
      display: grid; gap: 10px;
      margin: 16px 0 8px; padding: 16px;
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
    .ops .note { color: var(--muted); font-size: 0.85rem; line-height: 1.4; margin: 0; }
    .ops code { color: var(--accent); font-size: 0.8rem; }
    #killMsg { font-size: 0.9rem; min-height: 1.2em; }
    .limits { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Eris Cloud Agent</h1>
      <span class="pill" id="readyPill"><span class="dot" id="readyDot"></span><span id="readyLabel">Loading…</span></span>
      <span class="sub" id="stamp"></span>
    </header>
    <p class="sub" id="blurb">Usage &amp; capacity overview for this worker.</p>

    <section class="ops" id="opsRow" aria-label="Force kill all active jobs">
      <h2>Force kill all active jobs</h2>
      <p class="note" id="killHint">
        Aborts every queued and running job on this worker. Paste the admin token from
        <code>ERIS_CLOUD_ADMIN_TOKEN</code> or <code>/var/lib/eris-cloud/admin.token</code>.
      </p>
      <div class="ops-row">
        <button type="button" id="killBtn">Force kill all</button>
        <input type="password" id="adminToken" placeholder="Admin token" autocomplete="off" />
        <span id="killMsg" class="muted"></span>
      </div>
    </section>

    <section>
      <h2>Live capacity</h2>
      <div class="grid" id="liveCards"></div>
    </section>

    <section>
      <h2>Usage today <span class="muted" id="usageDay" style="text-transform:none;letter-spacing:0;font-weight:500"></span></h2>
      <div class="grid" id="todayCards"></div>
      <div class="split" style="margin-top:14px">
        <div class="panel">
          <div class="label muted" style="font-size:0.75rem;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Outcomes today</div>
          <div id="todayBars"></div>
        </div>
        <div class="panel">
          <div class="label muted" style="font-size:0.75rem;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Free plan · 30-day enqueue cap</div>
          <div id="freeUsage"></div>
          <div class="limits" id="limits"></div>
        </div>
      </div>
    </section>

    <section>
      <h2>Process metrics <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">(since worker start / restored)</span></h2>
      <div class="grid" id="processCards"></div>
      <div class="split" style="margin-top:14px">
        <div class="panel">
          <div class="label muted" style="font-size:0.75rem;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Jobs by plan (stored)</div>
          <div id="planBars"></div>
        </div>
        <div class="panel">
          <div class="label muted" style="font-size:0.75rem;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Jobs by status (stored)</div>
          <div id="statusBars"></div>
        </div>
      </div>
    </section>

    <section>
      <h2>Top free users today</h2>
      <div class="panel" id="topUsers">Loading…</div>
    </section>

    <section>
      <h2>Recent jobs</h2>
      <div class="panel" style="padding:0;overflow:auto" id="jobsWrap"><p class="muted" style="padding:14px">Loading…</p></div>
    </section>

    <section>
      <h2>Recent activity</h2>
      <div class="panel" style="padding:0;overflow:auto" id="auditWrap"><p class="muted" style="padding:14px">Loading…</p></div>
    </section>

    <section>
      <details class="raw">
        <summary>Raw status JSON</summary>
        <pre id="raw">Loading…</pre>
      </details>
    </section>

    <footer>
      Auto-refreshes every 5s · API <span class="mono">${PUBLIC_BASE_URL}</span> ·
      <a href="/status.json">/status.json</a> ·
      <a href="/metrics">/metrics</a> ·
      GET public · owners masked · kill-all needs admin token
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
    const card = (label, value, hint, tone) =>
      '<div class="card' + (tone ? ' ' + tone : '') + '"><div class="label">' + esc(label) +
      '</div><div class="value">' + esc(value) + '</div><div class="hint">' + esc(hint || '') + '</div></div>';
    const bars = (items) => {
      const max = Math.max(1, ...items.map((i) => Number(i.n) || 0));
      return items.map((i) => {
        const n = Number(i.n) || 0;
        const pct = Math.round((n / max) * 100);
        return '<div class="bar-row"><div class="bar-label">' + esc(i.label) +
          '</div><div class="bar-track"><div class="bar-fill ' + esc(i.cls || '') +
          '" style="width:' + pct + '%"></div></div><div class="bar-n">' + esc(n) + '</div></div>';
      }).join('');
    };
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
        const m = d.metrics || {};
        const u = d.usage || {};
        const j = d.jobs || {};
        const t = u.today || {};
        document.getElementById('stamp').textContent =
          (d.generatedAt || '') + ' · v' + (d.version || '') + ' · up ' + fmtUptime(m.uptimeSec);
        document.getElementById('blurb').textContent =
          (d.localModel && d.localModel.modelName ? d.localModel.modelName : 'Composer') +
          (d.localModel && d.localModel.cached ? ' · model cached' : '') +
          ' · ' + (d.inference || 'local') +
          (d.gpuMode != null ? ' · gpu=' + d.gpuMode : '');

        const killOk = d.adminKillAllConfigured !== false;
        killBtn.disabled = !killOk;
        killHint.innerHTML = killOk
          ? 'Aborts every queued and running job on this worker. Token: <code>ERIS_CLOUD_ADMIN_TOKEN</code> or <code>podman exec eris-cloud-agent cat /var/lib/eris-cloud/admin.token</code>.'
          : 'Admin kill-all is unavailable on this worker.';

        const capHint = (j.running || 0) + ' / ' + (d.maxParallel ?? '—');
        document.getElementById('liveCards').innerHTML = [
          card('Running', j.running ?? 0, 'active now', (j.running || 0) > 0 ? 'ok' : ''),
          card('Queued', j.queued ?? 0, 'waiting', (j.queued || 0) > 0 ? 'warn' : ''),
          card('Slots', capHint, 'in use / max parallel'),
          card('Queue cap', d.maxQueue ?? '—', 'max queued'),
          card('Model', (d.localModel && d.localModel.status) || '—',
            (d.localModel && d.localModel.cached ? 'cached · ' : '') + ((d.localModel && d.localModel.gpu === false) ? 'CPU' : ((d.localModel && d.localModel.gpu) || d.gpuMode || ''))),
          card('Auth', d.authRequired ? 'Required' : 'Open', d.authRequired ? 'EricServic.es Bearer' : 'anonymous allowed'),
          card('Fleet', (d.fleet && d.fleet.linked) ? 'Linked' : 'Local',
            (d.fleet && d.fleet.agentId) ? String(d.fleet.agentId).slice(0, 16) :
            'enroll via EricServic.es',
            (d.fleet && d.fleet.linked) ? 'ok' : '')
        ].join('');

        document.getElementById('usageDay').textContent = u.day ? '· ' + u.day + ' UTC' : '';
        document.getElementById('todayCards').innerHTML = [
          card('Created', t.created ?? 0, 'jobs started today'),
          card('Done', t.done ?? 0, 'finished ok', (t.done || 0) > 0 ? 'ok' : ''),
          card('Failed', t.failed ?? 0, 'errors', (t.failed || 0) > 0 ? 'bad' : ''),
          card('Stopped', t.stopped ?? 0, 'cancelled'),
          card('Success', t.successRate != null ? t.successRate + '%' : '—', 'terminal jobs today',
            t.successRate != null && t.successRate >= 70 ? 'ok' : t.successRate != null ? 'warn' : ''),
          card('Avg steps', t.avgSteps != null ? t.avgSteps : '—', 'tool-loop depth'),
          card('Free enqueues', u.freeEnqueuesWindow ?? u.freeEnqueuesToday ?? 0, 'last 30 days · free cap'),
          card('Free users', u.freeUsersToday ?? 0,
            (u.freeUsersAtCap || 0) + ' at cap (' + (u.freeJobsPerDay ?? 5) + '/user)')
        ].join('');

        document.getElementById('todayBars').innerHTML = bars([
          { label: 'Done', n: t.done || 0, cls: 'ok' },
          { label: 'Failed', n: t.failed || 0, cls: 'bad' },
          { label: 'Stopped', n: t.stopped || 0, cls: 'warn' },
          { label: 'Running', n: t.running || 0, cls: '' },
          { label: 'Queued', n: t.queued || 0, cls: 'warn' }
        ]) || '<p class="muted">No jobs created today.</p>';

        const lim = u.limits || {};
        const freeCap = u.freeJobsPerDay || lim.freeJobsPerDay || 5;
        const freeUsed = u.freeEnqueuesWindow ?? u.freeEnqueuesToday || 0;
        const freeUsers = Math.max(1, u.freeUsersWindow || u.freeUsersToday || 1);
        const pool = freeCap * freeUsers;
        const freePct = Math.min(100, Math.round((freeUsed / Math.max(1, pool)) * 100));
        document.getElementById('freeUsage').innerHTML =
          '<div class="bar-row"><div class="bar-label">Used</div><div class="bar-track"><div class="bar-fill free" style="width:' +
          freePct + '%"></div></div><div class="bar-n">' + esc(freeUsed) + '</div></div>' +
          '<p class="muted" style="margin:8px 0 0;font-size:0.85rem">Per-user free cap is <strong>' +
          esc(freeCap) + '</strong>/day. Bar shows total free enqueues vs users×cap' +
          (u.freeUsersToday ? ' (' + esc(u.freeUsersToday) + '×' + esc(freeCap) + ')' : '') + '.</p>';
        document.getElementById('limits').innerHTML = [
          ['Free/day', lim.freeJobsPerDay],
          ['Conc. free', lim.maxConcurrentFree],
          ['Conc. pro', lim.maxConcurrentPro],
          ['Parallel', lim.maxParallel],
          ['Queue', lim.maxQueue]
        ].map(([k, v]) => '<span class="tag">' + esc(k) + ': ' + esc(v ?? '—') + '</span>').join('');

        document.getElementById('processCards').innerHTML = [
          card('Enqueues', m.enqueues ?? 0, 'accepted'),
          card('Done', m.jobsDone ?? 0, 'lifetime process', 'ok'),
          card('Failed', m.jobsFailed ?? 0, 'lifetime process', (m.jobsFailed || 0) > 0 ? 'bad' : ''),
          card('Stopped', m.jobsStopped ?? 0, 'cancelled'),
          card('Success', m.successRate != null ? m.successRate + '%' : '—', 'process terminal'),
          card('Auth fails', m.authFailures ?? 0, 'rejected tokens', (m.authFailures || 0) > 0 ? 'warn' : ''),
          card('Tool denied', m.toolDenied ?? 0, 'sandbox blocks'),
          card('HTTP', m.requests ?? 0, 'API requests')
        ].join('');

        const bp = j.byPlan || {};
        document.getElementById('planBars').innerHTML = bars([
          { label: 'Free', n: bp.free || 0, cls: 'free' },
          { label: 'Pro', n: bp.pro || 0, cls: 'pro' },
          { label: 'Other', n: bp.unknown || 0, cls: '' }
        ]);
        const bs = j.byStatus || {};
        document.getElementById('statusBars').innerHTML = bars([
          { label: 'Done', n: bs.done || 0, cls: 'ok' },
          { label: 'Failed', n: bs.failed || 0, cls: 'bad' },
          { label: 'Stopped', n: bs.stopped || 0, cls: 'warn' },
          { label: 'Running', n: bs.running || 0, cls: '' },
          { label: 'Queued', n: bs.queued || 0, cls: 'warn' }
        ]);

        const top = u.topFreeUsers || [];
        if (!top.length) {
          document.getElementById('topUsers').innerHTML = '<p class="muted" style="margin:0">No free-plan enqueues today.</p>';
        } else {
          document.getElementById('topUsers').innerHTML =
            '<table><thead><tr><th>Owner</th><th>Jobs today</th><th>Cap</th><th></th></tr></thead><tbody>' +
            top.map((r) => {
              const pct = Math.min(100, Math.round(((r.jobs || 0) / freeCap) * 100));
              return '<tr><td class="mono">' + esc(r.owner) + '</td><td>' + esc(r.jobs) +
                '</td><td>' + esc(freeCap) + '</td><td style="width:40%"><div class="bar-track"><div class="bar-fill ' +
                (r.atCap ? 'bad' : 'free') + '" style="width:' + pct + '%"></div></div></td></tr>';
            }).join('') + '</tbody></table>';
        }

        const rows = d.recentJobs || [];
        if (!rows.length) {
          document.getElementById('jobsWrap').innerHTML = '<p class="muted" style="padding:14px;margin:0">No jobs yet.</p>';
        } else {
          document.getElementById('jobsWrap').innerHTML =
            '<table><thead><tr><th>ID</th><th>Status</th><th>Plan</th><th>Owner</th><th>Agent</th><th>Step</th><th>Live</th><th>Updated</th></tr></thead><tbody>' +
            rows.map((r) => '<tr>' +
              '<td class="mono">' + esc(String(r.id).slice(0, 8)) + '</td>' +
              '<td><span class="tag ' + esc(r.status) + '">' + esc(r.status) + '</span></td>' +
              '<td><span class="tag ' + esc(r.plan || '') + '">' + esc(r.plan || '—') + '</span></td>' +
              '<td class="mono muted">' + esc(r.owner || '—') + '</td>' +
              '<td>' + esc(r.agentName || r.agentId) + '</td>' +
              '<td>' + esc(r.step) + '</td>' +
              '<td class="muted">' + esc(r.liveStatus) + '</td>' +
              '<td class="mono muted">' + esc(r.updatedAt) + '</td>' +
              '</tr>').join('') +
            '</tbody></table>';
        }

        const audit = d.recentAudit || [];
        if (!audit.length) {
          document.getElementById('auditWrap').innerHTML = '<p class="muted" style="padding:14px;margin:0">No audit events yet.</p>';
        } else {
          document.getElementById('auditWrap').innerHTML =
            '<table><thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead><tbody>' +
            audit.slice().reverse().map((a) => {
              const detail = [];
              if (a.owner) detail.push('owner=' + a.owner);
              if (a.plan) detail.push('plan=' + a.plan);
              if (a.jobId) detail.push('job=' + String(a.jobId).slice(0, 8));
              if (a.count != null) detail.push('count=' + a.count);
              if (a.error) detail.push(a.error);
              if (a.artifacts != null) detail.push('artifacts=' + a.artifacts);
              return '<tr><td class="mono muted">' + esc(a.at || '') + '</td><td>' +
                esc(a.event || '') + '</td><td class="muted">' + esc(detail.join(' · ') || '—') + '</td></tr>';
            }).join('') + '</tbody></table>';
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
