import { resultTone } from '../status';
import { StatusRow } from './StatusRow';

/** Final result of each step, from the summary event. */
export function ResultList({ results }: { results: Record<string, string> }) {
  return (
    <ul className="flex flex-col gap-2" aria-label="Results">
      {Object.entries(results).map(([step, value]) => (
        <StatusRow key={step} name={step} tone={resultTone(value)} label={value} />
      ))}
    </ul>
  );
}
