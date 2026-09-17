import { cn } from "@bb/shared-ui/lib/utils";
import arcLogoUrl from "../../../../../assets/arc-icon.png";

export function BbLogo({ className = "size-4" }: { className?: string }) {
  return (
    <img
      src={arcLogoUrl}
      alt=""
      aria-hidden="true"
      className={cn(className, "object-contain")}
    />
  );
}
