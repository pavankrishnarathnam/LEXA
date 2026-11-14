import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-[background,color,border,box-shadow,opacity] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:brightness-110",
        gradient: "bg-grad text-white shadow-[0_6px_20px_-6px_var(--primary)] hover:brightness-110",
        secondary: "bg-surface-2 text-foreground border border-border hover:border-border-strong",
        outline: "border border-border-strong bg-transparent hover:bg-surface-2",
        ghost: "hover:bg-surface-2 text-muted hover:text-foreground",
        danger: "bg-danger-solid text-white hover:brightness-110",
        success: "bg-success-solid text-white hover:brightness-110",
        link: "text-accent underline-offset-4 hover:underline px-0",
      },
      size: { default: "h-9 px-4", sm: "h-8 px-3 text-xs", lg: "h-11 px-6 text-base", icon: "size-9" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} disabled={disabled || loading}
        aria-busy={loading || undefined} {...props}>
        {asChild ? children : <>
          {loading && <span className="size-3.5 rounded-full border-2 border-current border-r-transparent animate-spin" aria-hidden />}
          {children}
        </>}
      </Comp>
    );
  },
);
Button.displayName = "Button";
