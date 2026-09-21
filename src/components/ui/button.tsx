import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border text-[13.5px] text-ink transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:border-[#cfd9d5] disabled:bg-[#cfd9d5] disabled:text-[#f3f6f5]',
  {
    variants: {
      variant: {
        default: 'border-hairline bg-surface hover:border-[#b7c3bf] hover:bg-[#f6f9f8]',
        primary:
          'border-director bg-director font-semibold text-primary-foreground hover:border-director-deep hover:bg-director-deep',
        ghost: 'border-transparent bg-transparent hover:bg-mist',
        danger: 'border-[#e2b4b0] bg-surface text-failure hover:bg-failure-soft',
      },
      size: {
        sm: 'h-7 rounded-sm px-2.5 text-[12.5px]',
        md: 'h-9 px-3.5',
        lg: 'h-10 px-[18px]',
        icon: 'size-9 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, type, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...(asChild ? props : { type: type ?? 'button', ...props })}
    />
  );
});

export { buttonVariants };
