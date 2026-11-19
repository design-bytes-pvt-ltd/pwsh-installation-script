import type { FailureSummary } from '../../../../shared/types';

export function FailureList({ failures }: { failures: readonly FailureSummary[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {failures.map((f, i) => (
        <li key={`${f.step}-${i}`} className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2">
          <span className="mr-1.5 font-semibold text-destructive">{f.step}</span>
          <span>{f.summary}</span>
          {f.hint && <p className="mt-1 text-muted-foreground">{f.hint}</p>}
        </li>
      ))}
    </ul>
  );
}
