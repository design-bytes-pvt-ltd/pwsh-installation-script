import type { ComponentType, ReactNode } from 'react';
import type { StepperStep } from '@/components/stepper';
import { Typography } from '@/components/typography';

/**
 * Everything that changes with the active step: its sidebar entry, the content area and the footer.
 * Steps are referenced by `id` everywhere; their order here is the order of the flow.
 */
type AppStep = StepperStep & {
  /** Content area for this step. */
  Content: ComponentType;
  /** Text on the left of the footer. */
  footerNote: ReactNode;
  /** Label of the footer's primary button, which moves to the next step. */
  actionLabel: string;
};

// Placeholder screens until the real ones are built.
const GetReadyContent = () => <Typography>Start</Typography>;
const InstallContent = () => <Typography>Installing…</Typography>;
const FinishContent = () => <Typography>All set.</Typography>;

export const STEPS = [
  {
    id: 'get-ready',
    title: 'Get ready',
    description: 'Check your PC',
    Content: GetReadyContent,
    footerNote: 'Takes about 30 minutes',
    actionLabel: 'Get Started',
  },
  {
    id: 'install',
    title: 'Install',
    description: 'Set up the app',
    Content: InstallContent,
    footerNote: 'Please don\'t turn off your computer',
    actionLabel: 'Continue',
  },
  {
    id: 'finish',
    title: 'Finish',
    description: 'Open and go',
    Content: FinishContent,
    footerNote: 'Everything is ready',
    actionLabel: 'Launch Enterprise Brain',
  },
] as const satisfies readonly AppStep[];

export type StepId = (typeof STEPS)[number]['id'];
