"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, MailPlus, Trash2, UsersRound } from "lucide-react";
import type { TeamMemberRecord } from "@/lib/app-state";

// Owner is never an invite option — a workspace has exactly one owner and
// ownership is transferred, not invited.
const INVITE_ROLES: TeamMemberRecord["role"][] = ["Admin", "Finance", "Auditor", "Viewer"];
const ASSIGNABLE_ROLES: TeamMemberRecord["role"][] = ["Owner", "Admin", "Finance", "Auditor", "Viewer"];

export function TeamConsole() {
  const [members, setMembers] = useState<TeamMemberRecord[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamMemberRecord["role"]>("Viewer");
  const [status, setStatus] = useState("");
  const [statusTone, setStatusTone] = useState<"info" | "error">("info");
  const [isInviting, setIsInviting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const admins = useMemo(
    () => members.filter((member) => member.role === "Owner" || member.role === "Admin").length,
    [members],
  );

  async function load() {
    setLoadState("loading");
    try {
      const response = await fetch("/api/team");
      if (response.status === 401) {
        window.location.href = "/login?reason=session-expired";
        return;
      }
      if (!response.ok) {
        setLoadState("error");
        return;
      }
      const data = (await response.json()) as { members: TeamMemberRecord[] };
      setMembers(data.members ?? []);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function report(message: string, tone: "info" | "error" = "info") {
    setStatus(message);
    setStatusTone(tone);
  }

  async function invite() {
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      report("Enter a valid email address.", "error");
      return;
    }
    if (members.some((member) => member.email.toLowerCase() === normalizedEmail)) {
      report("That email is already a member of this workspace.", "error");
      return;
    }

    setIsInviting(true);
    report("");
    try {
      const response = await fetch("/api/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizedEmail, role }),
      });
      const data = (await response.json().catch(() => ({}))) as { member?: TeamMemberRecord; error?: string };
      if (!response.ok || !data.member) {
        report(data.error ?? "Invite failed. Please try again.", "error");
        return;
      }
      // De-duplicate by id so an upsert of an existing member never doubles a row.
      setMembers((current) => [data.member!, ...current.filter((member) => member.id !== data.member!.id)]);
      setEmail("");
      report(`Invite sent to ${normalizedEmail}.`);
    } catch {
      report("Invite failed. Please try again.", "error");
    } finally {
      setIsInviting(false);
    }
  }

  async function changeRole(member: TeamMemberRecord, nextRole: TeamMemberRecord["role"]) {
    if (nextRole === member.role) return;
    setBusyId(member.id);
    report("");
    const previous = members;
    setMembers((current) => current.map((item) => (item.id === member.id ? { ...item, role: nextRole } : item)));
    try {
      const response = await fetch("/api/team", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: member.id, role: nextRole }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setMembers(previous);
        report(data.error ?? "Could not update role.", "error");
        return;
      }
      report(`${member.email} is now ${nextRole}.`);
    } catch {
      setMembers(previous);
      report("Could not update role.", "error");
    } finally {
      setBusyId(null);
    }
  }

  async function removeMember(member: TeamMemberRecord) {
    if (!window.confirm(`Remove ${member.email} from this workspace?`)) return;
    setBusyId(member.id);
    report("");
    const previous = members;
    setMembers((current) => current.filter((item) => item.id !== member.id));
    try {
      const response = await fetch("/api/team", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: member.id }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setMembers(previous);
        report(data.error ?? "Could not remove member.", "error");
        return;
      }
      report(`${member.email} was removed.`);
    } catch {
      setMembers(previous);
      report("Could not remove member.", "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="grid gap-4 sm:grid-cols-3">
        {[
          ["Users", members.length],
          ["Admins", admins],
          ["Pending invites", members.filter((member) => member.status === "Invited").length],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <UsersRound className="h-6 w-6 text-royal-600" />
            <p className="mt-4 text-3xl font-semibold text-navy-950">{loadState === "loading" ? "—" : value}</p>
            <p className="text-sm font-semibold text-slate-600">{label}</p>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            className="min-h-12 flex-1 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-semibold outline-none focus:border-royal-300 focus:bg-white"
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !isInviting) void invite();
            }}
            placeholder="Invite by email"
            type="email"
            value={email}
          />
          <select
            className="min-h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-semibold text-navy-950 outline-none"
            onChange={(event) => setRole(event.target.value as TeamMemberRecord["role"])}
            value={role}
          >
            {INVITE_ROLES.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void invite()}
            disabled={isInviting}
            aria-label="Invite team member"
            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-royal-600 px-4 py-3 text-sm font-semibold text-white shadow-sm disabled:cursor-wait disabled:bg-slate-300"
          >
            {isInviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailPlus className="h-4 w-4" />}
            {isInviting ? "Sending" : "Add User"}
          </button>
        </div>
        {status ? (
          <p className={`mt-3 text-sm font-semibold ${statusTone === "error" ? "text-rose-600" : "text-royal-700"}`}>{status}</p>
        ) : null}
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="grid grid-cols-[1.2fr_0.8fr_0.6fr_0.5fr] gap-4 border-b border-slate-100 px-5 py-4 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400 max-lg:hidden">
          <span>User</span>
          <span>Role</span>
          <span>Status</span>
          <span className="text-right">Actions</span>
        </div>

        {loadState === "loading" ? (
          <div className="flex items-center justify-center gap-2 px-5 py-12 text-sm font-semibold text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading team…
          </div>
        ) : loadState === "error" ? (
          <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
            <p className="text-sm font-semibold text-rose-600">Unable to load team members.</p>
            <button type="button" onClick={() => void load()} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold text-slate-700">
              Retry
            </button>
          </div>
        ) : members.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm font-semibold text-slate-500">
            No team members yet. Invite someone by email above.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {members.map((member) => {
              const isOwner = member.role === "Owner";
              return (
                <div key={member.id} className="grid gap-4 px-5 py-4 lg:grid-cols-[1.2fr_0.8fr_0.6fr_0.5fr] lg:items-center">
                  <div>
                    <p className="font-semibold text-navy-950">{member.name}</p>
                    <p className="text-sm text-slate-500">{member.email}</p>
                  </div>
                  <div>
                    <select
                      className="min-h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-navy-950 outline-none disabled:opacity-60"
                      value={member.role}
                      disabled={busyId === member.id}
                      onChange={(event) => void changeRole(member, event.target.value as TeamMemberRecord["role"])}
                    >
                      {ASSIGNABLE_ROLES.map((item) => (
                        <option key={item} value={item}>{item}</option>
                      ))}
                    </select>
                  </div>
                  <p className="text-sm font-semibold text-royal-700">{member.status}</p>
                  <div className="flex items-center justify-end">
                    <button
                      type="button"
                      onClick={() => void removeMember(member)}
                      disabled={busyId === member.id || isOwner}
                      title={isOwner ? "Transfer ownership before removing the Owner" : "Remove member"}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-white"
                    >
                      {busyId === member.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
