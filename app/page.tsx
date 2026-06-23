"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  collection,
  doc,
  limit,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import {
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import { auth, db } from "../lib/firebase";

type Lead = {
  id: string;
  project: string;
  customer: string;
  phone: string;
  email: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  archivedAt: string;
  archivedBy: string;
  previousStatus: string;
  moveDate: string;
  moveType: string;
  status: string;
  priority: string;
  assignedTo: string;
  lastContact: string;
  nextAction: string;
  notes: string;
};

type ActivityRecord = {
  id: string;
  leadId: string;
  project: string;
  customer: string;
  action: string;
  details: string;
  userEmail: string;
  createdAt: string;
};

type ActivityMeta = {
  label: string;
  icon: string;
  color: string;
  actorText: string;
};

type ActivityFilter =
  | "all"
  | "lead_created"
  | "lead_edited"
  | "status_changed"
  | "lead_deleted"
  | "lead_archived"
  | "lead_restored"
  | "backup_imported";

const activityFilterButtons: Array<{ label: string; value: ActivityFilter }> = [
  { label: "All", value: "all" },
  { label: "Created", value: "lead_created" },
  { label: "Edited", value: "lead_edited" },
  { label: "Status Changed", value: "status_changed" },
  { label: "Archived", value: "lead_archived" },
  { label: "Restored", value: "lead_restored" },
  { label: "Import Backup", value: "backup_imported" },
];

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
const activityCollection = collection(db, "activity");

let cachedLeadsRaw: string | null = null;
let cachedLeadsSnapshot: Lead[] = EMPTY_LEADS;

function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

function normalizeLead(lead: Partial<Lead>): Lead {
  const createdAt = lead.createdAt || getCurrentTimestamp();
  const updatedAt = lead.updatedAt || lead.createdAt || getCurrentTimestamp();

  return {
    id: lead.id || crypto.randomUUID(),
    project: lead.project || "",
    customer: lead.customer || "",
    phone: lead.phone || "",
    email: lead.email || "",
    createdAt,
    updatedAt,
    archived: Boolean(lead.archived),
    archivedAt: lead.archivedAt || "",
    archivedBy: lead.archivedBy || "",
    previousStatus: lead.previousStatus || "",
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

function subscribeToIsMobile(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const media = window.matchMedia("(max-width: 767px)");
  const handleChange = () => onStoreChange();
  media.addEventListener("change", handleChange);

  return () => {
    media.removeEventListener("change", handleChange);
  };
}

function getIsMobileSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(max-width: 767px)").matches;
}

async function upsertLeadInFirestore(lead: Lead) {
  await setDoc(doc(leadsCollection, lead.id), lead, { merge: true });
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

async function addActivityRecord(
  userEmail: string,
  input: Omit<ActivityRecord, "id" | "createdAt" | "userEmail">,
) {
  const id = crypto.randomUUID();
  const activity: ActivityRecord = {
    id,
    userEmail,
    createdAt: new Date().toISOString(),
    ...input,
  };

  await setDoc(doc(activityCollection, id), activity);
}

function getActivityMeta(action: string): ActivityMeta {
  switch (action) {
    case "lead_created":
      return {
        label: "Created",
        icon: "➕",
        color: "#15803d",
        actorText: "created lead",
      };
    case "status_changed":
      return {
        label: "Status Changed",
        icon: "🔄",
        color: "#2563eb",
        actorText: "changed status",
      };
    case "lead_edited":
      return {
        label: "Edited",
        icon: "✏️",
        color: "#ea580c",
        actorText: "edited lead",
      };
    case "lead_deleted":
      return {
        label: "Deleted",
        icon: "🗑️",
        color: "#dc2626",
        actorText: "deleted lead",
      };
    case "lead_archived":
      return {
        label: "Archived",
        icon: "📦",
        color: "#9333ea",
        actorText: "archived lead",
      };
    case "lead_restored":
      return {
        label: "Restored",
        icon: "↩️",
        color: "#0f766e",
        actorText: "restored lead",
      };
    case "backup_imported":
      return {
        label: "Import Backup",
        icon: "📥",
        color: "#7e22ce",
        actorText: "imported backup",
      };
    default:
      return {
        label: "Activity",
        icon: "•",
        color: "#374151",
        actorText: "updated lead",
      };
  }
}

function formatActivityTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;

  const datePart = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timePart = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return `${datePart} ${timePart}`;
}

function formatActivityDetails(item: ActivityRecord): string {
  if (item.action === "status_changed") {
    const match = item.details.match(/status:\s*(.+)\s*->\s*(.+)/i);
    if (match) {
      return `${match[1]} → ${match[2]}`;
    }
  }
  return item.details;
}

function formatActivityDay(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "Unknown Day";

  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getStatusCardVisual(status: string) {
  switch (status) {
    case "Hot Lead":
      return { bg: "#fff7ed", border: "#fdba74" };
    case "Waiting on Jacob":
      return { bg: "#eff6ff", border: "#93c5fd" };
    case "Waiting on Customer":
      return { bg: "#fefce8", border: "#fde047" };
    case "Waiting on ASAP":
      return { bg: "#eef2ff", border: "#a5b4fc" };
    case "Booked / Confirmed":
      return { bg: "#ecfdf3", border: "#86efac" };
    case "Lost / Closed":
      return { bg: "#fef2f2", border: "#fca5a5" };
    default:
      return { bg: "#fff", border: "#ddd" };
  }
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const leads = useSyncExternalStore(
    subscribeToLeads,
    readStoredLeads,
    getServerLeadsSnapshot,
  );
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [recentActivity, setRecentActivity] = useState<ActivityRecord[]>([]);
  const [expandedNotes, setExpandedNotes] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<"dashboard" | "activity" | "archived">("dashboard");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const isMobile = useSyncExternalStore(
    subscribeToIsMobile,
    getIsMobileSnapshot,
    () => false,
  );

  useEffect(() => {
    void setPersistence(auth, browserLocalPersistence).catch((err) => {
      console.error("Failed to set auth persistence", err);
    });

    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthLoading(false);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;

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
  }, [user]);

  useEffect(() => {
    if (!user) return;

    const recentActivityQuery = query(
      activityCollection,
      orderBy("createdAt", "desc"),
      limit(20),
    );

    const unsubscribe = onSnapshot(
      recentActivityQuery,
      (snapshot) => {
        const items = snapshot.docs.map((docSnapshot) => {
          const data = docSnapshot.data() as Partial<ActivityRecord>;
          return {
            id: data.id || docSnapshot.id,
            leadId: data.leadId || "",
            project: data.project || "",
            customer: data.customer || "",
            action: data.action || "",
            details: data.details || "",
            userEmail: data.userEmail || "",
            createdAt: data.createdAt || "",
          } satisfies ActivityRecord;
        });
        setRecentActivity(items);
      },
      (err) => {
        console.error("Failed to subscribe to activity", err);
      },
    );

    return () => unsubscribe();
  }, [user]);

  const [form, setForm] = useState({
    project: "",
    customer: "",
    phone: "",
    email: "",
    moveDate: "",
    moveType: "",
    status: "Hot Lead",
    priority: "High",
    nextAction: "Follow up with customer",
    assignedTo: "Curt",
    lastContact: "",
    notes: "",
  });

  const nonArchivedLeads = useMemo(
    () => leads.filter((lead) => !lead.archived),
    [leads],
  );

  const archivedLeads = useMemo(
    () => leads.filter((lead) => lead.archived),
    [leads],
  );

  const counts = useMemo(() => {
    return statuses.reduce(
      (acc, status) => {
        acc[status] = nonArchivedLeads.filter((lead) => lead.status === status).length;
        return acc;
      },
      {} as Record<string, number>,
    );
  }, [nonArchivedLeads]);

  const normalizedSearchTerm = searchTerm.trim().toLowerCase();

  const filteredLeads = useMemo(() => {
    if (!normalizedSearchTerm) return nonArchivedLeads;

    return nonArchivedLeads.filter((lead) => {
      return [lead.project, lead.customer, lead.phone, lead.email]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearchTerm);
    });
  }, [nonArchivedLeads, normalizedSearchTerm]);

  const filteredArchivedLeads = useMemo(() => {
    if (!normalizedSearchTerm) return archivedLeads;

    return archivedLeads.filter((lead) => {
      return [lead.project, lead.customer, lead.phone, lead.email]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearchTerm);
    });
  }, [archivedLeads, normalizedSearchTerm]);

  const hasSearch = normalizedSearchTerm.length > 0;
  const visibleLeads = filteredLeads;
  const visibleArchivedLeads = filteredArchivedLeads;

  const filteredActivity = useMemo(() => {
    return recentActivity.filter(
      (item) => activityFilter === "all" || item.action === activityFilter,
    );
  }, [recentActivity, activityFilter]);

  const activityGroups = useMemo(() => {
    const groups: Array<{ day: string; items: ActivityRecord[] }> = [];

    filteredActivity.forEach((item) => {
      const day = formatActivityDay(item.createdAt);
      const current = groups[groups.length - 1];

      if (current && current.day === day) {
        current.items.push(item);
        return;
      }

      groups.push({ day, items: [item] });
    });

    return groups;
  }, [filteredActivity]);

  const visibleActivityCount = filteredActivity.length;

  const activityFilterCounts = useMemo(() => {
    return activityFilterButtons.reduce((acc, button) => {
      acc[button.value] = recentActivity.filter(
        (item) => button.value === "all" || item.action === button.value,
      ).length;
      return acc;
    }, {} as Record<ActivityFilter, number>);
  }, [recentActivity]);

  const hasActivity = visibleActivityCount > 0;

  async function updateLead(id: string, updates: Partial<Lead>) {
    const existing = leads.find((lead) => lead.id === id);
    if (!existing) return;

    const updatedLead = normalizeLead({
      ...existing,
      ...updates,
      updatedAt: getCurrentTimestamp(),
    });
    writeStoredLeads(leads.map((lead) => (lead.id === id ? updatedLead : lead)));

    try {
      if (!user) return;
      await upsertLeadInFirestore(updatedLead);

      const statusChanged = updates.status && updates.status !== existing.status;
      const detailParts: string[] = [];

      if (statusChanged) {
        detailParts.push(
          `status: ${existing.status} -> ${updatedLead.status}`,
        );
      }
      if (
        Object.prototype.hasOwnProperty.call(updates, "customer") &&
        updates.customer !== existing.customer
      ) {
        detailParts.push(
          `customer: ${existing.customer} -> ${updatedLead.customer}`,
        );
      }
      if (
        Object.prototype.hasOwnProperty.call(updates, "notes") &&
        updates.notes !== existing.notes
      ) {
        detailParts.push("notes updated");
      }
      if (
        Object.prototype.hasOwnProperty.call(updates, "email") &&
        updates.email !== existing.email
      ) {
        detailParts.push(
          `email: ${existing.email || "none"} -> ${updatedLead.email || "none"}`,
        );
      }

      await addActivityRecord(user.email || "unknown", {
        leadId: updatedLead.id,
        project: updatedLead.project,
        customer: updatedLead.customer,
        action: statusChanged ? "status_changed" : "lead_edited",
        details: detailParts.join("; ") || "Lead updated",
      });
    } catch (err) {
      console.error("Failed to update lead in Firestore", err);
      alert("Lead updated locally, but Firestore sync failed.");
    }
  }

  async function addLead(e: React.FormEvent) {
    e.preventDefault();
    if (!form.project || !form.customer) return;

    const now = getCurrentTimestamp();

    const newLead: Lead = {
      id: crypto.randomUUID(),
      ...form,
      createdAt: now,
      updatedAt: now,
      archived: false,
      archivedAt: "",
      archivedBy: "",
      previousStatus: "",
    };

    writeStoredLeads([newLead, ...leads]);

    try {
      if (!user) return;
      await upsertLeadInFirestore(newLead);
      await addActivityRecord(user.email || "unknown", {
        leadId: newLead.id,
        project: newLead.project,
        customer: newLead.customer,
        action: "lead_created",
        details: `Lead created${newLead.email ? ` | email: ${newLead.email}` : ""}`,
      });
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
      email: "",
      moveType: "",
      assignedTo: "Curt",
      lastContact: "",
      notes: "",
    });
  }

  function updateStatus(id: string, status: string) {
    void updateLead(id, { status });
  }

  async function archiveLead(id: string) {
    const existing = leads.find((lead) => lead.id === id);
    if (!existing) return;

    const updatedLead = normalizeLead({
      ...existing,
      archived: true,
      archivedAt: getCurrentTimestamp(),
      archivedBy: user?.email || "unknown",
      previousStatus: existing.status === "Archived" ? existing.previousStatus : existing.status,
      status: "Archived",
      updatedAt: getCurrentTimestamp(),
    });

    writeStoredLeads(leads.map((lead) => (lead.id === id ? updatedLead : lead)));

    try {
      if (!user) return;
      await upsertLeadInFirestore(updatedLead);
      await addActivityRecord(user.email || "unknown", {
        leadId: updatedLead.id,
        project: updatedLead.project,
        customer: updatedLead.customer,
        action: "lead_archived",
        details: "Lead archived",
      });
    } catch (err) {
      console.error("Failed to archive lead", err);
      alert("Lead archived locally, but Firestore sync failed.");
    }
  }

  async function restoreLead(id: string) {
    const existing = leads.find((lead) => lead.id === id);
    if (!existing) return;

    const restoredStatus = existing.previousStatus || "Hot Lead";
    const updatedLead = normalizeLead({
      ...existing,
      archived: false,
      archivedAt: "",
      archivedBy: "",
      status: restoredStatus,
      previousStatus: "",
      updatedAt: getCurrentTimestamp(),
    });

    writeStoredLeads(leads.map((lead) => (lead.id === id ? updatedLead : lead)));

    try {
      if (!user) return;
      await upsertLeadInFirestore(updatedLead);
      await addActivityRecord(user.email || "unknown", {
        leadId: updatedLead.id,
        project: updatedLead.project,
        customer: updatedLead.customer,
        action: "lead_restored",
        details: "Lead restored",
      });
    } catch (err) {
      console.error("Failed to restore lead", err);
      alert("Lead restored locally, but Firestore sync failed.");
    }
  }

  function editLead(id: string) {
    const existing = leads.find((lead) => lead.id === id);
    if (!existing) return;

    const customer = prompt("Edit customer name", existing.customer);
    if (customer === null) return;

    const notes = prompt("Edit notes", existing.notes);
    if (notes === null) return;

    const email = prompt("Edit email", existing.email);
    if (email === null) return;

    void updateLead(id, { customer: customer.trim(), notes, email: email.trim() });
  }

  function copySummary() {
    const summary = statuses
      .map((status) => {
        const items = nonArchivedLeads.filter((lead) => lead.status === status);
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
          if (!user) throw new Error("Not authenticated");
          await replaceFirestoreLeads(normalized);
          await addActivityRecord(user.email || "unknown", {
            leadId: "backup-import",
            project: "Backup Import",
            customer: "Multiple",
            action: "backup_imported",
            details: `Imported ${normalized.length} leads from backup`,
          });
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

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError("");

    try {
      await signInWithEmailAndPassword(auth, loginEmail.trim(), loginPassword);
      setLoginPassword("");
    } catch (err) {
      console.error("Login failed", err);
      setLoginError("Login failed. Please check your email and password.");
    }
  }

  async function handleLogout() {
    try {
      await signOut(auth);
    } catch (err) {
      console.error("Logout failed", err);
      alert("Logout failed. Please try again.");
    }
  }

  function viewLead(leadId: string) {
    const target = document.getElementById(`lead-${leadId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function toggleLeadNotes(leadId: string) {
    setExpandedNotes((prev) => ({ ...prev, [leadId]: !prev[leadId] }));
  }

  if (authLoading) {
    return (
      <main style={page}>
        <section style={authCard}>
          <h1 style={{ marginTop: 0 }}>ASAP Pipeline</h1>
          <p>Checking authentication...</p>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main style={page}>
        <section style={authCard}>
          <h1 style={{ marginTop: 0 }}>ASAP Pipeline Login</h1>
          <p style={{ marginTop: 8 }}>
            Sign in with your Firebase Email/Password account.
          </p>

          <form onSubmit={handleLogin} style={authForm}>
            <input
              style={input}
              type="email"
              placeholder="Email"
              value={loginEmail}
              onChange={(e) => setLoginEmail(e.target.value)}
              required
            />
            <input
              style={input}
              type="password"
              placeholder="Password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              required
            />
            <button type="submit" style={primaryButton}>
              Login
            </button>
          </form>

          {loginError ? <p style={authErrorText}>{loginError}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main style={page}>
      <header style={header}>
        <div style={headerIdentity}>
          <h1 style={{ margin: 0 }}>🚚 ASAP Pipeline</h1>
          <p style={userEmailText}>Signed in as: {user.email}</p>
        </div>

        <div style={headerActions}>
          <button
            onClick={copySummary}
            style={{ ...primaryButton, ...(isMobile ? mobileButton : {}) }}
          >
            Copy Summary
          </button>
          <button
            onClick={exportBackup}
            style={{ ...exportButton, ...(isMobile ? mobileButton : {}) }}
          >
            Export Backup
          </button>
          <button
            onClick={handleImportClick}
            style={{ ...exportButton, ...(isMobile ? mobileButton : {}) }}
          >
            Import Backup
          </button>
          <button
            onClick={handleLogout}
            style={{ ...deleteButton, ...(isMobile ? mobileButton : {}) }}
          >
            Logout
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
        </div>
      </header>

      <section style={searchSection}>
        <div style={searchRow}>
          <input
            style={searchInput}
            type="search"
            placeholder="Search project, customer, phone, or email..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {hasSearch ? (
            <button
              type="button"
              onClick={() => setSearchTerm("")}
              style={{ ...clearSearchButton, ...(isMobile ? mobileButton : {}) }}
            >
              Clear Search
            </button>
          ) : null}
        </div>
        {hasSearch ? (
          <p style={searchFeedbackText}>
            Showing {activeTab === "archived" ? filteredArchivedLeads.length : filteredLeads.length} result(s) for: {searchTerm.trim()}
          </p>
        ) : null}
      </section>

      <section style={tabBar}>
        <button
          type="button"
          onClick={() => setActiveTab("dashboard")}
          style={{ ...tabButton, ...(activeTab === "dashboard" ? tabButtonActive : {}) }}
        >
          Dashboard
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("activity")}
          style={{ ...tabButton, ...(activeTab === "activity" ? tabButtonActive : {}) }}
        >
          Activity
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("archived")}
          style={{ ...tabButton, ...(activeTab === "archived" ? tabButtonActive : {}) }}
        >
          Archived ({archivedLeads.length})
        </button>
      </section>

      {activeTab === "dashboard" ? (
        <>
              <section style={statsGrid}>
                {statuses.map((status) => (
                  <div
                    key={status}
                    style={{
                      ...statCard,
                      background: getStatusCardVisual(status).bg,
                      borderColor: getStatusCardVisual(status).border,
                    }}
                  >
                    <p style={statLabel}>{status}</p>
                    <h2 style={statNumber}>{counts[status] || 0}</h2>
                  </div>
                ))}
              </section>

              <section style={formSection}>
                <h2 style={sectionTitle}>Add Lead</h2>
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

                  <input
                    style={input}
                    type="email"
                    placeholder="Email Address"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
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

                  <textarea
                    style={notesInput}
                    placeholder="Customer notes..."
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  />

                  <button
                    type="submit"
                    style={{ ...addLeadButton, ...(isMobile ? mobileButton : {}) }}
                  >
                    Add Lead
                  </button>
                </form>
              </section>

              <section style={board}>
                {hasSearch && visibleLeads.length === 0 ? (
                  <div style={noResultsState}>
                    <p style={noResultsText}>No matching leads found</p>
                  </div>
                ) : (
                  statuses.map((status) => {
                    const statusLeads = visibleLeads.filter(
                      (lead) => lead.status === status,
                    );

                    return (
                      <div key={status} style={column}>
                        <h2 style={columnTitle}>{status}</h2>

                        {statusLeads.length === 0 ? (
                          <div style={emptyColumnState}>
                            <p style={emptyColumnText}>No leads in this status</p>
                          </div>
                        ) : (
                          statusLeads.map((lead) => (
                            <div key={lead.id} style={leadCard}>
                              <div id={`lead-${lead.id}`} />
                              <strong>Project {lead.project}</strong>

                              <p style={leadLine}>{lead.customer}</p>

                              <p style={leadLine}>
                                <b>Phone:</b> {lead.phone}
                              </p>

                              <p style={leadLine}>
                                <b>Email:</b> {lead.email || "N/A"}
                              </p>

                              <p style={leadLine}>
                                <b>Move Type:</b> {lead.moveType || "N/A"}
                              </p>

                              <p style={leadLine}>
                                <b>Assigned:</b> {lead.assignedTo}
                              </p>

                              <p style={leadLine}>
                                <b>Last Contact:</b> {lead.lastContact || "N/A"}
                              </p>

                              <p style={leadLine}>
                                <b>Date:</b> {lead.moveDate || "TBD"}
                              </p>

                              <p style={leadLine}>
                                <b>Last Updated:</b> {formatActivityTime(lead.updatedAt)}
                              </p>

                              <p style={leadLine}>
                                <b>Priority:</b> {lead.priority}
                              </p>

                              <p style={leadLine}>
                                <b>Next:</b> {lead.nextAction}
                              </p>

                              <p style={leadNotes}>
                                <b>Notes:</b>{" "}
                                {expandedNotes[lead.id] || lead.notes.length <= 120
                                  ? lead.notes
                                  : `${lead.notes.slice(0, 120)}...`}
                              </p>
                              {lead.notes.length > 120 ? (
                                <button
                                  onClick={() => toggleLeadNotes(lead.id)}
                                  style={{
                                    ...activityViewButton,
                                    ...(isMobile ? mobileButton : {}),
                                  }}
                                >
                                  {expandedNotes[lead.id] ? "Show less" : "Show more"}
                                </button>
                              ) : null}

                              <select
                                style={input}
                                value={lead.status}
                                onChange={(e) => updateStatus(lead.id, e.target.value)}
                              >
                                {statuses.map((s) => (
                                  <option key={s}>{s}</option>
                                ))}
                              </select>

                              <div style={leadActions}>
                                <button
                                  onClick={() => archiveLead(lead.id)}
                                  style={{
                                    ...deleteButton,
                                    ...(isMobile ? mobileButton : {}),
                                  }}
                                >
                                  Archive
                                </button>

                                <button
                                  onClick={() => editLead(lead.id)}
                                  style={{
                                    ...deleteButton,
                                    ...(isMobile ? mobileButton : {}),
                                  }}
                                >
                                  Edit
                                </button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    );
                  })
                )}
              </section>
        </>
      ) : activeTab === "archived" ? (
            <section style={activitySection}>
              <div style={activityHeaderRow}>
                <h2 style={{ margin: 0 }}>Archived Leads ({visibleArchivedLeads.length})</h2>
              </div>

              {hasSearch && visibleArchivedLeads.length === 0 ? (
                <div style={noResultsState}>
                  <p style={noResultsText}>No matching archived leads found</p>
                </div>
              ) : visibleArchivedLeads.length > 0 ? (
                <div style={activityList}>
                  {visibleArchivedLeads.map((lead) => (
                    <div key={lead.id} style={leadCard}>
                      <div id={`lead-${lead.id}`} />
                      <strong>Project {lead.project}</strong>

                      <p style={leadLine}>{lead.customer}</p>

                      <p style={leadLine}>
                        <b>Email:</b> {lead.email || "N/A"}
                      </p>

                      <p style={leadLine}>
                        <b>Phone:</b> {lead.phone || "N/A"}
                      </p>

                      <p style={leadLine}>
                        <b>Archived At:</b> {formatActivityTime(lead.archivedAt)}
                      </p>

                      <p style={leadLine}>
                        <b>Archived By:</b> {lead.archivedBy || "unknown"}
                      </p>

                      <p style={leadLine}>
                        <b>Previous Status:</b> {lead.previousStatus || "Hot Lead"}
                      </p>

                      <p style={leadLine}>
                        <b>Last Updated:</b> {formatActivityTime(lead.updatedAt)}
                      </p>

                      <p style={leadNotes}>
                        <b>Notes:</b> {lead.notes || "N/A"}
                      </p>

                      <div style={leadActions}>
                        <button
                          onClick={() => restoreLead(lead.id)}
                          style={{
                            ...deleteButton,
                            ...(isMobile ? mobileButton : {}),
                          }}
                        >
                          Restore
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ margin: 0, color: "#6b7280" }}>No archived leads yet.</p>
              )}
            </section>
      ) : (
            <section style={activitySection}>
              <div style={activityHeaderRow}>
                <h2 style={{ margin: 0 }}>Recent Activity ({visibleActivityCount})</h2>
                <div style={activityFilterBar}>
                  {activityFilterButtons.map((button) => (
                    <button
                      key={button.value}
                      type="button"
                      onClick={() => setActivityFilter(button.value)}
                      style={{
                        ...activityFilterButton,
                        ...(activityFilter === button.value ? activityFilterButtonActive : {}),
                        ...(isMobile ? mobileButton : {}),
                      }}
                    >
                      {button.label} ({activityFilterCounts[button.value]})
                    </button>
                  ))}
                </div>
              </div>
              {hasActivity ? (
                <div style={activityList}>
                  {activityGroups.map((group) => (
                    <div key={group.day} style={activityDayGroup}>
                      <h3 style={activityDayTitle}>{group.day}</h3>
                      {group.items.map((item) => (
                        <div
                          key={item.id}
                          style={{
                            ...activityItem,
                            borderLeft: `6px solid ${getActivityMeta(item.action).color}`,
                          }}
                        >
                          <p
                            style={{
                              margin: 0,
                              fontWeight: 700,
                              color: getActivityMeta(item.action).color,
                            }}
                          >
                            [{getActivityMeta(item.action).icon} {getActivityMeta(item.action).label}]
                          </p>
                          <p style={{ margin: "8px 0 0", fontWeight: 700 }}>
                            Project {item.project} - {item.customer}
                          </p>
                          <p style={{ margin: "6px 0 0" }}>
                            {item.userEmail.split("@")[0]} {getActivityMeta(item.action).actorText}
                          </p>
                          <p style={{ margin: "6px 0 0" }}>{formatActivityDetails(item)}</p>
                          <p style={activityMetaText}>{formatActivityTime(item.createdAt)}</p>
                          <p style={{ ...activityMetaText, marginTop: 4 }}>{item.userEmail}</p>
                          {leads.some((lead) => lead.id === item.leadId) ? (
                            <button
                              onClick={() => viewLead(item.leadId)}
                              style={{ ...activityViewButton, ...(isMobile ? mobileButton : {}) }}
                            >
                              View Lead
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ margin: 0, color: "#6b7280" }}>No recent activity yet.</p>
              )}
            </section>
          )}
    </main>
  );
}

const page = {
  width: "100%",
  maxWidth: 1280,
  margin: "0 auto",
  padding: 16,
  boxSizing: "border-box" as const,
  overflowX: "hidden" as const,
  fontFamily: "Arial, sans-serif",
  background: "#f6f7f9",
  minHeight: "100vh",
  display: "grid",
  gap: 22,
};
const header = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 16,
  flexWrap: "wrap" as const,
  padding: 16,
  border: "1px solid #ddd",
  borderRadius: 12,
  background: "#fff",
};
const headerIdentity = {
  minWidth: 240,
  display: "grid",
  gap: 8,
};
const headerActions = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: 8,
  justifyContent: "flex-end",
  marginLeft: "auto",
  width: "100%",
  maxWidth: 540,
};
const tabBar = {
  display: "flex",
  gap: 8,
  padding: 6,
  border: "1px solid #ddd",
  borderRadius: 12,
  background: "#fff",
  width: "fit-content",
};
const tabButton = {
  padding: "10px 14px",
  borderRadius: 8,
  border: "1px solid transparent",
  background: "transparent",
  color: "#374151",
  cursor: "pointer",
  fontWeight: 700,
};
const tabButtonActive = {
  background: "#111827",
  color: "#fff",
};
const statsGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 14,
};
const statCard = {
  background: "#fff",
  border: "1px solid #ddd",
  borderRadius: 12,
  padding: 18,
  minHeight: 110,
  display: "grid",
  alignContent: "space-between",
};
const statLabel = { margin: 0, color: "#555", fontSize: 14, fontWeight: 600 };
const statNumber = {
  margin: "12px 0 0",
  fontSize: 42,
  lineHeight: 1,
  fontWeight: 700,
  color: "#111827",
};
const formSection = {
  border: "1px solid #ddd",
  borderRadius: 12,
  padding: 16,
  background: "#fff",
};
const sectionTitle = {
  marginTop: 0,
  marginBottom: 14,
};
const formGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: 12,
};
const input = {
  width: "100%",
  padding: 10,
  border: "1px solid #ccc",
  borderRadius: 8,
  boxSizing: "border-box" as const,
};
const notesInput = {
  gridColumn: "1 / -1",
  width: "100%",
  minHeight: 120,
  padding: 12,
  border: "1px solid #ccc",
  borderRadius: 8,
  boxSizing: "border-box" as const,
  resize: "vertical" as const,
};
const primaryButton = {
  padding: "10px 14px",
  border: 0,
  borderRadius: 8,
  background: "#111827",
  color: "#fff",
  cursor: "pointer",
};
const addLeadButton = {
  ...primaryButton,
  gridColumn: "1 / -1",
  padding: "12px 16px",
  background: "#0f766e",
  fontWeight: 700,
};
const board = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
  gap: 16,
};
const column = {
  background: "#fff",
  border: "1px solid #ddd",
  borderRadius: 12,
  padding: 14,
  minWidth: 0,
  minHeight: 280,
  display: "flex",
  flexDirection: "column" as const,
  gap: 10,
};
const columnTitle = { fontSize: 16 };
const emptyColumnState = {
  minHeight: 180,
  display: "grid",
  placeItems: "center",
  border: "1px dashed #d1d5db",
  borderRadius: 10,
  background: "#f9fafb",
  padding: 16,
};

const emptyColumnText = {
  margin: 0,
  color: "#6b7280",
  fontSize: 14,
  textAlign: "center" as const,
};
const leadCard = {
  border: "1px solid #eee",
  borderRadius: 10,
  padding: 10,
  marginBottom: 8,
  background: "#fafafa",
  minWidth: 0,
  fontSize: 14,
};
const leadLine = {
  margin: "6px 0 0",
  lineHeight: 1.35,
  overflowWrap: "anywhere" as const,
};
const leadNotes = {
  margin: "8px 0 0",
  lineHeight: 1.35,
  color: "#374151",
  background: "#fff",
  border: "1px solid #eee",
  borderRadius: 8,
  padding: 8,
  overflowWrap: "anywhere" as const,
};
const leadActions = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap" as const,
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
};

const fieldLabel = {
  display: "grid",
  gap: 6,
  fontSize: 13,
  fontWeight: 700,
  color: "#374151",
};

const authCard = {
  maxWidth: 420,
  margin: "80px auto",
  padding: 24,
  borderRadius: 12,
  border: "1px solid #ddd",
  background: "#fff",
};

const authForm = {
  display: "grid",
  gap: 10,
  marginTop: 16,
};

const authErrorText = {
  color: "#b91c1c",
  marginTop: 12,
};

const userEmailText = {
  marginTop: 8,
  marginBottom: 0,
  fontSize: 13,
  color: "#4b5563",
};

const searchSection = {
  display: "grid",
  gap: 8,
  border: "1px solid #ddd",
  borderRadius: 12,
  padding: 16,
  background: "#fff",
  position: "sticky" as const,
  top: 12,
  zIndex: 10,
  boxShadow: "0 8px 24px rgba(15, 23, 42, 0.08)",
};

const searchRow = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap" as const,
  alignItems: "center",
};

const searchInput = {
  flex: "1 1 320px",
  minWidth: 0,
  padding: 12,
  border: "1px solid #d1d5db",
  borderRadius: 10,
  boxSizing: "border-box" as const,
};

const clearSearchButton = {
  padding: "12px 14px",
  border: "1px solid #d1d5db",
  borderRadius: 10,
  background: "#f9fafb",
  color: "#374151",
  cursor: "pointer",
  fontWeight: 700,
};

const searchFeedbackText = {
  margin: 0,
  color: "#6b7280",
  fontSize: 13,
};

const noResultsState = {
  minHeight: 220,
  display: "grid",
  placeItems: "center",
  border: "1px dashed #d1d5db",
  borderRadius: 12,
  background: "#fafafa",
  padding: 16,
  gridColumn: "1 / -1",
};

const noResultsText = {
  margin: 0,
  color: "#6b7280",
  fontSize: 14,
  textAlign: "center" as const,
};

const activitySection = {
  border: "1px solid #ddd",
  borderRadius: 12,
  padding: 18,
  background: "#fff",
};

const activityHeaderRow = {
  display: "grid",
  gap: 12,
  marginBottom: 16,
};

const activityFilterBar = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: 8,
};

const activityFilterButton = {
  padding: "8px 12px",
  borderStyle: "solid",
  borderWidth: 1,
  borderColor: "#d1d5db",
  borderRadius: 999,
  background: "#f9fafb",
  color: "#374151",
  cursor: "pointer",
  fontWeight: 700,
};

const activityFilterButtonActive = {
  background: "#111827",
  borderColor: "#111827",
  color: "#fff",
};

const activityList = {
  display: "grid",
  gap: 10,
  gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
};

const activityItem = {
  border: "1px solid #eee",
  borderRadius: 10,
  padding: 12,
  background: "#fafafa",
};

const activityDayGroup = {
  display: "grid",
  gap: 8,
};

const activityDayTitle = {
  margin: "8px 0 0",
  fontSize: 14,
  color: "#4b5563",
  letterSpacing: 0.2,
  textTransform: "uppercase" as const,
};

const activityMetaText = {
  margin: "6px 0 0",
  color: "#6b7280",
  fontSize: 12,
};

const activityViewButton = {
  marginTop: 10,
  padding: "8px 10px",
  border: "1px solid #ddd",
  borderRadius: 8,
  background: "#fff",
  cursor: "pointer",
};

const mobileButton = {
  width: "100%",
  marginLeft: 0,
};
