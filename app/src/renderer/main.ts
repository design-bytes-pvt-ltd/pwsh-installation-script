import type { InstallerApi } from '../shared/api';
import type { InstallEvent, ModelRow, ProbeResult } from '../shared/types';

declare global {
  interface Window {
    installerApi: InstallerApi;
  }
}

let probeData: ProbeResult | null = null;
const selectedModels = new Set<string>();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const bannerEl = $('system-banner');
const modelsBodyEl = $('models-body');
const downloadSummaryEl = $('download-summary');
const logOutputEl = $('log-output');
const progressLabelEl = $('progress-label');
const progressFillEl = $('progress-fill');
const startBtn = $<HTMLButtonElement>('btn-start');
const cancelBtn = $<HTMLButtonElement>('btn-cancel');

/** Creates an element with plain-text content (never parsed as HTML). */
function el(tag: string, text = '', className = ''): HTMLElement {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function showScreen(step: 1 | 2 | 3): void {
  const map = { 1: 'screen-configure', 2: 'screen-progress', 3: 'screen-summary' } as const;
  ([1, 2, 3] as const).forEach((s) => {
    $(map[s]).classList.toggle('active', s === step);
    $(`ind-${s}`).classList.toggle('active', s === step);
  });
}

function updateSummaryText(): void {
  if (!probeData) return;
  let totalGB = 0;
  for (const m of probeData.models) {
    if (selectedModels.has(m.name) && !m.installed && m.sizeGB) totalGB += m.sizeGB;
  }
  downloadSummaryEl.textContent = `${selectedModels.size} selected (${totalGB.toFixed(1)} GB to download)`;
}

function tierClass(tier: ModelRow['tier']): string {
  if (tier === 'recommended') return 'tier-recommended';
  if (tier === 'may be slow') return 'tier-slow';
  return 'tier-large';
}

function renderModels(models: ModelRow[]): void {
  modelsBodyEl.replaceChildren();
  for (const m of models) {
    const tr = document.createElement('tr');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedModels.has(m.name);
    cb.setAttribute('aria-label', `Select ${m.name}`);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedModels.add(m.name);
      else selectedModels.delete(m.name);
      updateSummaryText();
    });
    const cbTd = el('td');
    cbTd.appendChild(cb);

    const nameTd = el('td');
    nameTd.appendChild(el('strong', m.name));

    tr.append(
      cbTd,
      nameTd,
      el('td', m.sizeGB ? `${m.sizeGB.toFixed(1)} GB` : '?'),
      el('td', m.tier ? `[${m.tier}]` : '', tierClass(m.tier)),
      el('td', m.installed ? 'installed' : '', 'status-installed'),
      el('td', m.description)
    );
    modelsBodyEl.appendChild(tr);
  }
  updateSummaryText();
}

function selectDefault(): void {
  selectedModels.clear();
  for (const m of probeData?.models ?? []) {
    if (m.isDefault) selectedModels.add(m.name);
  }
}

async function init(): Promise<void> {
  probeData = await window.installerApi.probe();
  const budgetText = probeData.budget
    ? `${probeData.budget.source} (recommending up to ${probeData.budget.budgetGB} GB)`
    : 'Memory budget unknown';
  bannerEl.textContent = `OS: ${probeData.os} (${probeData.arch}) | ${budgetText}`;

  $('status-ollama').textContent = probeData.ollamaInstalled ? '(already installed)' : '';
  $('status-docker').textContent = probeData.dockerInstalled !== 'none' ? `(${probeData.dockerInstalled} installed)` : '';
  $('wrap-docker-engine').hidden = probeData.os !== 'linux';

  selectDefault();
  renderModels(probeData.models);
}

$('btn-select-none').addEventListener('click', () => {
  selectedModels.clear();
  if (probeData) renderModels(probeData.models);
});

$('btn-select-rec').addEventListener('click', () => {
  if (!probeData) return;
  selectDefault();
  renderModels(probeData.models);
});

startBtn.addEventListener('click', async () => {
  if (!probeData) return;
  const tooLarge = probeData.models.filter((m) => selectedModels.has(m.name) && m.tier === 'too large');
  if (tooLarge.length > 0) {
    const ok = window.confirm(
      `The following models are tagged "too large" for this machine: ${tooLarge.map((m) => m.name).join(', ')}. Pull anyway?`
    );
    if (!ok) return;
  }

  logOutputEl.textContent = '';
  progressFillEl.style.width = '0%';
  progressLabelEl.textContent = 'Starting setup...';
  (['Ollama', 'Models', 'Docker'] as const).forEach((s) => {
    const badge = $(`step-${s}`);
    badge.textContent = 'pending';
    badge.className = 'badge';
  });

  startBtn.disabled = true;
  cancelBtn.disabled = false;
  showScreen(2);

  try {
    await window.installerApi.startInstall({
      installOllama: $<HTMLInputElement>('opt-ollama').checked,
      installDocker: $<HTMLInputElement>('opt-docker').checked,
      dockerEngineOnLinux: $<HTMLInputElement>('opt-docker-engine').checked,
      dryRun: $<HTMLInputElement>('opt-dry-run').checked,
      models: Array.from(selectedModels),
    });
  } catch (err) {
    progressLabelEl.textContent = `Could not start: ${(err as Error).message}`;
  } finally {
    startBtn.disabled = false;
  }
});

cancelBtn.addEventListener('click', async () => {
  cancelBtn.disabled = true;
  progressLabelEl.textContent = 'Cancelling...';
  await window.installerApi.cancelInstall();
});

$('btn-restart').addEventListener('click', async () => {
  showScreen(1);
  await init();
});

$('btn-show-log').addEventListener('click', () => {
  void window.installerApi.showLog();
});

$('btn-copy-report').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('btn-copy-report');
  const copied = await window.installerApi.copyErrorReport();
  btn.textContent = copied ? 'Copied' : 'Nothing to copy';
  setTimeout(() => (btn.textContent = 'Copy error report'), 2000);
});

// Send unexpected renderer errors to the main process so they land in the log file.
window.addEventListener('error', (e) => {
  void window.installerApi.reportError({
    message: e.message || String(e.error),
    stack: e.error instanceof Error ? e.error.stack : undefined,
    source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
  });
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  void window.installerApi.reportError({
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

function renderSummary(event: Extract<InstallEvent, { type: 'summary' }>): void {
  const resultsEl = $('summary-results');
  resultsEl.replaceChildren();
  for (const [step, value] of Object.entries(event.results)) {
    const cls = value.startsWith('FAILED:') ? 'failed' : value === 'cancelled' ? 'cancelled' : value === 'skipped' ? '' : 'done';
    const row = el('div', '', 'step-row');
    row.append(el('span', step), el('span', value, `badge ${cls}`.trim()));
    resultsEl.appendChild(row);
  }

  const failures = event.failures ?? [];
  $('summary-failures').replaceChildren(
    ...failures.map((f) => {
      const li = el('li');
      li.append(el('span', f.step, 'failure-step'), el('span', f.summary));
      if (f.hint) li.appendChild(el('p', f.hint, 'failure-hint'));
      return li;
    })
  );
  $('summary-failures-wrap').hidden = failures.length === 0;
  $('btn-copy-report').hidden = failures.length === 0;

  const notesEl = $('summary-notes');
  notesEl.replaceChildren(...event.notes.map((n) => el('li', n)));
  $('summary-notes-wrap').hidden = event.notes.length === 0;

  $('summary-log').textContent = event.logPath ? `Log: ${event.logPath}` : '';
  $('btn-show-log').hidden = !event.logPath;
  $('summary-title').textContent = event.cancelled
    ? 'Setup Cancelled'
    : event.exitCode === 0
      ? 'Setup Complete'
      : 'Setup Finished with Errors';
  showScreen(3);
}

window.installerApi.onEvent((event: InstallEvent) => {
  if (event.type === 'step') {
    const badge = document.getElementById(`step-${event.step}`);
    if (badge) {
      badge.textContent = event.detail ? `${event.status}: ${event.detail}` : event.status;
      badge.className = `badge ${event.status}`;
    }
  } else if (event.type === 'progress') {
    progressLabelEl.textContent = `${event.step}: ${event.label}`;
    if (typeof event.percent === 'number') progressFillEl.style.width = `${event.percent}%`;
  } else if (event.type === 'log') {
    logOutputEl.append(`[${event.level}] ${event.message}\n`);
    logOutputEl.scrollTop = logOutputEl.scrollHeight;
  } else if (event.type === 'summary') {
    renderSummary(event);
  }
});

init().catch((err) => {
  bannerEl.textContent = `Initialization error: ${(err as Error).message}`;
});
