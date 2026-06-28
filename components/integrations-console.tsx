"use client";

import { useState } from "react";
import { useEffect } from "react";
import { CheckCircle2, Plus, Settings2 } from "lucide-react";
import { integrationConnectors } from "@/lib/product-data";
import type { IntegrationRecord } from "@/lib/app-state";

export function IntegrationsConsole() {
  const [records, setRecords] = useState<IntegrationRecord[]>([]);
  const [setupId, setSetupId] = useState("");

  useEffect(() => {
    async function load() {
      const response = await fetch("/api/integrations");
      if (!response.ok) return;
      const data = (await response.json()) as { integrations: IntegrationRecord[] };
      setRecords(data.integrations);
    }

    void load();
  }, []);

  async function toggle(id: string) {
    const response = await fetch("/api/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) return;
    const data = (await response.json()) as { integration: IntegrationRecord };
    setRecords((current) => current.map((item) => (item.id === data.integration.id ? data.integration : item)));
    setSetupId("");
  }

  return (
    <div className="space-y-4">
      {integrationConnectors.map((connector) => {
        const record = records.find((item) => item.name === connector.name);
        const id = record?.id ?? connector.name.toLowerCase().replace(/\s+/g, "-");
        const isConnected = record?.status === "connected";
        return (
          <section key={connector.name} className="rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-col gap-4 border-b border-slate-100 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4">
                <div className="rounded-2xl bg-royal-50 p-3 text-royal-600">
                  <connector.icon className="h-6 w-6" />
                </div>
                <div>
                  <h2 className="font-black text-navy-950">{connector.name}</h2>
                  <p className="text-sm font-bold text-slate-500">{connector.category}</p>
                </div>
              </div>
              <button
                onClick={() => setSetupId(id)}
                className={`inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-black ${
                  isConnected ? "bg-emerald-50 text-emerald-700" : "bg-royal-600 text-white shadow-glow"
                }`}
              >
                {isConnected ? <CheckCircle2 className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                {isConnected ? "Connected" : "Connect"}
              </button>
            </div>
            <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm leading-6 text-slate-500">{connector.detail}</p>
              <div className="inline-flex w-fit items-center gap-2 rounded-full bg-slate-100 px-3 py-2 text-xs font-black text-slate-600">
                <Settings2 className="h-4 w-4" />
                {isConnected ? "Manage mapping" : connector.status}
              </div>
            </div>
            {setupId === id ? (
              <div className="border-t border-slate-100 p-5">
                <div className="rounded-2xl bg-amber-50 border border-amber-200 p-4 mb-4 text-sm font-black text-amber-900">
                  Coming soon: {connector.name} connection setup. This integration requires API key configuration in your workspace settings.
                </div>
                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <input
                    className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none"
                    placeholder={`${connector.name} account, folder, sheet or webhook destination`}
                    disabled
                  />
                  <button onClick={() => setSetupId("")} className="rounded-2xl bg-slate-300 px-4 py-3 text-sm font-black text-slate-600 cursor-not-allowed" disabled>
                    Unavailable
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
