import type { ComponentProps, ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Typography } from '../typography';

type StepStatus = 'complete' | 'active' | 'upcoming';

type StepperStep<T extends string = string> = {
  /** Stable identifier, matched against the stepper's `value`. */
  id: T;
  title: ReactNode;
  description?: ReactNode;
};

type StepperProps<T extends string = string> = Omit<ComponentProps<'ol'>, 'children'> & {
  steps: readonly StepperStep<T>[];
  /**
   * Id of the active step. Steps listed before it show as complete, steps after it as upcoming.
   * An id that matches no step shows every step as upcoming.
   */
  value: T;
  /**
   * The step named by `value` is done as well, so it shows as complete instead of active (e.g. a
   * final step with nothing left to do). It stays the current step for screen readers.
   */
  completed?: boolean;
};

/*
 * Vertical stepper for the dark sidebar. Measurements come from the design:
 * 76px rows overlapping by 1px (circles 75px apart), 28px circles, the active row in a
 * 12px-radius frosted card with a 1px border (so its content sits 1px right of the other rows).
 * Greys are the sidebar foreground (white) at reduced opacity, so it sits on any dark background.
 */

const itemVariants = cva(
  'relative flex min-h-[76px] items-center gap-[14px] rounded-[12px] px-3 not-first:-mt-px',
  {
    variants: {
      status: {
        complete: '',
        active: 'border border-sidebar-foreground/16 bg-sidebar-foreground/16',
        upcoming: '',
      },
    },
  }
);

const indicatorVariants = cva(
  'relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full font-sans text-xs leading-none font-normal',
  {
    variants: {
      status: {
        complete: 'bg-stepper-complete text-stepper-complete-foreground',
        active: 'bg-sidebar-foreground text-stepper-active-foreground',
        upcoming: 'border-[1.5px] border-sidebar-foreground/60 text-sidebar-foreground/90',
      },
    },
  }
);

const titleVariants = cva('', {
  variants: {
    status: {
      complete: 'text-sidebar-foreground/95',
      active: 'text-sidebar-foreground',
      upcoming: 'text-sidebar-foreground/80',
    },
  },
});

const descriptionVariants = cva('', {
  variants: {
    status: {
      complete: 'text-sidebar-foreground/75',
      active: 'text-sidebar-foreground/80',
      upcoming: 'text-sidebar-foreground/60',
    },
  },
});

/**
 * 2px line centred under the circle (12px padding + half of the 28px circle, minus 1px for the line).
 * It stops 10px below a circle and 6px above the next one, as in the design.
 */
const connectorBase = 'pointer-events-none absolute left-[25px] w-0.5';
const connectorColor = (done: boolean) =>
  done ? 'bg-stepper-connector-complete' : 'bg-sidebar-foreground/28';

function statusOf(index: number, activeIndex: number, completed = false): StepStatus {
  if (activeIndex < 0) return 'upcoming';
  if (index < activeIndex) return 'complete';
  if (index === activeIndex) return completed ? 'complete' : 'active';
  return 'upcoming';
}

function Stepper<T extends string>({ steps, value, completed = false, className, ...props }: StepperProps<T>) {
  // Order comes from the list; callers only ever name steps by id.
  const activeIndex = steps.findIndex((step) => step.id === value);

  return (
    <ol data-slot="stepper" className={cn('flex flex-col', className)} {...props}>
      {steps.map((step, index) => {
        const status = statusOf(index, activeIndex, completed);
        const isActive = status === 'active';
        const isCurrent = index === activeIndex;
        // The line between two steps is drawn as this step's "tail" plus the next step's "head",
        // so the two halves meet at the row boundary. The active card covers both of its halves.
        const showHead = index > 0 && !isActive;
        const showTail = index < steps.length - 1 && !isActive;

        return (
          <li
            key={step.id}
            data-status={status}
            aria-current={isCurrent ? 'step' : undefined}
            className={itemVariants({ status })}
          >
            {showHead && (
              <span
                aria-hidden
                data-slot="stepper-connector"
                className={cn(
                  connectorBase,
                  'top-0 h-[calc(50%-20px)]',
                  connectorColor(statusOf(index - 1, activeIndex, completed) === 'complete')
                )}
              />
            )}
            {showTail && (
              <span
                aria-hidden
                data-slot="stepper-connector"
                className={cn(connectorBase, 'bottom-0 h-[calc(50%-24px)]', connectorColor(status === 'complete'))}
              />
            )}

            <span data-slot="stepper-indicator" className={indicatorVariants({ status })}>
              {status === 'complete' ? (
                <>
                  <Check aria-hidden className="size-4" strokeWidth={2} />
                  <span className="sr-only">Completed:</span>
                </>
              ) : (
                <Typography variant="caption" font="secondary" aria-hidden>
                  {index + 1}
                </Typography>
              )}
            </span>

            <div className="flex min-w-0 flex-col">
              <Typography
                as="span"
                className={cn('text-[15px] leading-5 font-medium tracking-wide', titleVariants({ status }))}
              >
                {step.title}
              </Typography>
              {step.description != null && (
                <Typography as="span" className={cn('text-[13px] leading-5 font-light', descriptionVariants({ status }))}>
                  {step.description}
                </Typography>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export { Stepper };
export type { StepperProps, StepperStep, StepStatus };
