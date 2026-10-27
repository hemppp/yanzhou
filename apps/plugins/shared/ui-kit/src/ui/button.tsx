// ============================================================
// ui-kit/ui/button.tsx —— 按钮（shadcn 同源实现）
//
// 来源：shadcn/ui 官方 button（new-york 风格），按其源码逐字实现，
//       仅把 `@/lib/utils` 的 import 改成本仓的 `./utils`。
//       类名与 variant/size 名保持与上游一致 ⇒ 后续 `shadcn add` 的组件可直接互通。
//
// ★ 本仓适配说明（勿照搬上游改动覆盖）：
//   · 颜色全部走 `--background/--primary/--border/--ring…` 这套**已存在的**令牌
//     （tailwind.config.js:26-56 早有映射），没有新造色值（ADR 约定 C-2）。
//   · 圆角用 `rounded-md`（= `calc(var(--radius) - 2px)`）；若要跟本仓的
//     `rounded-control/card/window` 档位对齐，在调用处传 className 覆盖即可
//     （`cn` 会正确消解冲突）。
// ============================================================

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './utils';

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline: 'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
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
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
