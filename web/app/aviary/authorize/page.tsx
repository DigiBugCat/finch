import { Suspense } from "react";
import AviaryAuthorize from "@/components/AviaryAuthorize";

// Auth-protected by middleware and always tied to the current Clerk tenant.
export const dynamic = "force-dynamic";

export default function AviaryAuthorizePage() {
  return (
    <Suspense>
      <AviaryAuthorize />
    </Suspense>
  );
}
