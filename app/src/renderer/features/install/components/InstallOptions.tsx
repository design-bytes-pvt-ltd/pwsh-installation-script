import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useAppDispatch, useAppState, type InstallOptionsState } from '@/store';

function Option({ id, label, hint }: { id: keyof InstallOptionsState; label: ReactNode; hint?: string }) {
  const { options } = useAppState();
  const dispatch = useAppDispatch();
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={`opt-${id}`}
        checked={options[id]}
        onCheckedChange={(checked) => dispatch({ type: 'optionChanged', key: id, value: checked === true })}
      />
      <Label htmlFor={`opt-${id}`} className="cursor-pointer font-normal">
        {label}
        {hint && <small className="text-muted-foreground">{hint}</small>}
      </Label>
    </div>
  );
}

/** What to install, with "(already installed)" hints from the probe. */
export function InstallOptions() {
  const { probe } = useAppState();
  return (
    <Card>
      <CardContent className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2.5">
        <Option id="installOllama" label="Install Ollama" hint={probe?.ollamaInstalled ? '(already installed)' : undefined} />
        <Option
          id="installDocker"
          label="Install Docker"
          hint={probe && probe.dockerInstalled !== 'none' ? `(${probe.dockerInstalled} installed)` : undefined}
        />
        {probe?.os === 'linux' && (
          <Option id="dockerEngineOnLinux" label="Use Docker Engine instead of Desktop (Linux)" />
        )}
        <Option id="dryRun" label="Dry run (no changes)" />
      </CardContent>
    </Card>
  );
}
