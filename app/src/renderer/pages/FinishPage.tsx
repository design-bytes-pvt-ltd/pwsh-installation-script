import { Banner } from '@/components/banner';
import { Typography } from '@/components/typography';
import SuccessBanner from '@/assets/images/banner/success-banner.svg';

/** Content area for the "Finish" step. */
export function FinishPage() {
  return (
    <div className="flex flex-col gap-[32px]">
      <Banner src={SuccessBanner} alt="Success banner" />
      <div className="flex flex-col gap-[10px]">
        <Typography variant="h1">Enterprise Brain is ready</Typography>
        <Typography variant="body" className="text-subtle-foreground">
          Installation is complete. Everything runs on this computer, no internet needed.
        </Typography>
      </div>
    </div>
  )
}
