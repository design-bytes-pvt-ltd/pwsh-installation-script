import type { ComponentProps, ReactNode } from 'react';
import { Check, CircleCheck, CircleX, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Typography } from '../typography';

/**
 * - `passed`: the requirement is met.
 * - `failed`: it is not, and setup can't continue.
 * - `warning`: worth knowing, but setup continues (e.g. the AI model may run slowly).
 * - `info`: neither good nor bad (e.g. "Will be installed").
 */
type RequirementStatus = 'passed' | 'failed' | 'warning' | 'info';

type Requirement = {
  /** Stable key for the row. */
  id: string;
  /** Icon for what is being checked (e.g. a hard drive for disk space). */
  icon: LucideIcon;
  label: ReactNode;
  status: RequirementStatus;
  /** Text on the right. Defaults to "Passed" / "Failed"; give the reason for anything but `passed`. */
  result?: ReactNode;
};

type RequirementsTableProps = Omit<ComponentProps<'ul'>, 'children'> & {
  requirements: readonly Requirement[];
};

/*
 * List of system requirements in a bordered card, one row each: icon and name on the left, the
 * result on the right. A failed row turns light red with its reason in red.
 */

const STATUS_ICON: Record<RequirementStatus, LucideIcon> = {
  passed: Check,
  failed: X,
  warning: TriangleAlert,
  info: Info,
};

const DEFAULT_RESULT: Record<RequirementStatus, string> = {
  passed: 'Passed',
  failed: 'Failed',
  warning: '',
  info: '',
};

// Plain rows are separated by a bottom border. Failed and warning rows are tinted, rounded cards
// instead, so they drop the border.
const rowVariants = cva('flex flex-row items-center justify-between gap-[14px] px-[16px] py-[10px]', {
  variants: {
    status: {
      passed: 'border-b border-divider',
      failed: 'rounded-[10px] bg-destructive-subtle',
      warning: 'rounded-[10px] bg-warning/10',
      info: 'border-b border-divider',
    },
  },
});

// Round badge holding the status icon: solid for passed / failed, tinted for warning / info.
const statusIconVariants = cva('flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full', {
  variants: {
    status: {
      passed: 'bg-requirement-passed text-requirement-passed-foreground',
      failed: 'bg-requirement-failed text-requirement-failed-foreground',
      warning: 'bg-warning/10 text-warning',
      info: 'bg-subtle-foreground/10 text-subtle-foreground',
    },
  },
});

const resultVariants = cva('text-right', {
  variants: {
    status: {
      passed: 'text-requirement-passed-text',
      failed: 'text-requirement-failed',
      warning: 'text-foreground',
      info: 'text-subtle-foreground',
    },
  },
});

function RequirementsTable({ requirements, className, ...props }: RequirementsTableProps) {
  return (
    <ul
      data-slot="requirements-table"
      aria-label="System requirements"
      className={cn('flex flex-col gap-[4px] rounded-[16px] border border-divider p-[8px]', className)}
      {...props}
    >
      {requirements.map(({ id, icon: Icon, label, status, result }) => {
        const StatusIcon = STATUS_ICON[status];
        return (
          <li key={id} data-status={status} className={rowVariants({ status })}>
            <div className="flex min-w-0 flex-row items-center gap-[14px]">
              <Icon aria-hidden size={20} className="shrink-0 text-requirement-icon" />
              <Typography variant="body" className="text-[14px]">
                {label}
              </Typography>
            </div>

            <div className="flex min-w-0 flex-row items-center gap-[8px]">
              <div aria-hidden className={statusIconVariants({ status })}>
                <StatusIcon aria-hidden size={12} />
              </div>
              <Typography variant="small" className={resultVariants({ status })}>
                {result ?? DEFAULT_RESULT[status]}
              </Typography>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export { RequirementsTable };
export type { Requirement, RequirementsTableProps, RequirementStatus };
