import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import sidebarBg from '@/assets/images/sidebar/sidebar-bg.png';

/**
 * Sidebar background placement. Adjust these to move, scale or dim the image:
 * - size:     `bg-cover` fills the sidebar (crops what doesn't fit), `bg-contain` shows the whole
 *             image, or an exact size such as `bg-size-[auto_120%]` (width height).
 * - position: which part of the image stays in view, e.g. `bg-bottom`, `bg-left-bottom`, or exact
 *             values `bg-position-[30%_100%]` (x y). 0% = left/top edge, 100% = right/bottom edge.
 * - opacity:  how strongly the image shows over the black sidebar, `opacity-0` to `opacity-100`
 *             in steps of 5 (`opacity-35`), or any value with `opacity-[0.42]`. Text is not affected.
 */
const SIDEBAR_BG_SIZE = 'bg-cover';
const SIDEBAR_BG_POSITION = 'bg-position-[50%_100%]';
const SIDEBAR_BG_OPACITY = 'opacity-30';

/** Window layout: a fixed-width black sidebar on the left and the white content area on the right. */
export function AppLayout({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-screen w-full overflow-hidden">
      <aside className="relative isolate flex w-66 shrink-0 flex-col overflow-y-auto bg-sidebar p-9 text-sidebar-foreground">
        {/* Background image on its own layer, so its opacity doesn't fade the sidebar text. The URL is
            only known after Vite bundles the image, so it goes in `style`. */}
        <div
          aria-hidden
          style={{ backgroundImage: `url(${sidebarBg})` }}
          className={cn(
            'pointer-events-none absolute inset-0 -z-10 bg-no-repeat',
            SIDEBAR_BG_SIZE,
            SIDEBAR_BG_POSITION,
            SIDEBAR_BG_OPACITY
          )}
        />
        {sidebar}
      </aside>
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background p-12 text-foreground">{children}</main>
    </div>
  );
}
