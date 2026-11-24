import { useId } from 'react';
import { Loader2, type LucideProps } from 'lucide-react';
import { cn } from '@/lib/utils';

type SpinnerProps = Omit<LucideProps, 'color' | 'children'> & {
  /** Colour of the spinner's head; the tail fades out to transparent. */
  color?: string;
};

/**
 * Spinning arc for work in progress (e.g. "Checking system requirements…"). The arc is drawn with
 * a gradient that is solid at its leading end and fades towards its tail. Decorative by default:
 * put the text that describes the work next to it.
 */
function Spinner({ color = '#256156', size = 16, className, ...props }: SpinnerProps) {
  // useId output contains characters that don't belong in a url(#…) reference.
  const gradientId = `spinner-gradient-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  return (
    <Loader2
      aria-hidden
      data-slot="spinner"
      size={size}
      color={`url(#${gradientId})`}
      className={cn('shrink-0 animate-spin', className)}
      {...props}
    >
      <defs>
        {/* Loader2's arc runs clockwise from 3 o'clock round to 1 o'clock, so a diagonal from the
            bottom right (tail) to the top left (head) follows it closely enough. */}
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="18.4" y1="18.4" x2="5.6" y2="5.6">
          <stop offset="0%" stopColor={color} stopOpacity={0.15} />
          <stop offset="100%" stopColor={color} stopOpacity={1} />
        </linearGradient>
      </defs>
    </Loader2>
  );
}

export { Spinner };
export type { SpinnerProps };
