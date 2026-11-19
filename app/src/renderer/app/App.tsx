import { AppLayout } from '@/components/layout';
import { Typography } from '@/components/typography';
import { useInstallerEvents } from '@/features/install';
import { useProbe } from '@/features/system';

export function App() {
  // The install logic stays live behind the placeholder UI: the system probe fills the store on
  // launch, and installer events keep flowing into it.
  useProbe();
  useInstallerEvents();

  return (
    <AppLayout sidebar={<Typography>hello</Typography>}>
      <Typography>world</Typography>
    </AppLayout>
  );
}
