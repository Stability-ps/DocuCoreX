import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { PwaInstaller } from "@/components/pwa-installer";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "DocuCoreX | Document Intelligence Platform",
  description:
    "Extract, edit, convert, reconcile, sign and securely manage business documents with DocuCoreX.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "DocuCoreX",
    statusBarStyle: "default",
  },
  icons: {
    icon: "/docucorex-mark.png",
    apple: "/docucorex-mark.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#006ee6",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.variable}>
        {children}
        <PwaInstaller />
      </body>
    </html>
  );
}
