import { FormPageSkeleton } from "@/components/app/form-page-skeleton";

export default function Loading() {
  return <FormPageSkeleton sections={["h-40", "h-32", "h-16", "h-24"]} />;
}
