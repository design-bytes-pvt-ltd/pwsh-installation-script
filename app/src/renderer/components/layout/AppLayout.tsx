import type { ReactNode } from 'react';
import { APP_VERSION } from '@/lib/version';
import sidebarBg from '@/assets/images/sidebar/sidebar-bg-cover.svg';
import { Typography } from '../typography';

/** Window layout: a fixed-width black sidebar on the left and the white content area on the right. */
export function AppLayout({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-screen w-full overflow-hidden">
      {/* The background SVG is the finished design (crop and gradient included), so it is used as is.
          Its URL is only known after Vite bundles it, so it goes in `style`. */}
      <aside
        style={{ backgroundImage: `url(${sidebarBg})` }}
        className="flex w-66 shrink-0 flex-col overflow-y-auto bg-sidebar bg-cover bg-center bg-no-repeat px-[24px] pt-[26px] pb-[32px] text-sidebar-foreground"
      >
        {sidebar}
        <div className="mt-auto pl-[12px]">
          <Typography font="secondary" variant="caption">Version: {APP_VERSION}</Typography>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background text-foreground">
        {children}
        <div className="mt-auto py-[32px] px-[48px] flex flex-row items-center justify-between border-t border-divider">
          <Typography font="secondary" variant="caption" className="text-subtle-foreground">Takes about 30 minutes</Typography>
          <Typography font="secondary" variant="caption">hello</Typography>
        </div>
      </main>
    </div>
  );
}
