"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "../lib/firebase";

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

const LEADS_STORAGE_KEY = "asap-pipeline";
const LEADS_STORE_EVENT = "asap-pipeline-updated";
const EMPTY_LEADS: Lead[] = [];
const leadsCollection = collection(db, "leads");

let cachedLeadsRaw: string | null = null;
let cachedLeadsSnapshot: Lead[] = EMPTY_LEADS;

function normalizeLead(lead: Partial<Lead>): Lead {
  return {
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
  };
}

function readStoredLeads(): Lead[] {
  if (typeof window === "undefined") return EMPTY_LEADS;

  try {
    const saved = localStorage.getItem(LEADS_STORAGE_KEY);
    if (!saved) {
      cachedLeadsRaw = null;
      cachedLeadsSnapshot = EMPTY_LEADS;
      return cachedLeadsSnapshot;
    }

    if (saved === cachedLeadsRaw) {
      return cachedLeadsSnapshot;
    }

    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) {
      cachedLeadsRaw = saved;
      cachedLeadsSnapshot = EMPTY_LEADS;
      return cachedLeadsSnapshot;
    }

    cachedLeadsRaw = saved;
    cachedLeadsSnapshot = parsed.map((lead: Partial<Lead>) => normalizeLead(lead));
    return cachedLeadsSnapshot;
  } catch (err) {
    console.error("Invalid saved pipeline data", err);
    cachedLeadsRaw = null;
    cachedLeadsSnapshot = EMPTY_LEADS;
    return cachedLeadsSnapshot;
  }
}

function getServerLeadsSnapshot(): Lead[] {
  return EMPTY_LEADS;
}

function writeStoredLeads(leads: Lead[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(LEADS_STORAGE_KEY, JSON.stringify(leads));
  window.dispatchEvent(new Event(LEADS_STORE_EVENT));
}

function subscribeToLeads(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleChange = () => onStoreChange();
  window.addEventListener("storage", handleChange);
  window.addEventListener(LEADS_STORE_EVENT, handleChange);

  return () => {
    window.removeEventListener("storage", handleChange);
    window.removeEventListener(LEADS_STORE_EVENT, handleChange);
  };
}

async function upsertLeadInFirestore(lead: Lead) {
  await setDoc(doc(leadsCollection, lead.id), lead, { merge: true });
}

async function deleteLeadInFirestore(leadId: string) {
  await deleteDoc(doc(leadsCollection, leadId));

  // Cleanup legacy docs created before stable document IDs were used.
  const legacySnapshot = await getDocs(
    query(leadsCollection, where("id", "==", leadId)),
  );

  if (!legacySnapshot.empty) {
    const batch = writeBatch(db);
    legacySnapshot.docs.forEach((docSnapshot) => {
      batch.delete(docSnapshot.ref);
    });
    await batch.commit();
  }
}

async function replaceFirestoreLeads(leads: Lead[]) {
  const snapshot = await getDocs(leadsCollection);
  const leadIds = new Set(leads.map((lead) => lead.id));
  const batch = writeBatch(db);

  snapshot.docs.forEach((docSnapshot) => {
    const data = docSnapshot.data() as Partial<Lead>;
    const logicalId = data.id || docSnapshot.id;
    if (!leadIds.has(logicalId)) {
      batch.delete(docSnapshot.ref);
    }
  });

  leads.forEach((lead) => {
    batch.set(doc(leadsCollection, lead.id), lead);
  });

  await batch.commit();
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const leads = useSyncExternalStore(
    subscribeToLeads,
    readStoredLeads,
    getServerLeadsSnapshot,
  );

  useEffect(() => {
    const unsubscribe = onSnapshot(
      leadsCollection,
      (snapshot) => {
        const firestoreLeads = snapshot.docs.map((docSnapshot) => {
          const data = docSnapshot.data() as Partial<Lead>;
          return normalizeLead({ id: data.id || docSnapshot.id, ...data });
        });

        // Keep Firestore as source of truth while preserving local backups.
        writeStoredLeads(firestoreLeads);
      },
      (err) => {
        console.error("Failed to subscribe to Firestore leads", err);
      },
    );

    return () => unsubscribe();
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

  const counts = useMemo(() => {
    return statuses.reduce(
      (acc, status) => {
        acc[status] = leads.filter((lead) => lead.status === status).length;
        return acc;
      },
      {} as Record<string, number>,
    );
  }, [leads]);

  async function updateLead(id: string, updates: Partial<Lead>) {
    const existing = leads.find((lead) => lead.id === id);
    if (!existing) return;

    const updatedLead = normalizeLead({ ...existing, ...updates });
    writeStoredLeads(leads.map((lead) => (lead.id === id ? updatedLead : lead)));

    try {
      await upsertLeadInFirestore(updatedLead);
    } catch (err) {
      console.error("Failed to update lead in Firestore", err);
      alert("Lead updated locally, but Firestore sync failed.");
    }
  }

  async function addLead(e: React.FormEvent) {
    e.preventDefault();
    if (!form.project || !form.customer) return;

    const newLead: Lead = {
      id: crypto.randomUUID(),
      ...form,
    };

    writeStoredLeads([newLead, ...leads]);

    try {
      await upsertLeadInFirestore(newLead);
    } catch (err) {
      console.error("Failed to save new lead to Firestore", err);
      alert("Lead saved locally, but Firestore sync failed.");
    }

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
    void updateLead(id, { status });
  }

  async function deleteLead(id: string) {
    writeStoredLeads(leads.filter((lead) => lead.id !== id));

    try {
      await deleteLeadInFirestore(id);
    } catch (err) {
      console.error("Failed to delete lead from Firestore", err);
      alert("Lead deleted locally, but Firestore sync failed.");
    }
  }

  function editLead(id: string) {
    const existing = leads.find((lead) => lead.id === id);
    if (!existing) return;

    const customer = prompt("Edit customer name", existing.customer);
    if (customer === null) return;

    const notes = prompt("Edit notes", existing.notes);
    if (notes === null) return;

    void updateLead(id, { customer: customer.trim(), notes });
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

  function exportBackup() {
    try {
      const saved = localStorage.getItem(LEADS_STORAGE_KEY);
      const leadsData = saved ? JSON.parse(saved) : leads;

      // capture all localStorage entries (parsed when possible)
      const allLocalStorage: Record<string, unknown> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) as string;
        const value = localStorage.getItem(key);
        try {
          allLocalStorage[key] = value ? JSON.parse(value) : null;
        } catch {
          allLocalStorage[key] = value;
        }
      }

      const payload = {
        exportedAt: new Date().toISOString(),
        exportedFrom: typeof window !== "undefined" ? window.location.href : null,
        exportedBy: typeof navigator !== "undefined" ? navigator.userAgent : null,
        leadCount: Array.isArray(leadsData) ? leadsData.length : 0,
        leads: leadsData,
        statuses,
        localStorage: allLocalStorage,
      };

      const content = JSON.stringify(payload, null, 2);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `asap-pipeline-backup-${date}.json`;

      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export failed", err);
      alert("Export failed. Check console for details.");
    }
  }

  function handleImportClick() {
    const existing = localStorage.getItem(LEADS_STORAGE_KEY);
    if (existing) {
      const proceed = confirm(
        "Importing a backup will overwrite your current leads. Continue?",
      );
      if (!proceed) return;
    }
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const text = ev.target?.result as string;
        const parsed = JSON.parse(text);

        let leadsArray: Partial<Lead>[] | null = null;

        if (Array.isArray(parsed)) leadsArray = parsed;
        else if (Array.isArray(parsed.leads)) leadsArray = parsed.leads;
        else if (
          parsed &&
          parsed.localStorage &&
          parsed.localStorage["asap-pipeline"] &&
          Array.isArray(parsed.localStorage["asap-pipeline"])
        ) {
          leadsArray = parsed.localStorage["asap-pipeline"];
        }

        if (!Array.isArray(leadsArray)) {
          throw new Error("Backup JSON does not contain a leads array.");
        }

        const normalized = leadsArray.map((lead: Partial<Lead>) =>
          normalizeLead(lead),
        );

        writeStoredLeads(normalized);

        try {
          await replaceFirestoreLeads(normalized);
          alert(`Import successful — ${normalized.length} leads restored.`);
        } catch (err) {
          console.error("Import sync to Firestore failed", err);
          alert("Import restored local backup, but Firestore sync failed.");
        }
      } catch (err) {
        console.error("Import failed", err);
        alert("Import failed: " + (err as Error).message);
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    };

    reader.readAsText(file);
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
        <button onClick={exportBackup} style={exportButton}>
          Export Backup
        </button>
        <button onClick={handleImportClick} style={{ ...exportButton, marginLeft: 8 }}>
          Import Backup
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
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

                  <button
                    onClick={() => editLead(lead.id)}
                    style={deleteButton}
                  >
                    Edit
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

const exportButton = {
  padding: "10px 14px",
  border: "1px solid #111827",
  borderRadius: 8,
  background: "#fff",
  color: "#111827",
  cursor: "pointer",
  marginLeft: 8,
};

const fieldLabel = {
  display: "grid",
  gap: 6,
  fontSize: 13,
  fontWeight: 700,
  color: "#374151",
};
