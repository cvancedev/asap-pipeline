"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Lead = {
  id: string;
  project: string;
  customer: string;
  phone: string;
  moveDate: string;
  moveType: string;
  status: string;
  priority: string;
  assignedTo: string;
  lastContact: string;
  nextAction: string;
  notes: string;
};

const statuses = [
  "Hot Lead",
  "Waiting on Jacob",
  "Waiting on Customer",
  "Waiting on ASAP",
  "Booked / Confirmed",
  "Lost / Closed",
];

const nextActions = [
  "Review walkthrough",
  "Send estimate",
  "Follow up with customer",
  "Collect deposit",
  "Confirm schedule",
  "Waiting on customer response",
  "Waiting on move date / closing",
  "Update CRM notes",
  "No action needed",
];

const moveTypes = [
  "Local Move",
  "Intrastate Move",
  "Interstate Move",
  "Labor Only",
  "Packing Only",
  "Storage Move",
];

const assignedUsers = ["Curt", "Jacob"];
export default function Home() {
 const [leads, setLeads] = useState<Lead[]>([]);
const hasLoaded = useRef(false);

  useEffect(() => {
    hasLoaded.current = true;

    const saved = localStorage.getItem("asap-pipeline");
    if (!saved) return;

    const parsed = JSON.parse(saved);

    setLeads(
      parsed.map((lead: Partial<Lead>) => ({
        id: lead.id || crypto.randomUUID(),
        project: lead.project || "",
        customer: lead.customer || "",
        phone: lead.phone || "",
        moveDate: lead.moveDate || "",
        moveType: lead.moveType || "",
        status: lead.status || "Hot Lead",
        priority: lead.priority || "High",
        assignedTo: lead.assignedTo || "Curt",
        lastContact: lead.lastContact || "",
        nextAction: lead.nextAction || "Follow up with customer",
        notes: lead.notes || "",
      })),
    );
  }, []);
  const [form, setForm] = useState({
    project: "",
    customer: "",
    phone: "",
    moveDate: "",
    moveType: "",
    status: "Hot Lead",
    priority: "High",
    nextAction: "Follow up with customer",
    assignedTo: "Curt",
    lastContact: "",
    notes: "",
  });

 useEffect(() => {
  if (!hasLoaded.current) return;
  localStorage.setItem("asap-pipeline", JSON.stringify(leads));
}, [leads]);

  const counts = useMemo(() => {
    return statuses.reduce(
      (acc, status) => {
        acc[status] = leads.filter((lead) => lead.status === status).length;
        return acc;
      },
      {} as Record<string, number>,
    );
  }, [leads]);

  function addLead(e: React.FormEvent) {
    e.preventDefault();
    if (!form.project || !form.customer) return;

    const newLead: Lead = {
      id: crypto.randomUUID(),
      ...form,
    };

    setLeads([newLead, ...leads]);
    setForm({
      project: "",
      customer: "",
      moveDate: "",
      status: "Hot Lead",
      priority: "High",
      nextAction: "Follow up with customer",
      phone: "",
      moveType: "",
      assignedTo: "Curt",
      lastContact: "",
      notes: "",
    });
  }

  function updateStatus(id: string, status: string) {
    setLeads(
      leads.map((lead) => (lead.id === id ? { ...lead, status } : lead)),
    );
  }

  function deleteLead(id: string) {
    setLeads(leads.filter((lead) => lead.id !== id));
  }

  function copySummary() {
    const summary = statuses
      .map((status) => {
        const items = leads.filter((lead) => lead.status === status);
        if (!items.length) return "";

        return `${status}\n${items
          .map(
            (lead) =>
              `Project ${lead.project} - ${lead.customer} | ${lead.moveDate || "TBD"} | ${lead.nextAction}`,
          )
          .join("\n")}`;
      })
      .filter(Boolean)
      .join("\n\n");

    navigator.clipboard.writeText(summary);
    alert("Summary copied for Jacob.");
  }

  return (
    <main style={page}>
      <header style={header}>
        <div>
          <h1 style={{ margin: 0 }}>🚚 ASAP Pipeline</h1>
          <p style={{ marginTop: 8 }}>
            Simple lead tracking for moving projects.
          </p>
        </div>

        <button onClick={copySummary} style={primaryButton}>
          Copy Summary
        </button>
      </header>

      <section style={statsGrid}>
        {statuses.map((status) => (
          <div key={status} style={statCard}>
            <p style={statLabel}>{status}</p>
            <h2 style={statNumber}>{counts[status] || 0}</h2>
          </div>
        ))}
      </section>

      <form onSubmit={addLead} style={formGrid}>
        <input
          style={input}
          placeholder="Project #"
          value={form.project}
          onChange={(e) => setForm({ ...form, project: e.target.value })}
        />

        <input
          style={input}
          placeholder="Customer Name"
          value={form.customer}
          onChange={(e) => setForm({ ...form, customer: e.target.value })}
        />

        <input
          style={input}
          placeholder="Phone Number"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />

        <label style={fieldLabel}>
          Move Date
          <input
            style={input}
            type="date"
            value={form.moveDate}
            onChange={(e) => setForm({ ...form, moveDate: e.target.value })}
          />
        </label>

        <label style={fieldLabel}>
          Last Contact
          <input
            style={input}
            type="date"
            value={form.lastContact}
            onChange={(e) => setForm({ ...form, lastContact: e.target.value })}
          />
        </label>

        <select
          style={input}
          value={form.moveType}
          onChange={(e) => setForm({ ...form, moveType: e.target.value })}
        >
          <option value="">Move Type</option>
          {moveTypes.map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>

        <select
          style={input}
          value={form.assignedTo}
          onChange={(e) => setForm({ ...form, assignedTo: e.target.value })}
        >
          {assignedUsers.map((user) => (
            <option key={user}>{user}</option>
          ))}
        </select>

        <select
          style={input}
          value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value })}
        >
          {statuses.map((status) => (
            <option key={status}>{status}</option>
          ))}
        </select>

        <select
          style={input}
          value={form.priority}
          onChange={(e) => setForm({ ...form, priority: e.target.value })}
        >
          <option>High</option>
          <option>Medium</option>
          <option>Low</option>
        </select>

        <select
          style={input}
          value={form.nextAction}
          onChange={(e) => setForm({ ...form, nextAction: e.target.value })}
        >
          {nextActions.map((action) => (
            <option key={action}>{action}</option>
          ))}
        </select>

        <button type="submit" style={primaryButton}>
          Add Lead
        </button>
      </form>
      <textarea
        style={{
          width: "100%",
          padding: "12px",
          minHeight: "120px",
          marginTop: "16px",
          border: "1px solid #ccc",
          borderRadius: "8px",
        }}
        placeholder="Customer notes..."
        value={form.notes}
        onChange={(e) => setForm({ ...form, notes: e.target.value })}
      />

      <section style={board}>
        {statuses.map((status) => (
          <div key={status} style={column}>
            <h2 style={columnTitle}>{status}</h2>

            {leads
              .filter((lead) => lead.status === status)
              .map((lead) => (
                <div key={lead.id} style={leadCard}>
                  <strong>Project {lead.project}</strong>

                  <p>{lead.customer}</p>

                  <p>
                    <b>Phone:</b> {lead.phone}
                  </p>

                  <p>
                    <b>Move Type:</b> {lead.moveType || "N/A"}
                  </p>

                  <p>
                    <b>Assigned:</b> {lead.assignedTo}
                  </p>

                  <p>
                    <b>Last Contact:</b> {lead.lastContact || "N/A"}
                  </p>

                  <p>
                    <b>Date:</b> {lead.moveDate || "TBD"}
                  </p>

                  <p>
                    <b>Priority:</b> {lead.priority}
                  </p>

                  <p>
                    <b>Next:</b> {lead.nextAction}
                  </p>

                  <p>
                    <b>Notes:</b> {lead.notes}
                  </p>

                  <select
                    style={input}
                    value={lead.status}
                    onChange={(e) => updateStatus(lead.id, e.target.value)}
                  >
                    {statuses.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>

                  <button
                    onClick={() => deleteLead(lead.id)}
                    style={deleteButton}
                  >
                    Delete
                  </button>
                </div>
              ))}
          </div>
        ))}
      </section>
    </main>
  );
}

const page = {
  padding: 24,
  fontFamily: "Arial, sans-serif",
  background: "#f6f7f9",
  minHeight: "100vh",
};
const header = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 16,
};
const statsGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 12,
  marginTop: 24,
};
const statCard = {
  background: "#fff",
  border: "1px solid #ddd",
  borderRadius: 12,
  padding: 16,
};
const statLabel = { margin: 0, color: "#555", fontSize: 14 };
const statNumber = { margin: "8px 0 0", fontSize: 32 };
const formGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 10,
  marginTop: 24,
};
const input = { padding: 10, border: "1px solid #ccc", borderRadius: 8 };
const primaryButton = {
  padding: "10px 14px",
  border: 0,
  borderRadius: 8,
  background: "#111827",
  color: "#fff",
  cursor: "pointer",
};
const board = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: 14,
  marginTop: 24,
};
const column = {
  background: "#fff",
  border: "1px solid #ddd",
  borderRadius: 12,
  padding: 12,
};
const columnTitle = { fontSize: 16 };
const leadCard = {
  border: "1px solid #eee",
  borderRadius: 10,
  padding: 12,
  marginBottom: 10,
  background: "#fafafa",
};
const deleteButton = {
  marginTop: 8,
  padding: 8,
  border: "1px solid #ddd",
  borderRadius: 8,
  background: "#fff",
  cursor: "pointer",
};

const fieldLabel = {
  display: "grid",
  gap: 6,
  fontSize: 13,
  fontWeight: 700,
  color: "#374151",
};
