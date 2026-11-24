import type { ComponentPropsWithoutRef, ElementType } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Text styles for the whole app. Primary font is Geist (`font-sans`), secondary is Geist Mono
 * (`font-mono`); both are set up in styles/globals.css.
 */
const typographyVariants = cva('', {
  variants: {
    variant: {
      h1: 'text-[28px] leading-tight font-medium tracking-tight',
      h2: 'text-2xl leading-tight font-medium tracking-tight',
      h3: 'text-lg leading-snug font-medium',
      body: 'text-base font-normal leading-relaxed',
      small: 'text-sm font-normal leading-normal',
      caption: 'text-[13px] font-light leading-normal',
    },
    font: {
      primary: 'font-sans',
      secondary: 'font-mono',
    },
    tone: {
      default: '',
      muted: 'text-muted-foreground',
    },
  },
  defaultVariants: { variant: 'body', font: 'primary', tone: 'default' },
});

type TypographyVariant = NonNullable<VariantProps<typeof typographyVariants>['variant']>;

const DEFAULT_ELEMENT: Record<TypographyVariant, ElementType> = {
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  body: 'p',
  small: 'p',
  caption: 'span',
};

type TypographyProps<E extends ElementType> = VariantProps<typeof typographyVariants> & {
  /** Element to render. Defaults to the semantic element for the variant (h1 for "h1", p for "body"...). */
  as?: E;
} & Omit<ComponentPropsWithoutRef<E>, 'as'>;

export function Typography<E extends ElementType = 'p'>({
  variant,
  font,
  tone,
  as,
  className,
  ...props
}: TypographyProps<E>) {
  const Comp: ElementType = as ?? DEFAULT_ELEMENT[variant ?? 'body'];
  return (
    <Comp
      data-slot="typography"
      data-variant={variant ?? 'body'}
      className={cn(typographyVariants({ variant, font, tone }), className)}
      {...props}
    />
  );
}

export { typographyVariants };
export type { TypographyProps, TypographyVariant };
