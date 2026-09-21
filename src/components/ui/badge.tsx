import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-[9px] py-0.5 text-[11.5px] font-semibold leading-relaxed',
  {
    variants: {
      tone: {
        passed: 'bg-green-soft text-[#1c6d49]',
        pending: 'bg-amber-soft text-[#965f15]',
        failed: 'bg-failure-soft text-failure',
        running: 'bg-teal-soft text-director',
        neutral: 'bg-mist text-muted-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({
  className,
  tone,
  dot = true,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants> & { dot?: boolean }) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export { badgeVariants };
