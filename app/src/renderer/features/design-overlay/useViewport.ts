import { useEffect, useState } from 'react';
import type { Size } from './geometry';

const current = (): Size => ({ width: window.innerWidth, height: window.innerHeight });

/** The window's CSS size, updated on resize. */
export function useViewport(): Size {
  const [size, setSize] = useState(current);
  useEffect(() => {
    const onResize = () => setSize(current());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}
