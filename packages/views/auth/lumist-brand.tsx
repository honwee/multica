import type { ReactNode } from "react";
import { MulticaIcon } from "@multica/ui/components/common/multica-icon";
import { cn } from "@multica/ui/lib/utils";

interface LumistBrandProps {
  logo: ReactNode;
  className?: string;
}

export function LumistBrand({ logo, className }: LumistBrandProps) {
  return (
    <div className={cn("flex items-center justify-center gap-4", className)}>
      {logo}
      <span aria-hidden="true" className="h-8 w-px bg-border" />
      <MulticaIcon bordered size="lg" />
    </div>
  );
}
