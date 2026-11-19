import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Text that temporarily changes, then reverts: `flash('Copied')` shows "Copied" for `ms`,
 * then the default again. Safe to unmount mid-flash.
 */
export function useTimedText(defaultText: string, ms = 2000): [string, (text: string) => void] {
  const [text, setText] = useState(defaultText);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const flash = useCallback(
    (next: string) => {
      clearTimeout(timer.current);
      setText(next);
      timer.current = setTimeout(() => setText(defaultText), ms);
    },
    [defaultText, ms]
  );

  return [text, flash];
}
