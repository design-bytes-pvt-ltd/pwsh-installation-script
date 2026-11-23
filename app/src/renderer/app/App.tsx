import { useEffect, useState } from 'react';
import { AppLayout } from '@/components/layout';
import { Typography } from '@/components/typography';
import { Button } from '@/components/button';
import { Stepper } from '@/components/stepper';
import { installOutcome, useInstallerEvents } from '@/features/install';
import { InstallCancelledPage, InstallFailedPage } from '@/pages';
import { installerApi } from '@/services/installerApi';
import { useAppState } from '@/store';
import Logo from '@/assets/images/logo/kirloskar-logo.svg';
import { STEPS, type StepId } from './steps';

const SidebarContent = ({ stepId }: { stepId: StepId }) => (
  <div className="flex flex-col gap-[56px]">
    <img src={Logo} alt="Logo" className="w-[100px] h-[36px] ml-[12px]" />
    {/* The last step (Finish) has nothing left to do, so reaching it completes the whole flow. */}
    <Stepper steps={STEPS} value={stepId} completed={stepId === STEPS[STEPS.length - 1].id} />
  </div>
);

export function App() {
  // Installer events flow into the store for the whole session. The system probe runs on the
  // Get ready page (the first step), so it starts on launch.
  useInstallerEvents();
  const state = useAppState();

  const [stepId, setStepId] = useState<StepId>(STEPS[0].id);
  const index = STEPS.findIndex((s) => s.id === stepId);
  const step = STEPS[index];
  const next = STEPS[index + 1];
  const canProceed = 'canProceed' in step ? step.canProceed(state) : true;
  const showExit = 'exitWhen' in step && step.exitWhen(state);
  const advanceTo: StepId | undefined =
    'advanceWhen' in step && step.advanceWhen(state) ? ('advanceTo' in step ? step.advanceTo : next?.id) : undefined;

  useEffect(() => {
    if (advanceTo) setStepId(advanceTo);
  }, [advanceTo]);

  // A cancelled or failed install ends on its own page, still under the Install step.
  const outcome = stepId === 'install' ? installOutcome(state.install) : null;

  if (outcome) {
    const Content = outcome === 'cancelled' ? InstallCancelledPage : InstallFailedPage;
    return (
      <AppLayout
        sidebar={<SidebarContent stepId={stepId} />}
        footer={
          <>
            {outcome === 'failed' ? (
              <Button variant="secondary" onClick={() => void installerApi.showLog()}>
                View log
              </Button>
            ) : (
              // Keeps Exit on the right: the footer spreads its children to both ends.
              <span />
            )}
            <Button variant="secondary" onClick={() => void installerApi.quit()}>
              Exit
            </Button>
          </>
        }
      >
        <div className="flex flex-col flex-1 items-start px-[48px] py-[26px]">
          <Content />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout
      sidebar={<SidebarContent stepId={stepId} />}
      footer={
        <>
          <Typography variant="caption" className="text-subtle-foreground">
            {step.footerNote}
          </Typography>
          <div className="flex flex-row items-center gap-2">
            {showExit ? (
              <Button variant="secondary" onClick={() => void installerApi.quit()}>
                Exit
              </Button>
            ) : 'actionLabel' in step && (
              <Button
                disabled={!canProceed}
                onClick={() => ('onAction' in step ? void step.onAction() : setStepId(next?.id ?? STEPS[0].id))}
              >
                {step.actionLabel}
              </Button>
            )}
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
