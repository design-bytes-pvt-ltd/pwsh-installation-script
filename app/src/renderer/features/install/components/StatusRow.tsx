import type { StatusTone } from '../status';
import { StatusBadge } from './StatusBadge';

/** One "name ........ [badge]" row, used for live steps and for final results. */
export function StatusRow({ name, tone, label }: { name: string; tone: StatusTone; label: string }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2">
      <span>{name}</span>
      <StatusBadge tone={tone}>{label}</StatusBadge>
    </li>
  );
}
