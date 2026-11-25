import { HardDrive, Lock, ShieldCheck } from 'lucide-react';
import { Banner } from '@/components/banner';
import { Typography } from '@/components/typography';
import { MIN_REQUIREMENTS_CHECK_MS, requirementsStatus, useProbe } from '@/features/system';
import { useAppState } from '@/store';
import HerBanner from '@/assets/images/banner/hero-banner.svg';
import { RequirementsPage } from './Requirements';

const features = [
  {
    icon: ShieldCheck,
    description: 'Works offline once installed',
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
 * Footer text left of "Get Started": progress of the system requirements check, a pointer to the
 * Requirements page when it failed, or the usual note once everything is fine.
 */
export function GetReadyFooterNote() {
  const { probe, probeError } = useAppState();
  const status = requirementsStatus(probe, probeError);

  switch (status.kind) {
    case 'checking':
      // The progress spinner sits next to the footer button (see App).
      return 'Takes about 30 minutes';
    case 'blocked':
      if (status.reason === 'offline') return 'Connect to the internet to continue';
      return 'Share this list with your IT team';
    case 'error':
      // The Requirements page in the content area explains what is wrong.
      return 'Share this list with your IT team';
    case 'ready':
      return 'Takes about 30 minutes';
  }
}

/**
 * Content area for the "Get ready" step. Starts the system requirements check on mount, and shows
 * the Requirements page instead of the welcome content when the check fails.
 */
export function GetReadyPage() {
  useProbe(MIN_REQUIREMENTS_CHECK_MS);
  const { probe, probeError } = useAppState();
  const status = requirementsStatus(probe, probeError);
  if (status.kind === 'error' || status.kind === 'blocked') return <RequirementsPage status={status} />;

  return (
    <div className="w-full flex flex-col gap-[32px]">
      <Banner src={HerBanner} alt="Hero banner" />
      <div className="flex flex-col gap-[10px]">
        <Typography variant="h1" className="tracking-[-0.005em]">
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
            <Typography variant="body" className="tracking-tight">
              {feature.description}
            </Typography>
          </div>
        ))}
      </div>
    </div>
  );
}
