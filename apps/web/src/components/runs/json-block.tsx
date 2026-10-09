import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/** Base64 shorter than this stays in the text: a tiny icon reads fine either way. */
const IMAGE_DATA_MIN_CHARS = 1000;
const IMAGE_TYPE = /^image\/[a-z0-9.+-]+$/i;
const BASE64 = /^[A-Za-z0-9+/=\s]+$/;

type FoundImage = { src: string; kb: number };

/** The value as an object when it is JSON text, so images inside it are found too. */
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * The value with each image a tool returned (an object whose mediaType or mimeType is image/*, its
 * base64 in `image` or `data`, as file_read and MCP servers return them) taken out: the images to
 * show, and the value with a short label in place of their base64, which would fill the block with
 * noise.
 */
function extractImages(value: unknown, label: (kb: number) => string): { value: unknown; images: FoundImage[] } {
  const images: FoundImage[] = [];
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (typeof item !== "object" || item === null) return item;
    const record = item as Record<string, unknown>;
    const type = [record.mediaType, record.mimeType].find((t): t is string => typeof t === "string" && IMAGE_TYPE.test(t));
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(record)) {
      if (
        type &&
        (key === "image" || key === "data") &&
        typeof field === "string" &&
        field.length > IMAGE_DATA_MIN_CHARS &&
        BASE64.test(field)
      ) {
        const kb = Math.max(1, Math.round((field.length * 3) / 4 / 1024));
        images.push({ src: `data:${type};base64,${field.replace(/\s/g, "")}`, kb });
        out[key] = label(kb);
      } else {
        out[key] = walk(field);
      }
    }
    return out;
  };
  const result = walk(parsed(value));
  return images.length ? { value: result, images } : { value, images };
}

function toJson(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Monospace, scrollable block for tool inputs and outputs. Images in it (a screenshot, a picture an
 * agent read) are shown above the text.
 */
export function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  const t = useTranslations("runs.json");
  const { value: shown, images } = extractImages(value, (kb) => t("image", { kb }));
  const text = toJson(shown);
  const block = (
    <pre
      className={cn(
        "max-h-80 overflow-auto rounded-lg border border-border/60 bg-muted/35 px-3 py-2.5 font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap text-foreground/90 dark:bg-muted/25",
        className,
      )}
    >
      {text || <span className="text-muted-foreground">{t("empty")}</span>}
    </pre>
  );
  if (!images.length) return block;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {images.map((image, i) => (
          // A data: URL from the run itself; next/image would add nothing for it.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={image.src}
            alt={t("imageAlt")}
            loading="lazy"
            className="max-h-72 max-w-full rounded-lg border border-border/60 bg-muted/30 object-contain"
          />
        ))}
      </div>
      {block}
    </div>
  );
}
