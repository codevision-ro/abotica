import { cva } from "class-variance-authority";

/**
 * Borderless fields of a form's title block: the name as the visible title and a muted line below it.
 * They read as plain text and get a soft background on hover and focus; callers add the text size.
 */
export const heroFieldVariants = cva(
  "-mx-2 w-[calc(100%+1rem)] min-w-0 rounded-lg bg-transparent px-2 transition-colors outline-none placeholder:text-muted-foreground/50 hover:bg-muted/50 focus-visible:bg-muted/60",
  {
    variants: {
      kind: {
        title: "py-0.5 font-semibold tracking-tight",
        subtitle: "text-muted-foreground focus-visible:text-foreground",
      },
    },
  },
);
