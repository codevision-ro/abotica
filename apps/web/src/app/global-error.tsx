"use client";

import { defaultLocale, type Locale, matchLocale } from "@abotica/i18n/locales";
import en from "@abotica/i18n/messages/en/shell.json";
import ro from "@abotica/i18n/messages/ro/shell.json";
import { useEffect, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import "./globals.css";

// Only this page's strings: the full catalogs would ship with every page, since Next preloads this file.
const TEXT: Record<Locale, typeof en.error> = { en: en.error, ro: ro.error };

const subscribe = () => () => {};
const browserLocale = () => matchLocale(navigator.languages.join(","));

/** The theme the app would show: the one chosen in the app (next-themes keeps it in localStorage), else the system's. */
function prefersDark(): boolean {
  let chosen: string | null = null;
  try {
    chosen = localStorage.getItem("theme");
  } catch {
    // Storage blocked: follow the system.
  }
  return chosen === "dark" || (chosen !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
}

/**
 * Replaces the root layout when it fails, so there is no locale from Settings and no message
 * provider here: the text follows the browser's language.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const locale = useSyncExternalStore(subscribe, browserLocale, () => defaultLocale);
  const dark = useSyncExternalStore(subscribe, prefersDark, () => false);
  const text = TEXT[locale];
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang={locale} className={dark ? "dark" : undefined}>
      <body className="flex min-h-svh items-center justify-center bg-background px-4 text-foreground antialiased">
        <main role="alert" className="flex max-w-sm flex-col items-center gap-4 text-center">
          <h1 className="text-xl font-semibold tracking-tight">{text.title}</h1>
          {error.digest && (
            <p className="font-mono text-xs text-muted-foreground">{text.reference.replace("{digest}", error.digest)}</p>
          )}
          <Button onClick={() => retry()}>{text.retry}</Button>
        </main>
      </body>
    </html>
  );
}
