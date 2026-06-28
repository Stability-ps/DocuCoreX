"use client";

import { useMemo, useState } from "react";
import { useEffect } from "react";
import { MailPlus, ShieldCheck, UsersRound } from "lucide-react";
import type { TeamMemberRecord } from "@/lib/app-state";

export function TeamConsole() {
  const [members, setMembers] = useState<TeamMemberRecord[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamMemberRecord["role"]>("Viewer");
  const [status, setStatus] = useState("");
  const admins = useMemo(() => members.filter((member) => member.role === "Owner" || member.role === "Admin").length, [members]);

  useEffect(() => {
    async function load() {
      const response = await fetch("/api/team");
      if (!response.ok) return;
      const data = (await response.json()) as { members: TeamMemberRecord[] };
      setMembers(data.members);
    }

    void load();
  }, []);

  async function invite() {
    setStatus("");
    if (!email || !email.includes("@")) {
      setStatus("Enter a valid email address.");
      return;
    }
    const response = await fetch("/api/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role }),
    });
    if (!response.ok) {
      setStatus("Invite failed. The user may already be a member.");
      return;
    }
    const data = (await response.json()) as { member: TeamMemberRecord };
    setMembers((current) => [data.member, ...current]);
    setEmail("");
    setStatus(`Invite sent to ${email}`);
  }

  return (
    <div className="space-y-6">
      <section className="grid gap-4 sm:grid-cols-3">
        {[
          ["Users", members.length],
          ["Admins", admins],
          ["Pending invites", members.filter((member) => member.status === "Invited").length],
        ].map(([label, value]) => (
          <div key={label} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <UsersRound className="h-6 w-6 text-royal-600" />
            <p className="mt-4 text-3xl font-black text-navy-950">{value}</p>
            <p className="text-sm font-black text-slate-600">{label}</p>
          </div>
        ))}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            className="min-h-12 flex-1 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-semibold outline-none focus:border-royal-300 focus:bg-white"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Invite by email"
            type="email"
            value={email}
          />
          <select
            className="min-h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-black text-navy-950 outline-none"
            onChange={(event) => setRole(event.target.value as TeamMemberRecord["role"])}
            value={role}
          >
            {["Owner", "Admin", "Finance", "Auditor", "Viewer"].map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <button onClick={invite} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-royal-600 px-4 py-3 text-sm font-black text-white shadow-glow">
            <MailPlus className="h-4 w-4" />
            Add User
          </button>
        </div>
        {status ? <p className="mt-3 text-sm font-black text-royal-700">{status}</p> : null}
      </section>

      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="grid grid-cols-[1.2fr_0.7fr_0.7fr_0.6fr] gap-4 border-b border-slate-100 px-5 py-4 text-xs font-black uppercase tracking-[0.14em] text-slate-400 max-lg:hidden">
          <span>User</span>
          <span>Role</span>
          <span>Status</span>
          <span>Permissions</span>
        </div>
        <div className="divide-y divide-slate-100">
          {members.map((member) => (
            <div key={member.id} className="grid gap-4 px-5 py-4 lg:grid-cols-[1.2fr_0.7fr_0.7fr_0.6fr]">
              <div>
                <p className="font-black text-navy-950">{member.name}</p>
                <p className="text-sm text-slate-500">{member.email}</p>
              </div>
              <p className="text-sm font-black text-slate-600">{member.role}</p>
              <p className="text-sm font-black text-royal-700">{member.status}</p>
              <div className="flex items-center gap-2 text-sm font-black text-emerald-700">
                <ShieldCheck className="h-4 w-4" />
                Role-based
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
