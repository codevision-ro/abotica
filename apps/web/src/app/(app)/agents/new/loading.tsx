import { FormPageSkeleton } from "@/components/app/form-page-skeleton";

export default function Loading() {
  return <FormPageSkeleton chips sections={["h-48", "h-20", "h-56", "h-24"]} />;
}
