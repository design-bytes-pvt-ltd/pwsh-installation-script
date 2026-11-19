import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { installerApi } from '@/services/installerApi';
import { reportRendererError } from './errorReporting';

interface State {
  error: Error | null;
}

/**
 * Last-resort fallback when a component throws while rendering. React does not send these to
 * window "error" listeners, so the boundary reports them itself.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportRendererError({
      message: error.message,
      stack: [error.stack, info.componentStack].filter(Boolean).join('\n'),
      source: 'React render',
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mx-auto max-w-[900px] p-5">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-muted-foreground">{this.state.error.message}</p>
        <div className="mt-4 flex gap-2">
          <Button variant="secondary" onClick={() => void installerApi.showLog()}>
            Show log file
          </Button>
          <Button onClick={() => this.setState({ error: null })}>Try again</Button>
        </div>
      </div>
    );
  }
}
