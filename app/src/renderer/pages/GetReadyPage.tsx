import { HardDrive, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { Banner } from '@/components/banner';
import { Typography } from '@/components/typography';
import { MIN_REQUIREMENTS_CHECK_MS, requirementsStatus, useProbe, useReprobe } from '@/features/system';
import { useAppState } from '@/store';
import HerBanner from '@/assets/images/banner/hero-banner.svg';

const features = [
  {
    icon: ShieldCheck,
    description: 'Works fully offline, no internet needed',
  },
  {
    icon: Lock,
    description: 'Your data stays on this computer',
  },
  {
    icon: HardDrive,
    description: 'Needs about 60 GB of space on drive C',
  },
];

/**
 * Footer text left of "Get Started": progress of the system requirements check, why it blocks
 * setup, or the usual note once everything is fine.
 */
export function GetReadyFooterNote() {
  const { probe, probeError } = useAppState();
  const reprobe = useReprobe(MIN_REQUIREMENTS_CHECK_MS);
  const status = requirementsStatus(probe, probeError);

  switch (status.kind) {
    case 'checking':
      return (
        <span role="status" className="inline-flex items-center gap-[6px]">
          <Loader2 aria-hidden size={12} className="animate-spin" />
          Checking system requirements…
        </span>
      );
    case 'error':
      return (
        <span role="alert" className="inline-flex items-center gap-[6px] text-destructive">
          {status.message}
          <button type="button" className="cursor-pointer font-semibold underline" onClick={() => void reprobe()}>
            Try again
          </button>
        </span>
      );
    case 'blocked':
      return (
        <span role="alert" className="text-destructive">
          {status.message}
        </span>
      );
    case 'ready':
      return 'Takes about 30 minutes';
  }
}

/** Content area for the "Get ready" step. Starts the system requirements check on mount. */
export function GetReadyPage() {
  useProbe(MIN_REQUIREMENTS_CHECK_MS);
  return (
    <div className="w-full flex flex-col gap-[32px]">
      <Banner src={HerBanner} alt="Hero banner" />
      <div className="flex flex-col gap-[10px]">
        <Typography variant="h1">
          Welcome to Enterprise Brain
        </Typography>
        <Typography variant="body" className="text-subtle-foreground">
          Your private AI workspace, running on this computer.
        </Typography>
      </div>
      <div className="flex flex-col gap-[16px]">
        {features.map((feature, index) => (
          <div key={index} className="flex flex-row gap-[12px] items-center">
            <div className="w-[28px] h-[28px] rounded-full bg-icon-badge flex items-center justify-center">
              <feature.icon aria-hidden size={14} className="text-icon-badge-foreground" />
            </div>
            <Typography variant="body">
              {feature.description}
            </Typography>
          </div>
        ))}
      </div>
    </div>
  );
}
