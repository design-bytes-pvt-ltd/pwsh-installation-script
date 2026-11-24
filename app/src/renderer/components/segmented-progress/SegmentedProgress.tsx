import type { ComponentProps, ReactNode } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Typography } from '../typography';

type SegmentStatus = 'complete' | 'active' | 'upcoming' | 'error';

type ProgressSegment = {
  /** Stable key for the segment. */
  id: string;
  label: ReactNode;
  /** How far this segment is, 0–100. */
  value: number;
  status: SegmentStatus;
};

type SegmentedProgressProps = Omit<ComponentProps<'div'>, 'children'> & {
  segments: readonly ProgressSegment[];
  /** Text above the percentage. */
  label?: ReactNode;
};

/*
 * Progress card from the design: a caption, the overall percentage in large type, then one bar per
 * stage with its name underneath. Bars fill with the brand gradient (red for a failed stage); the
 * active stage's name is darkest, finished ones are slightly lighter, upcoming ones lightest.
 */

const fillVariants = cva('h-full rounded-full transition-[width] duration-500 ease-out', {
  variants: {
    status: {
      complete: 'bg-linear-to-r from-progress-from to-progress-to',
      active: 'bg-linear-to-r from-progress-from to-progress-to',
      upcoming: 'bg-linear-to-r from-progress-from to-progress-to',
      error: 'bg-destructive',
    },
  },
});

const segmentLabelVariants = cva('leading-5', {
  variants: {
    status: {
      complete: 'text-foreground/70',
      active: 'text-foreground',
      upcoming: 'text-subtle-foreground',
      error: 'text-destructive',
    },
  },
});

const clamp = (value: number) => Math.min(100, Math.max(0, value));

/** Overall percentage: every segment weighs the same. */
function overallPercent(segments: readonly ProgressSegment[]): number {
  if (segments.length === 0) return 0;
  return Math.round(segments.reduce((sum, s) => sum + clamp(s.value), 0) / segments.length);
}

function SegmentedProgress({ segments, label = 'Overall progress', className, ...props }: SegmentedProgressProps) {
  const percent = overallPercent(segments);

  return (
    <div
      data-slot="segmented-progress"
      className={cn('flex flex-col gap-[24px] rounded-[24px] border border-progress-border bg-progress-surface px-[32px] py-[28px]', className)}
      {...props}
    >
      <div className="flex flex-col gap-[4px]">
        <Typography as="span" className="text-[13px] leading-5 text-subtle-foreground">
          {label}
        </Typography>
        <Typography
          as="span"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={typeof label === 'string' ? label : 'Overall progress'}
          className="text-[36px] leading-none font-semibold"
        >
          {percent}%
        </Typography>
      </div>

      <ol className="grid gap-[12px]" style={{ gridTemplateColumns: `repeat(${Math.max(segments.length, 1)}, minmax(0, 1fr))` }}>
        {segments.map((segment) => (
          <li key={segment.id} data-status={segment.status} className="flex min-w-0 flex-col gap-[12px]">
            <span aria-hidden data-slot="segmented-progress-track" className="h-[6px] overflow-hidden rounded-full bg-progress-track">
              <span
                data-slot="segmented-progress-fill"
                className={cn('block', fillVariants({ status: segment.status }))}
                style={{ width: `${clamp(segment.value)}%` }}
              />
            </span>
            <Typography variant="caption" as="span" className={cn('truncate', segmentLabelVariants({ status: segment.status }))}>
              {segment.label}
            </Typography>
          </li>
        ))}
      </ol>
    </div>
  );
}

export { SegmentedProgress, overallPercent };
export type { ProgressSegment, SegmentedProgressProps, SegmentStatus };
