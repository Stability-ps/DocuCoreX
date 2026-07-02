"use client";

import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function PwaInstaller() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [hidden, setHidden] = useState(true);
  const [isInstalled, setIsInstalled] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const snoozeUntil = Number(localStorage.getItem("docucorex_install_snooze_until") ?? "0");
    if (standalone) {
      setIsInstalled(true);
      localStorage.setItem("docucorex_install_dismissed", "true");
      return;
    }
    if (Date.now() < snoozeUntil || localStorage.getItem("docucorex_install_dismissed") === "true") return;

    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIos) {
      setShowIosHint(true);
      setHidden(false);
    }

    const handleBeforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
      setHidden(false);
    };
    const handleInstalled = () => {
      setHidden(true);
      setIsInstalled(true);
      localStorage.setItem("docucorex_install_dismissed", "true");
      localStorage.removeItem("docucorex_install_snooze_until");
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstall);
    window.addEventListener("appinstalled", handleInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  if (hidden || isInstalled) return null;

  return (
    <div className="fixed inset-x-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-50 rounded-2xl border border-slate-200 bg-white p-4 shadow-xl md:hidden">
      <p className="text-sm font-black text-navy-950">Install DocuCoreX</p>
      <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">
        {showIosHint ? "On iPhone: Share -> Add to Home Screen" : "Add DocuCoreX to your home screen for a native app experience."}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          className="h-11 rounded-xl bg-royal-600 text-sm font-black text-white disabled:bg-slate-200"
          disabled={!installPrompt}
          onClick={async () => {
            if (!installPrompt) return;
            await installPrompt.prompt();
            await installPrompt.userChoice;
            setHidden(true);
          }}
        >
          Install
        </button>
        <button
          type="button"
          className="h-11 rounded-xl bg-slate-100 text-sm font-black text-slate-700"
          onClick={() => {
            localStorage.setItem("docucorex_install_snooze_until", String(Date.now() + 30 * 24 * 60 * 60 * 1000));
            setHidden(true);
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
