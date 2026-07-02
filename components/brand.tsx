import Image from "next/image";

export function BrandLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <Image
        src="/docucorex_transparent_logo.png"
        alt="DocuCoreX"
        width={compact ? 56 : 180}
        height={compact ? 56 : 96}
        priority
        className={compact ? "h-11 w-11 rounded-2xl object-contain" : "h-12 w-auto object-contain"}
      />
      {compact ? (
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-navy-950">DocuCoreX</p>
        </div>
      ) : null}
    </div>
  );
}

