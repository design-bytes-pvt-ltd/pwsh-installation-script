import { useState } from 'react';
import { AppLayout } from '@/components/layout';
import { Typography } from '@/components/typography';
import { Button } from '@/components/button';
import { Stepper } from '@/components/stepper';
import { useInstallerEvents } from '@/features/install';
import { useProbe } from '@/features/system';
import Logo from '@/assets/images/logo/kirloskar-logo.svg';
import { STEPS, type StepId } from './steps';

const SidebarContent = ({ stepId }: { stepId: StepId }) => (
  <div className="flex flex-col gap-[56px]">
    <img src={Logo} alt="Logo" className="w-[100px] h-[36px] ml-[12px]" />
    <Stepper steps={STEPS} value={stepId} />
  </div>
);

export function App() {
  // The install logic stays live behind the placeholder UI: the system probe fills the store on
  // launch, and installer events keep flowing into it.
  useProbe();
  useInstallerEvents();

  const [stepId, setStepId] = useState<StepId>(STEPS[0].id);
  const index = STEPS.findIndex((s) => s.id === stepId);
  const step = STEPS[index];
  const next = STEPS[index + 1];

  return (
    <AppLayout
      sidebar={<SidebarContent stepId={stepId} />}
      footer={
        <>
          <Typography font="secondary" variant="caption" className="text-subtle-foreground">
            {step.footerNote}
          </Typography>
          <div className="flex flex-row items-center gap-2">
            {/* TODO: the last step has no next step yet; wire its action (e.g. launch the app). */}
            <Button onClick={next ? () => setStepId(next.id) : undefined}>{step.actionLabel}</Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col flex-1 items-start px-[48px] py-[26px]">
        <step.Content />
      </div>
    </AppLayout>
  );
}
