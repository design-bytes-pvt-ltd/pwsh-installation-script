import { Typography } from '@/components/typography';
import { errorCode, failedStepPhrase } from '@/features/install';
import { useAppState } from '@/store';

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-[4px]">
      <Typography variant="caption" className="text-subtle-foreground">
        {label}
      </Typography>
      <Typography variant="small" font="secondary" className="break-all select-text">
        {value}
      </Typography>
    </div>
  );
}

/** Content area shown when the install failed or could not start. */
export function InstallFailedPage() {
  const { summary } = useAppState().install;
  // The first failure is the one that stopped the run; later steps usually fail because of it.
  const failure = summary?.failures?.[0];

  return (
    <div className="w-full flex flex-col gap-[32px]">
      <div className="flex flex-col gap-[10px]">
        <Typography variant="h1">Installation couldn't finish</Typography>
        <Typography variant="body" className="text-subtle-foreground">
          Something went wrong while {failedStepPhrase(failure)}. Your computer was left unchanged.
        </Typography>
      </div>
      <div className="flex flex-col gap-[16px]">
        <DetailRow label="Error code" value={errorCode(failure)} />
        {summary?.logPath && <DetailRow label="Log file" value={summary.logPath} />}
      </div>
    </div>
  );
}
