import type { InstallerApi } from '../main/preload';
import type { InstallEvent, ModelRow, ProbeResult } from '../main/core/types';

declare global {
  interface Window {
    installerApi: InstallerApi;
  }
}

let probeData: ProbeResult | null = null;
const selectedModels = new Set<string>();

const bannerEl = document.getElementById('system-banner')!;
const modelsBodyEl = document.getElementById('models-body')!;
const downloadSummaryEl = document.getElementById('download-summary')!;
const logOutputEl = document.getElementById('log-output')!;
const progressLabelEl = document.getElementById('progress-label')!;
const progressFillEl = document.getElementById('progress-fill')!;

function showScreen(step: 1 | 2 | 3): void {
  const map = { 1: 'screen-configure', 2: 'screen-progress', 3: 'screen-summary' } as const;
  ([1, 2, 3] as const).forEach((s) => {
    document.getElementById(map[s])!.classList.toggle('active', s === step);
    document.getElementById(`ind-${s}`)!.classList.toggle('active', s === step);
  });
}

function updateSummaryText(): void {
  if (!probeData) return;
  let totalGB = 0;
  for (const m of probeData.models) {
    if (selectedModels.has(m.name) && !m.installed && m.sizeGB) {
      totalGB += m.sizeGB;
    }
  }
  downloadSummaryEl.textContent = `${selectedModels.size} selected (${totalGB.toFixed(1)} GB to download)`;
}

function renderModels(models: ModelRow[]): void {
  modelsBodyEl.innerHTML = '';
  for (const m of models) {
    const tr = document.createElement('tr');
    const tierClass =
      m.tier === 'recommended' ? 'tier-recommended' : m.tier === 'may be slow' ? 'tier-slow' : 'tier-large';

    const cbTd = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedModels.has(m.name);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedModels.add(m.name);
      else selectedModels.delete(m.name);
      updateSummaryText();
    });
    cbTd.appendChild(cb);

    tr.appendChild(cbTd);
    tr.insertAdjacentHTML(
      'beforeend',
      `<td><strong>${m.name}</strong></td>
       <td>${m.sizeGB ? `${m.sizeGB.toFixed(1)} GB` : '?'}</td>
       <td class="${tierClass}">${m.tier ? `[${m.tier}]` : ''}</td>
       <td class="status-installed">${m.installed ? 'installed' : ''}</td>
       <td>${m.description}</td>`
    );
    modelsBodyEl.appendChild(tr);
  }
  updateSummaryText();
}

async function init(): Promise<void> {
  probeData = await window.installerApi.probe();
  const budgetText = probeData.budget
    ? `${probeData.budget.source} (recommending up to ${probeData.budget.budgetGB} GB)`
    : 'Memory budget unknown';
  bannerEl.textContent = `OS: ${probeData.os} (${probeData.arch}) | ${budgetText}`;

  document.getElementById('status-ollama')!.textContent = probeData.ollamaInstalled ? '(already installed)' : '';
  document.getElementById('status-docker')!.textContent =
    probeData.dockerInstalled !== 'none' ? `(${probeData.dockerInstalled} installed)` : '';

  if (probeData.os === 'linux') {
    document.getElementById('wrap-docker-engine')!.style.display = 'flex';
  }

  selectedModels.clear();
  for (const m of probeData.models) {
    if (m.isDefault) selectedModels.add(m.name);
  }
  renderModels(probeData.models);
}

document.getElementById('btn-select-none')!.addEventListener('click', () => {
  selectedModels.clear();
  if (probeData) renderModels(probeData.models);
});

document.getElementById('btn-select-rec')!.addEventListener('click', () => {
  if (!probeData) return;
  selectedModels.clear();
  for (const m of probeData.models) {
    if (m.isDefault) selectedModels.add(m.name);
  }
  renderModels(probeData.models);
});

document.getElementById('btn-start')!.addEventListener('click', async () => {
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
    const el = document.getElementById(`step-${s}`)!;
    el.textContent = 'pending';
    el.className = 'badge';
  });

  showScreen(2);

  await window.installerApi.startInstall({
    installOllama: (document.getElementById('opt-ollama') as HTMLInputElement).checked,
    installDocker: (document.getElementById('opt-docker') as HTMLInputElement).checked,
    dockerEngineOnLinux: (document.getElementById('opt-docker-engine') as HTMLInputElement).checked,
    dryRun: (document.getElementById('opt-dry-run') as HTMLInputElement).checked,
    models: Array.from(selectedModels),
  });
});

document.getElementById('btn-cancel')!.addEventListener('click', async () => {
  await window.installerApi.cancelInstall();
});

document.getElementById('btn-restart')!.addEventListener('click', async () => {
  showScreen(1);
  await init();
});

window.installerApi.onEvent((event: InstallEvent) => {
  if (event.type === 'step') {
    const el = document.getElementById(`step-${event.step}`);
    if (el) {
      el.textContent = event.detail ? `${event.status}: ${event.detail}` : event.status;
      el.className = `badge ${event.status}`;
    }
  } else if (event.type === 'progress') {
    progressLabelEl.textContent = `${event.step}: ${event.label}`;
    if (typeof event.percent === 'number') {
      progressFillEl.style.width = `${event.percent}%`;
    }
  } else if (event.type === 'log') {
    logOutputEl.textContent += `[${event.level}] ${event.message}\n`;
    logOutputEl.scrollTop = logOutputEl.scrollHeight;
  } else if (event.type === 'summary') {
    const resultsEl = document.getElementById('summary-results')!;
    resultsEl.innerHTML = '';
    for (const [k, v] of Object.entries(event.results)) {
      const cls = v.startsWith('FAILED:') ? 'failed' : v === 'skipped' ? '' : 'done';
      resultsEl.insertAdjacentHTML(
        'beforeend',
        `<div class="step-row"><span>${k}</span><span class="badge ${cls}">${v}</span></div>`
      );
    }
    const notesWrap = document.getElementById('summary-notes-wrap')!;
    const notesEl = document.getElementById('summary-notes')!;
    notesEl.innerHTML = '';
    if (event.notes.length > 0) {
      notesWrap.style.display = 'block';
      for (const n of event.notes) {
        const li = document.createElement('li');
        li.textContent = n;
        notesEl.appendChild(li);
      }
    } else {
      notesWrap.style.display = 'none';
    }
    document.getElementById('summary-title')!.textContent =
      event.exitCode === 0 ? 'Setup Complete' : 'Setup Finished with Errors';
    showScreen(3);
  }
});

init().catch((err) => {
  bannerEl.textContent = `Initialization error: ${(err as Error).message}`;
});
