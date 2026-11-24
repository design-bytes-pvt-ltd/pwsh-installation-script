import type { ReactNode } from 'react';
import { APP_VERSION } from '@/lib/version';
import sidebarBg from '@/assets/images/sidebar/sidebar-bg-cover.svg';
import { Typography } from '../typography';
import SoftGlow from '@/assets/images/background/soft-glow.svg';

type AppLayoutProps = {
  sidebar: ReactNode;
  children: ReactNode;
  /** Bar pinned to the bottom of the content area. Its children are spread to both ends. */
  footer?: ReactNode;
};

/** Window layout: a fixed-width black sidebar on the left and the white content area on the right. */
export function AppLayout({ sidebar, children, footer }: AppLayoutProps) {
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
          <Typography font="secondary" variant="caption">Version {APP_VERSION}</Typography>
        </div>
      </aside>
      {/* `isolate` lets the glow sit at -z-10: above main's background, behind the page content. */}
      <main className="relative isolate flex min-w-0 flex-1 flex-col overflow-y-auto bg-background text-foreground">
        {/* An imported .svg is a URL (Vite), so it goes in an <img>, not used as a component. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          <img src={SoftGlow} alt="" className="absolute top-0 right-0" />
        </div>
        {children}
        {footer != null && (
          <div className="mt-auto py-[24px] px-[32px] flex flex-row items-center justify-between border-t border-divider">
            {footer}
          </div>
        )}
      </main>
    </div>
  );
}
