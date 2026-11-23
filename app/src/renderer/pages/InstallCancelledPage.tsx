import { Typography } from '@/components/typography';

/** Content area shown after the user cancelled the install (by closing the window and choosing to quit). */
export function InstallCancelledPage() {
  return (
    <div className="w-full flex flex-col gap-[10px]">
      <Typography variant="h1">Installation cancelled</Typography>
      <Typography variant="body" className="text-subtle-foreground">
        No changes were made to your computer. You can start again whenever you’re ready.
      </Typography>
    </div>
  );
}
