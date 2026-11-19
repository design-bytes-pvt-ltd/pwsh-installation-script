import type { ModelRow } from '../../../../shared/types';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatGB } from '@/lib/format';
import { cn } from '@/lib/utils';
import { tierClassName } from '../selection';

interface ModelTableProps {
  models: readonly ModelRow[];
  selected: readonly string[];
  onToggle: (name: string, selected: boolean) => void;
}

const HEADERS = ['Model', 'Size', 'Fit', 'Status', 'Description'];

export function ModelTable({ models, selected, onToggle }: ModelTableProps) {
  const chosen = new Set(selected);
  return (
    <Table containerClassName="max-h-[310px] overflow-y-auto rounded-md border">
      {/* Sticky on the whole <thead>: per-cell sticky backgrounds leave hairline seams in Chromium. */}
      <TableHeader className="sticky top-0 z-10 bg-muted">
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-8" aria-label="Selected" />
          {HEADERS.map((h) => (
            <TableHead key={h} className="text-xs text-muted-foreground">
              {h}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.map((m) => (
          <TableRow key={m.name}>
            <TableCell>
              <Checkbox
                checked={chosen.has(m.name)}
                onCheckedChange={(checked) => onToggle(m.name, checked === true)}
                aria-label={`Select ${m.name}`}
              />
            </TableCell>
            <TableCell className="font-semibold">{m.name}</TableCell>
            <TableCell>{formatGB(m.sizeGB)}</TableCell>
            <TableCell className={cn(tierClassName(m.tier))}>{m.tier ? `[${m.tier}]` : ''}</TableCell>
            <TableCell className="font-medium text-info">{m.installed ? 'installed' : ''}</TableCell>
            <TableCell className="whitespace-normal text-muted-foreground">{m.description}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
