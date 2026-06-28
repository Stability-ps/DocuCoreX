import { AppShell } from "@/components/app-shell";

export default function ConvertLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

