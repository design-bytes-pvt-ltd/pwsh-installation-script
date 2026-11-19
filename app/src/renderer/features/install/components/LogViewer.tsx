import { useLayoutEffect, useRef } from 'react';

/** Installer log output. Keeps itself scrolled to the newest line. */
export function LogViewer({ lines }: { lines: readonly string[] }) {
  const ref = useRef<HTMLPreElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <pre
      ref={ref}
      aria-label="Installer log"
      className="max-h-56 overflow-y-auto rounded-md bg-log p-2.5 font-mono text-xs whitespace-pre-wrap text-foreground/80"
    >
      {lines.join('')}
    </pre>
  );
}
