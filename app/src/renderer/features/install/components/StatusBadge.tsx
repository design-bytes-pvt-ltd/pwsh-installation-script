import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { StatusTone } from '../status';

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: 'bg-secondary text-secondary-foreground',
  running: 'bg-primary text-primary-foreground',
  done: 'bg-success text-success-foreground',
  failed: 'bg-destructive text-destructive-foreground',
  cancelled: 'bg-warning text-warning-foreground',
};

export function StatusBadge({ tone, children }: { tone: StatusTone; children: string }) {
  return (
    <Badge data-tone={tone} className={cn('rounded-sm', TONE_CLASSES[tone])}>
      {children}
    </Badge>
  );
}
