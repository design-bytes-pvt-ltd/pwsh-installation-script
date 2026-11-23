import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Typography } from '../typography';

type DetailItem = {
  /** Stable key for the row. */
  id: string;
  label: ReactNode;
  value: ReactNode;
};

type DetailListProps = Omit<ComponentProps<'dl'>, 'children'> & {
  items: readonly DetailItem[];
};

/**
 * Label / value pairs on a tinted card, one row each: the label on the left, the value (in the
 * mono font, selectable) on the right. Rows are separated by a divider. E.g. the error code and
 * log file on the "Installation couldn't finish" page.
 */
function DetailList({ items, className, ...props }: DetailListProps) {
  return (
    <dl
      data-slot="detail-list"
      className={cn('flex flex-col divide-y divide-divider rounded-md bg-detail-list px-[16px]', className)}
      {...props}
    >
      {items.map(({ id, label, value }) => (
        <div key={id} className="flex flex-row flex-wrap items-center justify-between gap-x-[16px] gap-y-[4px] py-[14px]">
          <Typography as="dt" variant="body" className="text-subtle-foreground">
            {label}
          </Typography>
          <Typography as="dd" variant="caption" font="secondary" className="min-w-0 break-all text-right select-text">
            {value}
          </Typography>
        </div>
      ))}
    </dl>
  );
}

export { DetailList };
export type { DetailItem, DetailListProps };
