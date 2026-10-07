import { FormPageSkeleton } from "@/components/app/form-page-skeleton";

export default function Loading() {
  return <FormPageSkeleton sections={["h-[60vh] min-h-80", "h-24"]} />;
}
