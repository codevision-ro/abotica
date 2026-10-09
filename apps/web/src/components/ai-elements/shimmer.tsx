"use client";

import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import type { CSSProperties } from "react";
import { memo } from "react";

const SPREAD = 2;

const ShimmerComponent = ({
  children,
  className,
  duration = 2,
}: {
  children: string;
  className?: string;
  duration?: number;
}) => (
  <motion.p
    animate={{ backgroundPosition: "0% center" }}
    className={cn(
      "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
      "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
      className,
    )}
    initial={{ backgroundPosition: "100% center" }}
    style={
      {
        "--spread": `${children.length * SPREAD}px`,
        backgroundImage: "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
      } as CSSProperties
    }
    transition={{
      duration,
      ease: "linear",
      repeat: Number.POSITIVE_INFINITY,
    }}
  >
    {children}
  </motion.p>
);

export const Shimmer = memo(ShimmerComponent);
