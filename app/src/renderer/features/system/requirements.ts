import { Bot, Cpu, Gpu, HardDrive, MemoryStick, Monitor, ScanSearch, Wifi } from 'lucide-react';
import type { Requirement } from '@/components/requirements-table';
import { recommendedModel } from '@/features/models';
import { formatGB } from '@/lib/format';
import type { ProbeResult, TargetOS } from '../../../shared/types';
import { diskTooLow, downloadsNeeded, joinNames } from './checks';

const OS_NAMES: Record<TargetOS, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

type Check = Omit<Requirement, 'id' | 'icon'>;

/**
 * The hardware and system checks, in the order the Requirements table lists them. What is already
 * installed (Ollama, Docker, the dev container) is left out: the install step takes care of that.
 * Only `failed` blocks setup (see requirementsStatus).
 */
const REQUIREMENTS: readonly { id: string; icon: Requirement['icon']; check: (probe: ProbeResult) => Check }[] = [
  {
    id: 'os',
    icon: Monitor,
    // The check only finishes on a supported system; anything else fails it as a whole.
    check: (probe) => ({ label: OS_NAMES[probe.os], status: 'passed' }),
  },
  {
    id: 'cpu',
    icon: Cpu,
    // Likewise only amd64 or arm64 get this far.
    check: (probe) => ({ label: probe.arch === 'arm64' ? '64-bit ARM processor' : '64-bit Intel or AMD processor', status: 'passed' }),
  },
  {
    id: 'ram',
    icon: MemoryStick,
    check: ({ budget }) =>
      budget?.ramGB
        ? { label: `${formatGB(budget.ramGB)} memory (RAM)`, status: 'passed' }
        : { label: 'Memory (RAM)', status: 'info', result: "Couldn't measure" },
  },
  {
    id: 'gpu',
    icon: Gpu,
    check: ({ gpu, os, arch }) => {
      if (gpu) return { label: `${gpu.vendor} graphics card, ${formatGB(gpu.vramGB)}`, status: 'passed' };
      if (os === 'macos' && arch === 'arm64') return { label: 'Apple silicon graphics', status: 'passed', result: 'Shares memory' };
      return { label: 'Graphics card', status: 'info', result: 'None found, AI runs on the processor' };
    },
  },
  {
    id: 'model-memory',
    icon: Bot,
    check: ({ budget, models }) => {
      if (!budget) return { label: 'Memory for AI models', status: 'info', result: "Couldn't measure" };
      const label = `${formatGB(budget.budgetGB)} for AI models`;
      const model = recommendedModel(models);
      if (!model) return { label, status: 'info', result: 'No AI model to download' };
      if (model.tier === 'too large') return { label, status: 'warning', result: `${model.name} needs more, it will be very slow` };
      if (model.tier === 'may be slow') return { label, status: 'warning', result: `${model.name} may run slowly` };
      return { label, status: 'passed' };
    },
  },
  {
    id: 'disk',
    icon: HardDrive,
    check: (probe) => {
      const { disk } = probe;
      if (!disk) return { label: 'Free space', status: 'info', result: "Couldn't measure" };
      const label = `${disk.requiredGB} GB free space`;
      return diskTooLow(probe)
        ? { label, status: 'failed', result: `Needs ${formatGB(disk.requiredGB)} · found ${formatGB(disk.freeGB)}` }
        : { label, status: 'passed' };
    },
  },
  {
    id: 'network',
    icon: Wifi,
    // Setup downloads; the installed app then runs offline. So no internet only fails this when
    // something is still missing.
    check: (probe) => {
      const label = 'Internet connection';
      if (probe.network.online) return { label, status: 'passed' };
      const needed = downloadsNeeded(probe);
      if (needed.length === 0) return { label, status: 'info', result: 'Not needed, everything is installed' };
      return { label, status: 'failed', result: `Needed to download ${joinNames(needed)}` };
    },
  },
];

/**
 * Rows for the Requirements table. When the check itself failed there is nothing to list, so it
 * shows as a single failed "System check" row with the error.
 */
export function requirementResults(probe: ProbeResult | null, probeError: string | null): Requirement[] {
  if (probeError || !probe) {
    return [{ id: 'check', icon: ScanSearch, label: 'System check', status: 'failed', result: probeError ?? 'Not run yet' }];
  }
  return REQUIREMENTS.map(({ id, icon, check }) => ({ id, icon, ...check(probe) }));
}
