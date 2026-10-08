import { LogoFull } from "@/components/app/logo";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center overflow-hidden bg-background px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(55%_45%_at_50%_0%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)] dark:bg-[radial-gradient(55%_45%_at_50%_0%,color-mix(in_oklch,var(--primary)_18%,transparent),transparent)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(var(--border)_1px,transparent_1px)] mask-[radial-gradient(60%_50%_at_50%_30%,black,transparent)] bg-size-[22px_22px] opacity-70"
      />
      <div className="relative z-10 flex w-full max-w-[400px] flex-col gap-6">
        <LogoFull className="self-center" />
        {children}
      </div>
    </div>
  );
}
