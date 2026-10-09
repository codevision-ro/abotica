"use client";

import { cn } from "@/lib/utils";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { ComponentProps } from "react";
import { memo } from "react";
import remarkBreaks from "remark-breaks";
import { defaultRemarkPlugins, Streamdown } from "streamdown";

type MessageResponseProps = ComponentProps<typeof Streamdown> & {
  /** Keep single line breaks as typed (text written by people, e.g. comments), instead of joining lines like Markdown does. */
  breaks?: boolean;
};

const remarkWithBreaks = [...Object.values(defaultRemarkPlugins), remarkBreaks];

const streamdownPlugins = { cjk, code, math, mermaid };

export const MessageResponse = memo(
  ({ className, breaks, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn("size-full min-w-0 wrap-anywhere [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      plugins={streamdownPlugins}
      remarkPlugins={breaks ? remarkWithBreaks : undefined}
      {...props}
    />
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating &&
    prevProps.breaks === nextProps.breaks,
);

MessageResponse.displayName = "MessageResponse";
