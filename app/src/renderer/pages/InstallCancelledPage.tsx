import { Typography } from '@/components/typography';
import { X } from 'lucide-react';

/** Content area shown after the user cancelled the install (by closing the window and choosing to quit). */
export function InstallCancelledPage() {
  const Icon = X;

  return (
    <div className="w-full flex flex-col gap-[32px]">
      <div className="flex flex-col gap-[16px]">
        <div className="w-[48px] h-[48px] rounded-md bg-destructive/10 flex items-center justify-center">
          <Icon aria-hidden size={24} className="text-destructive" />
        </div>
        <div className="flex flex-col gap-[10px]">
          <Typography variant="h1">
            Installation cancelled
          </Typography>
          <Typography variant="body" className="text-subtle-foreground">
            No changes were made to your computer. You can start again whenever you’re ready.
          </Typography>
        </div>
      </div>
    </div>
  );
}
