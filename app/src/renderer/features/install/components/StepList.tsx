import { STEP_NAMES, useAppState } from '@/store';
import { stepLabel, stepTone } from '../status';
import { StatusRow } from './StatusRow';

/** Live status of each install step. */
export function StepList() {
  const { steps } = useAppState().install;
  return (
    <ul className="flex flex-col gap-2" aria-label="Install steps">
      {STEP_NAMES.map((name) => (
        <StatusRow key={name} name={name} tone={stepTone(steps[name])} label={stepLabel(steps[name])} />
      ))}
    </ul>
  );
}
