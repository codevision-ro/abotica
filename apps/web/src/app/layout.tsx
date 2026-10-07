import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { ThemeProvider } from "@/components/app/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin", "latin-ext"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin", "latin-ext"] });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: { default: "Abotica", template: "%s · Abotica" }, description: t("tagline") };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  return (
    <html lang={locale} suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      <body className="min-h-svh">
        <NextIntlClientProvider>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
            <TooltipProvider delayDuration={300}>
              {children}
              <Toaster richColors position="bottom-right" />
            </TooltipProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
