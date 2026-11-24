import { DetailList } from '@/components/detail-list';
import { Typography } from '@/components/typography';
import { errorCode, failedStepPhrase } from '@/features/install';
import { useAppState } from '@/store';
import { X } from 'lucide-react';

/** Content area shown when the install failed or could not start. */
export function InstallFailedPage() {
  const { summary } = useAppState().install;
  // The first failure is the one that stopped the run; later steps usually fail because of it.
  const failure = summary?.failures?.[0];
  const Icon = X;

  return (
    <div className="w-full flex flex-col gap-[32px]">
      <div className="flex flex-col gap-[22px]">
        <div className="w-[48px] h-[48px] rounded-md bg-destructive/10 flex items-center justify-center">
          <Icon aria-hidden size={24} className="text-destructive" />
        </div>
        <div className="flex flex-col gap-[10px]">
          <Typography variant="h1">
            Installation couldn't finish
          </Typography>
          <Typography variant="body" className="text-subtle-foreground">
            Something went wrong while {failedStepPhrase(failure)}. Your computer was left unchanged.
          </Typography>
        </div>
      </div>
      <DetailList
        items={[
          { id: 'error-code', label: 'Error code', value: errorCode(failure) },
          { id: 'log-file', label: 'Log file', value: summary?.logPath ?? 'Not available' },
        ]}
      />
    </div>
  );
}
