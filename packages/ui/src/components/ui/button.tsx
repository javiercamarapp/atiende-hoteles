import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

// Portado 1:1 desde atiende-restaurantes (src/components/ui/button.tsx):
// anatomía de píldora (rounded-full en todos los tamaños), feedback de
// press global vía CSS (:active { scale(.97) }) en index.css.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold tracking-[0.005em] ring-offset-background transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 shadow-card motion-safe:hover:-translate-y-px motion-safe:hover:shadow-[0_10px_26px_hsl(var(--primary)/0.26)]",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-border bg-card text-foreground hover:border-[color-mix(in_srgb,hsl(var(--foreground))_26%,transparent)] motion-safe:hover:-translate-y-px",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        hero: "bg-[image:var(--gradient-gold)] text-foreground font-semibold shadow-elevated hover:shadow-glow hover:scale-105 active:scale-100",
        terracotta: "bg-terracotta text-white font-semibold shadow-card hover:shadow-elevated hover:-translate-y-1",
        gold: "bg-gold text-gold-foreground font-semibold shadow-card hover:shadow-elevated hover:-translate-y-1",
      },
      size: {
        default: "h-11 px-5 py-2",
        sm: "h-11 px-4",
        lg: "h-12 px-8 text-base",
        xl: "h-14 px-10 text-lg",
        icon: "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
