import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** The one card every auth step sits in: centered title and description, the form below. */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-6 rounded-2xl bg-card/90 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-12px_rgb(0_0_0/0.12)] ring-border/80 backdrop-blur [--card-spacing:--spacing(6)] max-sm:[--card-spacing:--spacing(5)] dark:bg-card/70 dark:shadow-[0_12px_32px_-12px_rgb(0_0_0/0.6)]">
      <CardHeader className="justify-items-center gap-1.5 text-center">
        <CardTitle className="text-xl font-semibold tracking-tight">{title}</CardTitle>
        {description && <CardDescription className="text-pretty">{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
