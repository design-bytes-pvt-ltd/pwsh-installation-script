import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * The app's pill button. Colors come from the `--button-*` tokens in styles/globals.css.
 *
 * - `primary`: green gradient, white label ("Launch Enterprise Brain", "Get started").
 * - `secondary`: white with a sage border ("Exit").
 * - Disabled (the `disabled` prop) fades either variant to 50% and blocks hover/press styles.
 *
 * No box shadow on any state; the focus ring is an outline so keyboard focus stays visible.
 */
const buttonVariants = cva(
  [
    'inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full px-6',
    'font-sans text-sm leading-none font-semibold whitespace-nowrap select-none',
    'shadow-none transition-[filter,background-color,opacity] duration-150',
    'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    'disabled:cursor-not-allowed disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4',
  ],
  {
    variants: {
      variant: {
        primary: [
          'bg-linear-to-r from-button-primary-from to-button-primary-to text-button-primary-foreground',
          'enabled:hover:brightness-95 enabled:active:brightness-90',
        ],
        secondary: [
          'border border-button-secondary-border bg-button-secondary text-button-secondary-foreground',
          'enabled:hover:bg-button-secondary-hover enabled:active:brightness-95',
        ],
      },
    },
    defaultVariants: { variant: 'primary' },
  }
);

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;

type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants>;

function Button({ variant, className, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      data-slot="button"
      data-variant={variant ?? 'primary'}
      type={type}
      className={cn(buttonVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
export type { ButtonProps, ButtonVariant };
