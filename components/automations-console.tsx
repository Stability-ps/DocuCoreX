"use client";

import { useState } from "react";
import { useEffect } from "react";
import { Plus, RefreshCcw, Send } from "lucide-react";
import { automationSteps } from "@/lib/product-data";
import type { AutomationPipelineRecord } from "@/lib/app-state";

export function AutomationsConsole() {
  const [pipelines, setPipelines] = useState<AutomationPipelineRecord[]>([]);
  const [input, setInput] = useState("Finance uploads folder");
  const [output, setOutput] = useState("Excel export queue");
  const [requests, setRequests] = useState("");

  useEffect(() => {
    async function load() {
      const response = await fetch("/api/automations");
      if (!response.ok) return;
      const data = (await response.json()) as { pipelines: AutomationPipelineRecord[] };
      setPipelines(data.pipelines);
    }

    void load();
  }, []);

  async function createPipeline() {
    const response = await fetch("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "pipeline", name: `${input} to ${output}`, input, output }),
    });
    if (!response.ok) return;
    const data = (await response.json()) as { pipeline: AutomationPipelineRecord };
    setPipelines((current) => [data.pipeline, ...current]);
  }

  async function togglePipeline(id: string) {
    const response = await fetch("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "toggle", id }),
    });
    if (!response.ok) return;
    const data = (await response.json()) as { pipeline: AutomationPipelineRecord };
    setPipelines((current) => current.map((pipeline) => (pipeline.id === data.pipeline.id ? data.pipeline : pipeline)));
  }

  async function sendRequest() {
    if (!requests.trim()) return;
    const response = await fetch("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "request", body: requests }),
    });
    if (response.ok) setRequests("");
  }

  return (
    <div className="space-y-6">
      <section className="grid gap-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:grid-cols-3">
        {automationSteps.map((step, index) => (
          <div key={step.title} className="rounded-2xl bg-slate-50 p-4">
            <div className="flex items-center gap-3">
              <step.icon className="h-5 w-5 text-royal-600" />
              <p className="font-black text-navy-950">{index + 1}. {step.title}</p>
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-500">{step.detail}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-xl font-black text-navy-950">Create pipeline</h2>
          <div className="mt-5 grid gap-3">
            <input className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none" onChange={(event) => setInput(event.target.value)} value={input} />
            <input className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none" onChange={(event) => setOutput(event.target.value)} value={output} />
            <button onClick={createPipeline} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-royal-600 px-4 py-3 text-sm font-black text-white">
              <Plus className="h-4 w-4" />
              Add automation
            </button>
          </div>
        </section>
        <AutomationList pipelines={pipelines} onToggle={togglePipeline} />
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-xl font-black text-navy-950">Request automation support</h2>
        <p className="mt-1 text-sm leading-6 text-slate-500">Capture missing inputs, outputs, mapping rules or workflow requirements for the roadmap.</p>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <input
            className="min-h-12 flex-1 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-semibold outline-none focus:border-royal-300 focus:bg-white"
            onChange={(event) => setRequests(event.target.value)}
            placeholder="Describe the workflow you need"
            value={requests}
          />
          <button onClick={sendRequest} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-royal-600 px-4 py-3 text-sm font-black text-white shadow-glow">
            <Send className="h-4 w-4" />
            Send request
          </button>
        </div>
      </section>
    </div>
  );
}

function AutomationList({ pipelines, onToggle }: { pipelines: AutomationPipelineRecord[]; onToggle: (id: string) => void }) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-black text-navy-950">Pipelines</h2>
      </div>
      <div className="mt-5 space-y-3">
        {pipelines.map((pipeline) => (
          <button key={pipeline.id} onClick={() => onToggle(pipeline.id)} className="flex w-full items-center gap-3 rounded-2xl bg-slate-50 p-4 text-left">
            <RefreshCcw className="h-5 w-5 text-royal-600" />
            <div>
              <p className="font-black text-navy-950">{pipeline.name}</p>
              <p className="text-sm text-slate-500">
                {pipeline.input} {"->"} {pipeline.output}
              </p>
            </div>
            <span className={`ml-auto rounded-full px-2.5 py-1 text-xs font-black ${pipeline.active ? "bg-emerald-50 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>
              {pipeline.active ? "Active" : "Inactive"}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
