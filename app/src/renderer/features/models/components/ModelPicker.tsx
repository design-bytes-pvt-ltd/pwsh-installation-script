import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { useAppDispatch, useAppState } from '@/store';
import { selectionSummary } from '../selection';
import { ModelTable } from './ModelTable';

/** The "Select Ollama Models" card. `action` goes on the right of the footer (the Start button). */
export function ModelPicker({ action }: { action?: ReactNode }) {
  const { probe, selectedModels } = useAppState();
  const dispatch = useAppDispatch();
  const models = probe?.models ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Select Ollama Models</CardTitle>
        <CardAction className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => dispatch({ type: 'selectionCleared' })}>
            Select None
          </Button>
          <Button variant="secondary" size="sm" onClick={() => dispatch({ type: 'selectionReset' })}>
            Reset to default
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ModelTable
          models={models}
          selected={selectedModels}
          onToggle={(name, selected) => dispatch({ type: 'modelToggled', name, selected })}
        />
      </CardContent>
      <CardFooter className="justify-between gap-3">
        <span className="text-muted-foreground">{selectionSummary(models, selectedModels)}</span>
        {action}
      </CardFooter>
    </Card>
  );
}
