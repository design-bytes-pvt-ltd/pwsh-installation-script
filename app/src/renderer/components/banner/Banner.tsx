import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

type BannerProps = Omit<ComponentProps<'img'>, 'src' | 'alt' | 'className'> & {
  src: string;
  /** Describe the image, or pass "" when it is purely decorative. */
  alt: string;
  /** Classes for the rounded frame (size, margins). */
  className?: string;
  /** Classes for the image itself, e.g. to change `object-cover`. */
  imgClassName?: string;
};

/** Full-width image in a rounded frame, as used at the top of a page. */
function Banner({ src, alt, className, imgClassName, ...props }: BannerProps) {
  return (
    <div data-slot="banner" className={cn('overflow-hidden rounded-lg', className)}>
      <img src={src} alt={alt} className={cn('h-full w-full object-cover', imgClassName)} {...props} />
    </div>
  );
}

export { Banner };
export type { BannerProps };
