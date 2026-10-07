import { FormPageSkeleton } from "@/components/app/form-page-skeleton";

export default function Loading() {
  return <FormPageSkeleton avatar={false} sections={["h-28", "h-10", "h-6", "h-6"]} />;
}
