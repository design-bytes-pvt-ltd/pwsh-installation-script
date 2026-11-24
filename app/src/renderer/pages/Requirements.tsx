import { useState } from 'react';
import { HardDrive, Loader2, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/button';
import { RequirementsTable } from '@/components/requirements-table';
import { Typography } from '@/components/typography';
import { MIN_REQUIREMENTS_CHECK_MS, requirementResults, useReprobe, type RequirementsStatus } from '@/features/system';
import { useAppState } from '@/store';

type FailedRequirements = Extract<RequirementsStatus, { kind: 'error' | 'blocked' }>;

/** What the person can do about it. */
function hint(status: FailedRequirements, disk: { freeGB: number; requiredGB: number; path: string } | null | undefined): string {
  if (status.kind === 'blocked' && disk) {
    const needed = Math.ceil(disk.requiredGB - disk.freeGB);
    return `Free up at least ${needed} GB on ${disk.path} (empty the Trash or Recycle Bin, or remove large files you no longer need), then check again.`;
  }
  return 'Check again. If it keeps failing, restart the installer.';
}

/**
 * Shown in place of the Get ready content when the system requirements check fails: either the
 * check itself could not run (`error`), or it found a blocker such as too little disk space (`blocked`).
 */
export function RequirementsPage({ status }: { status: FailedRequirements }) {
  const { probe, probeError } = useAppState();
  const reprobe = useReprobe(MIN_REQUIREMENTS_CHECK_MS);
  const [checking, setChecking] = useState(false);

  const checkAgain = async () => {
    setChecking(true);
    try {
      await reprobe();
    } finally {
      setChecking(false);
    }
  };
  

  const Icon = status.kind === 'blocked' ? X : TriangleAlert;

  return (
    <div className="w-full flex flex-col gap-[32px]">
      <div className="flex flex-col gap-[22px]">
        <div className="w-[48px] h-[48px] rounded-md bg-destructive/10 flex items-center justify-center">
          <Icon aria-hidden size={24} className="text-destructive" />
        </div>
        <div className="flex flex-col gap-[10px]">
          <Typography variant="h1" className="tracking-[-0.01em]">
            {status.kind === 'blocked' ? "Your PC needs a few upgrades" : "We couldn't check this computer"}
          </Typography>
          <Typography variant="body" className="text-subtle-foreground">
            Fix the items marked below, then check again.
          </Typography>
        </div>
      </div>

      <RequirementsTable requirements={requirementResults(probe, probeError)} />

      {/* <div role="alert" className="flex flex-col gap-[8px] rounded-[16px] border border-destructive/30 bg-destructive/5 px-[20px] py-[16px]">
        <Typography variant="body" className="font-medium text-destructive">
          {status.message}
        </Typography>
        <Typography variant="small" className="text-subtle-foreground">
          {hint(status, probe?.disk)}
        </Typography>
      </div> */}

      {/* <div>
        <Button disabled={checking} onClick={() => void checkAgain()}>
          {checking ? (
            <span className="inline-flex items-center gap-[6px]">
              <Loader2 aria-hidden size={14} className="animate-spin" />
              Checking…
            </span>
          ) : (
            'Try again'
          )}
        </Button>
      </div> */}
    </div>
  );
}
