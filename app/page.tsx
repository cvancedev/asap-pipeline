"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  addDoc,
  collection,
  doc,
  limit,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
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
  followUpDate: string;
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

type TeamMessage = {
  id: string;
  text: string;
  userEmail: string;
  userName: string;
  createdAt: Timestamp | null;
  pinned: boolean;
  reactionByUser: Record<string, TeamReactionEmoji>;
};

type TeamReactionEmoji = "👍" | "✅" | "👀";

type TeamMessageToast = {
  messageId: string;
  sender: string;
  preview: string;
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
  "Waiting on Curt",
  "Waiting on Ava",
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

const assignedUsers = ["Curt", "Jacob", "Ava"];
const teamReactionOptions: TeamReactionEmoji[] = ["👍", "✅", "👀"];

const LEADS_STORAGE_KEY = "asap-pipeline";
const LEADS_STORE_EVENT = "asap-pipeline-updated";
const EMPTY_LEADS: Lead[] = [];
const leadsCollection = collection(db, "leads");
const activityCollection = collection(db, "activity");
const teamMessagesCollection = collection(db, "teamMessages");

let cachedLeadsRaw: string | null = null;
let cachedLeadsSnapshot: Lead[] = EMPTY_LEADS;

function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

function normalizeLead(lead: Partial<Lead>): Lead {
  const createdAt = lead.createdAt || getCurrentTimestamp();
  const updatedAt = lead.updatedAt || lead.createdAt || getCurrentTimestamp();
  const normalizedStatus = lead.status === "Waiting on ASAP" ? "Waiting on Curt" : lead.status;
  const normalizedPreviousStatus =
    lead.previousStatus === "Waiting on ASAP" ? "Waiting on Curt" : lead.previousStatus;

  return {
    id: lead.id || crypto.randomUUID(),
    project: lead.project || "",
    customer: lead.customer || "",
    phone: lead.phone || "",
    email: lead.email || "",
    followUpDate: lead.followUpDate || "",
    createdAt,
    updatedAt,
    archived: Boolean(lead.archived),
    archivedAt: lead.archivedAt || "",
    archivedBy: lead.archivedBy || "",
    previousStatus: normalizedPreviousStatus || "",
    moveDate: lead.moveDate || "",
    moveType: lead.moveType || "",
    status: normalizedStatus || "Hot Lead",
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

  if (item.details.includes("follow-up:")) {
    return item.details.replace(/follow-up:\s*/gi, "Follow-Up: ");
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
    case "Waiting on Curt":
      return { bg: "#dbeafe", border: "#60a5fa" };
    case "Waiting on Ava":
      return { bg: "#f3e8ff", border: "#c084fc" };
    case "Booked / Confirmed":
      return { bg: "#ecfdf3", border: "#86efac" };
    case "Lost / Closed":
      return { bg: "#fef2f2", border: "#fca5a5" };
    default:
      return { bg: "#1F2937", border: "#374151" };
  }
}

function getNewestTeamMessageAtMs(messages: TeamMessage[]): number {
  return messages.reduce((latest, message) => {
    const createdAtMs = message.createdAt?.toMillis() || 0;
    return createdAtMs > latest ? createdAtMs : latest;
  }, 0);
}

function sanitizeReactionByUser(input: unknown): Record<string, TeamReactionEmoji> {
  if (!input || typeof input !== "object") return {};

  const reactionByUser: Record<string, TeamReactionEmoji> = {};
  Object.entries(input as Record<string, unknown>).forEach(([email, reaction]) => {
    if (reaction === "👍" || reaction === "✅" || reaction === "👀") {
      reactionByUser[email] = reaction;
    }
  });

  return reactionByUser;
}

function getTeamReactionCount(
  reactionByUser: Record<string, TeamReactionEmoji>,
  emoji: TeamReactionEmoji,
): number {
  return Object.values(reactionByUser).filter((reaction) => reaction === emoji).length;
}

function getTeamMessagePreview(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) return "(no text)";
  if (singleLine.length <= 90) return singleLine;
  return `${singleLine.slice(0, 90)}...`;
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const leadFormSectionRef = useRef<HTMLElement | null>(null);
  const moveDateInputRef = useRef<HTMLInputElement | null>(null);
  const lastContactInputRef = useRef<HTMLInputElement | null>(null);
  const followUpDateInputRef = useRef<HTMLInputElement | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const teamMessageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const hasInitializedTeamChatReadRef = useRef(false);
  const teamChatLastReadAtMsRef = useRef(0);
  const hasInitializedTeamChatToastRef = useRef(false);
  const knownTeamMessageIdsRef = useRef(new Set<string>());
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
  const [teamMessages, setTeamMessages] = useState<TeamMessage[]>([]);
  const [teamMessageInput, setTeamMessageInput] = useState("");
  const [isSendingTeamMessage, setIsSendingTeamMessage] = useState(false);
  const [teamChatUnreadCount, setTeamChatUnreadCount] = useState(0);
  const [teamChatToast, setTeamChatToast] = useState<TeamMessageToast | null>(null);
  const [expandedNotes, setExpandedNotes] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<"dashboard" | "activity" | "archived" | "team-chat">("dashboard");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [showOverdueOnly, setShowOverdueOnly] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);
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

    const leadsNeedingMigration = leads.filter(
      (lead) => lead.status === "Waiting on ASAP" || lead.previousStatus === "Waiting on ASAP",
    );
    if (leadsNeedingMigration.length === 0) return;

    const migratedLeads = leads.map((lead) => {
      const nextStatus = lead.status === "Waiting on ASAP" ? "Waiting on Curt" : lead.status;
      const nextPreviousStatus =
        lead.previousStatus === "Waiting on ASAP" ? "Waiting on Curt" : lead.previousStatus;

      if (nextStatus === lead.status && nextPreviousStatus === lead.previousStatus) {
        return lead;
      }

      return normalizeLead({
        ...lead,
        status: nextStatus,
        previousStatus: nextPreviousStatus,
        updatedAt: getCurrentTimestamp(),
      });
    });

    writeStoredLeads(migratedLeads);

    void Promise.all(
      migratedLeads
        .filter((lead) =>
          leadsNeedingMigration.some((oldLead) => oldLead.id === lead.id),
        )
        .map((lead) => upsertLeadInFirestore(lead)),
    ).catch((err) => {
      console.error("Failed to migrate Waiting on ASAP leads", err);
    });
  }, [leads, user]);

  useEffect(() => {
    if (!user) return;

    const teamChatQuery = query(
      teamMessagesCollection,
      orderBy("createdAt", "desc"),
      limit(300),
    );

    const unsubscribe = onSnapshot(
      teamChatQuery,
      (snapshot) => {
        const items = snapshot.docs.map((docSnapshot) => {
          const data = docSnapshot.data() as Partial<TeamMessage>;
          return {
            id: docSnapshot.id,
            text: data.text || "",
            userEmail: data.userEmail || "unknown",
            userName: data.userName || "",
            createdAt: data.createdAt || null,
            pinned: Boolean(data.pinned),
            reactionByUser: sanitizeReactionByUser(data.reactionByUser),
          } satisfies TeamMessage;
        });

        setTeamMessages(items);

        const newestMessageAtMs = getNewestTeamMessageAtMs(items);

        if (!hasInitializedTeamChatReadRef.current) {
          hasInitializedTeamChatReadRef.current = true;
          teamChatLastReadAtMsRef.current = newestMessageAtMs;
          setTeamChatUnreadCount(0);
          return;
        }

        if (activeTab === "team-chat") {
          teamChatLastReadAtMsRef.current = newestMessageAtMs;
          setTeamChatUnreadCount(0);
          return;
        }

        const unreadCount = items.filter((message) => {
          const createdAtMs = message.createdAt?.toMillis() || 0;
          return message.userEmail !== user.email && createdAtMs > teamChatLastReadAtMsRef.current;
        }).length;

        setTeamChatUnreadCount(unreadCount);

        if (!hasInitializedTeamChatToastRef.current) {
          hasInitializedTeamChatToastRef.current = true;
          knownTeamMessageIdsRef.current = new Set(items.map((message) => message.id));
          return;
        }

        const newestExternalMessage = items.find(
          (message) => !knownTeamMessageIdsRef.current.has(message.id) && message.userEmail !== user.email,
        );

        knownTeamMessageIdsRef.current = new Set(items.map((message) => message.id));

        if (!newestExternalMessage) return;

        const sender =
          newestExternalMessage.userName || newestExternalMessage.userEmail.split("@")[0] || "unknown";
        setTeamChatToast({
          messageId: newestExternalMessage.id,
          sender,
          preview: getTeamMessagePreview(newestExternalMessage.text),
        });
      },
      (err) => {
        console.error("Failed to subscribe to team chat", err);
      },
    );

    return () => unsubscribe();
  }, [activeTab, user]);

  useEffect(() => {
    if (activeTab !== "team-chat") return;
    const list = chatListRef.current;
    if (!list) return;
    list.scrollTop = 0;
  }, [activeTab, teamMessages]);

  useEffect(() => {
    if (activeTab !== "team-chat") return;
    teamMessageInputRef.current?.focus();
  }, [activeTab]);

  useEffect(() => {
    if (!teamChatToast) return;

    const timeoutId = window.setTimeout(() => {
      setTeamChatToast((current) => (current?.messageId === teamChatToast.messageId ? null : current));
    }, 6000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [teamChatToast]);

  useEffect(() => {
    const handleScroll = () => {
      setHasScrolled(window.scrollY > 0);
    };

    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

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

  const createInitialForm = () => ({
    project: "",
    customer: "",
    phone: "",
    email: "",
    followUpDate: "",
    moveDate: "",
    moveType: "",
    status: "Hot Lead",
    priority: "High",
    nextAction: "Follow up with customer",
    assignedTo: "Curt",
    lastContact: "",
    notes: "",
  });

  const [form, setForm] = useState(createInitialForm);
  const [editingLeadId, setEditingLeadId] = useState<string | null>(null);

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

  const overdueFollowUpsCount = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return nonArchivedLeads.filter((lead) => {
      if (!lead.followUpDate) return false;
      if (lead.status === "Booked / Confirmed" || lead.status === "Lost / Closed") {
        return false;
      }

      const followUp = new Date(lead.followUpDate);
      if (Number.isNaN(followUp.getTime())) return false;
      followUp.setHours(0, 0, 0, 0);

      return followUp < today;
    }).length;
  }, [nonArchivedLeads]);

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
  const overdueFilteredLeads = useMemo(() => {
    if (!showOverdueOnly) return visibleLeads;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return visibleLeads.filter((lead) => {
      if (!lead.followUpDate) return false;
      if (lead.status === "Booked / Confirmed" || lead.status === "Lost / Closed") {
        return false;
      }

      const followUp = new Date(lead.followUpDate);
      if (Number.isNaN(followUp.getTime())) return false;
      followUp.setHours(0, 0, 0, 0);

      return followUp < today;
    });
  }, [showOverdueOnly, visibleLeads]);
  const statusFilteredLeads = useMemo(() => {
    if (!selectedStatus) return overdueFilteredLeads;
    return overdueFilteredLeads.filter((lead) => lead.status === selectedStatus);
  }, [overdueFilteredLeads, selectedStatus]);

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
      if (
        Object.prototype.hasOwnProperty.call(updates, "followUpDate") &&
        updates.followUpDate !== existing.followUpDate
      ) {
        detailParts.push(
          `follow-up: ${existing.followUpDate || "none"} -> ${updatedLead.followUpDate || "none"}`,
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
        details: `Lead created${newLead.email ? ` | email: ${newLead.email}` : ""}${newLead.followUpDate ? ` | follow-up: ${newLead.followUpDate}` : ""}`,
      });
    } catch (err) {
      console.error("Failed to save new lead to Firestore", err);
      alert("Lead saved locally, but Firestore sync failed.");
    }

    setForm(createInitialForm());
  }

  async function saveEditedLead(e: React.FormEvent) {
    e.preventDefault();
    if (!editingLeadId) return;

    await updateLead(editingLeadId, {
      project: form.project.trim(),
      customer: form.customer.trim(),
      phone: form.phone,
      email: form.email.trim(),
      followUpDate: form.followUpDate,
      moveDate: form.moveDate,
      moveType: form.moveType,
      status: form.status,
      priority: form.priority,
      nextAction: form.nextAction,
      assignedTo: form.assignedTo,
      lastContact: form.lastContact,
      notes: form.notes,
    });

    setEditingLeadId(null);
    setForm(createInitialForm());
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

    setForm({
      project: existing.project,
      customer: existing.customer,
      phone: existing.phone,
      email: existing.email,
      followUpDate: existing.followUpDate,
      moveDate: existing.moveDate,
      moveType: existing.moveType,
      status: existing.status,
      priority: existing.priority,
      nextAction: existing.nextAction,
      assignedTo: existing.assignedTo,
      lastContact: existing.lastContact,
      notes: existing.notes,
    });
    setEditingLeadId(id);
    leadFormSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
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

  function openDatePicker(input: HTMLInputElement | null) {
    if (!input) return;

    try {
      if (typeof input.showPicker === "function") {
        input.showPicker();
        return;
      }
    } catch {
      // Some browsers require user gesture and can throw when showPicker is blocked.
    }

    input.focus();
  }

  function formatTeamMessageTime(createdAt: TeamMessage["createdAt"]): string {
    if (!createdAt) return "Sending...";
    return createdAt.toDate().toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  async function sendTeamMessage() {
    if (!user) return;

    const text = teamMessageInput.trim();
    if (!text) return;

    setIsSendingTeamMessage(true);
    try {
      await addDoc(teamMessagesCollection, {
        text,
        userEmail: user.email || "unknown",
        userName: user.displayName || "",
        createdAt: serverTimestamp(),
      });
      setTeamMessageInput("");
    } catch (err) {
      console.error("Failed to send team message", err);
      alert("Message failed to send. Please try again.");
    } finally {
      setIsSendingTeamMessage(false);
    }
  }

  function handleTeamMessageKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    void sendTeamMessage();
  }

  function openTeamChatTab() {
    teamChatLastReadAtMsRef.current = getNewestTeamMessageAtMs(teamMessages);
    setTeamChatUnreadCount(0);
    setTeamChatToast(null);
    setActiveTab("team-chat");
  }

  async function toggleTeamMessagePinned(message: TeamMessage) {
    try {
      await setDoc(
        doc(teamMessagesCollection, message.id),
        { pinned: !message.pinned },
        { merge: true },
      );
    } catch (err) {
      console.error("Failed to update pinned message", err);
      alert("Could not update pin. Please try again.");
    }
  }

  async function setTeamMessageReaction(message: TeamMessage, emoji: TeamReactionEmoji) {
    if (!user?.email) return;

    const nextReactionByUser: Record<string, TeamReactionEmoji> = {
      ...message.reactionByUser,
    };

    if (nextReactionByUser[user.email] === emoji) {
      delete nextReactionByUser[user.email];
    } else {
      nextReactionByUser[user.email] = emoji;
    }

    try {
      await setDoc(
        doc(teamMessagesCollection, message.id),
        { reactionByUser: nextReactionByUser },
        { merge: true },
      );
    } catch (err) {
      console.error("Failed to update message reaction", err);
      alert("Could not update reaction. Please try again.");
    }
  }

  const pinnedTeamMessages = useMemo(
    () => teamMessages.filter((message) => message.pinned),
    [teamMessages],
  );

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

      <section
        style={{
          ...searchSection,
          ...(hasScrolled ? searchSectionScrolled : {}),
        }}
      >
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
        {activeTab === "dashboard" && selectedStatus ? (
          <p style={searchFeedbackText}>Status filter: {selectedStatus}</p>
        ) : null}
        {activeTab === "dashboard" && showOverdueOnly ? (
          <p style={searchFeedbackText}>Overdue filter: On</p>
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
        <button
          type="button"
          onClick={openTeamChatTab}
          style={{ ...tabButton, ...(activeTab === "team-chat" ? tabButtonActive : {}) }}
        >
          Team Chat{teamChatUnreadCount > 0 ? ` (${teamChatUnreadCount})` : ""}
        </button>
      </section>

      {activeTab === "dashboard" ? (
        <>
              <section style={statsGrid}>
                {statuses.map((status) => (
                  <button
                    key={status}
                    type="button"
                    onClick={() =>
                      setSelectedStatus((current) => (current === status ? null : status))
                    }
                    style={{
                      ...statCard,
                      background: getStatusCardVisual(status).bg,
                      borderColor: getStatusCardVisual(status).border,
                      ...(selectedStatus === status ? selectedStatCard : {}),
                    }}
                  >
                    <p style={{ ...statLabel, color: "#334155" }}>{status}</p>
                    <h2 style={{ ...statNumber, color: "#0F172A" }}>{counts[status] || 0}</h2>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setSelectedStatus(null)}
                  style={{
                    ...statCard,
                    ...(selectedStatus === null ? selectedStatCard : {}),
                    background: "#1F2937",
                    borderColor: "#374151",
                  }}
                >
                  <p style={{ ...statLabel, color: "#F9FAFB" }}>All Leads</p>
                  <h2 style={{ ...statNumber, color: "#F9FAFB" }}>{nonArchivedLeads.length}</h2>
                </button>
                <button
                  type="button"
                  onClick={() => setShowOverdueOnly((current) => !current)}
                  style={{
                    ...statCard,
                    ...(showOverdueOnly ? selectedStatCard : {}),
                    background: "#1F2937",
                    borderColor: "#fdba74",
                  }}
                >
                  <p style={{ ...statLabel, color: "#F9FAFB" }}>Overdue Follow-Ups</p>
                  <h2 style={{ ...statNumber, color: "#F9FAFB" }}>{overdueFollowUpsCount}</h2>
                </button>
              </section>

              {selectedStatus || showOverdueOnly ? (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedStatus(null);
                    setShowOverdueOnly(false);
                  }}
                  style={{ ...clearSearchButton, width: "fit-content" }}
                >
                  Clear Filter
                </button>
              ) : null}

              <section ref={leadFormSectionRef} style={formSection}>
                <h2 style={sectionTitle}>{editingLeadId ? "Edit Lead" : "Add Lead"}</h2>
                <form onSubmit={editingLeadId ? saveEditedLead : addLead} style={formGrid}>
                  <div
                    style={{
                      ...formRow,
                      gridTemplateColumns: isMobile ? "1fr" : "repeat(4, minmax(0, 1fr))",
                    }}
                  >
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
                  </div>

                  <div
                    style={{
                      ...formRow,
                      gridTemplateColumns: isMobile ? "1fr" : "repeat(4, minmax(0, 1fr))",
                    }}
                  >
                    <label style={fieldLabel}>
                      Move Date
                      <div
                        style={dateInputWrapper}
                        onClick={() => openDatePicker(moveDateInputRef.current)}
                      >
                        <input
                          ref={moveDateInputRef}
                          style={{ ...input, ...dateInputField }}
                          className="custom-date-input"
                          type="date"
                          value={form.moveDate}
                          onChange={(e) => setForm({ ...form, moveDate: e.target.value })}
                        />
                        <button
                          type="button"
                          style={datePickerButton}
                          aria-label="Open move date picker"
                          onClick={() => openDatePicker(moveDateInputRef.current)}
                        >
                          📅
                        </button>
                      </div>
                    </label>

                    <label style={fieldLabel}>
                      Follow-Up Date
                      <div
                        style={dateInputWrapper}
                        onClick={() => openDatePicker(followUpDateInputRef.current)}
                      >
                        <input
                          ref={followUpDateInputRef}
                          style={{ ...input, ...dateInputField }}
                          className="custom-date-input"
                          type="date"
                          value={form.followUpDate}
                          onChange={(e) => setForm({ ...form, followUpDate: e.target.value })}
                        />
                        <button
                          type="button"
                          style={datePickerButton}
                          aria-label="Open follow-up date picker"
                          onClick={() => openDatePicker(followUpDateInputRef.current)}
                        >
                          📅
                        </button>
                      </div>
                    </label>

                    <label style={fieldLabel}>
                      Last Contact
                      <div
                        style={dateInputWrapper}
                        onClick={() => openDatePicker(lastContactInputRef.current)}
                      >
                        <input
                          ref={lastContactInputRef}
                          style={{ ...input, ...dateInputField }}
                          className="custom-date-input"
                          type="date"
                          value={form.lastContact}
                          onChange={(e) => setForm({ ...form, lastContact: e.target.value })}
                        />
                        <button
                          type="button"
                          style={datePickerButton}
                          aria-label="Open last contact date picker"
                          onClick={() => openDatePicker(lastContactInputRef.current)}
                        >
                          📅
                        </button>
                      </div>
                    </label>

                    <label style={fieldLabel}>
                      Move Type
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
                    </label>
                  </div>

                  <div
                    style={{
                      ...formRow,
                      gridTemplateColumns: isMobile ? "1fr" : "repeat(4, minmax(0, 1fr))",
                    }}
                  >
                    <label style={fieldLabel}>
                      Assigned To
                      <select
                        style={input}
                        value={form.assignedTo}
                        onChange={(e) => setForm({ ...form, assignedTo: e.target.value })}
                      >
                        {assignedUsers.map((user) => (
                          <option key={user}>{user}</option>
                        ))}
                      </select>
                    </label>

                    <label style={fieldLabel}>
                      Status
                      <select
                        style={input}
                        value={form.status}
                        onChange={(e) => setForm({ ...form, status: e.target.value })}
                      >
                        {statuses.map((status) => (
                          <option key={status}>{status}</option>
                        ))}
                      </select>
                    </label>

                    <label style={fieldLabel}>
                      Priority
                      <select
                        style={input}
                        value={form.priority}
                        onChange={(e) => setForm({ ...form, priority: e.target.value })}
                      >
                        <option>High</option>
                        <option>Medium</option>
                        <option>Low</option>
                      </select>
                    </label>

                    <label style={fieldLabel}>
                      Next Action
                      <select
                        style={input}
                        value={form.nextAction}
                        onChange={(e) => setForm({ ...form, nextAction: e.target.value })}
                      >
                        {nextActions.map((action) => (
                          <option key={action}>{action}</option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <label style={{ ...fieldLabel, gridColumn: "1 / -1" }}>
                    Additional Details (Optional)
                    <textarea
                      style={notesInput}
                      placeholder="Only add details that aren't already captured by the dropdowns."
                      value={form.notes}
                      onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    />
                  </label>

                  <div style={formActionsRow}>
                    <button
                      type="submit"
                      style={{ ...addLeadButton, ...(isMobile ? mobileButton : {}) }}
                    >
                      {editingLeadId ? "Save Changes" : "Add Lead"}
                    </button>
                  </div>
                </form>
              </section>

              <section style={board}>
                {statusFilteredLeads.length === 0 ? (
                  <div style={noResultsState}>
                    <p style={noResultsText}>
                      {selectedStatus
                        ? "No leads found for this status"
                        : showOverdueOnly
                          ? "No overdue follow-ups found"
                          : "No matching leads found"}
                    </p>
                  </div>
                ) : (
                  (selectedStatus ? [selectedStatus] : statuses).map((status) => {
                    const statusLeads = statusFilteredLeads.filter((lead) => lead.status === status);

                    return (
                      <div key={status} style={column}>
                        <h2 style={columnTitle}>{status}</h2>

                        {statusLeads.length === 0 ? (
                          <div style={emptyColumnState}>
                            <p style={emptyColumnText}>No leads in this status</p>
                          </div>
                        ) : (
                          statusLeads.map((lead) => {
                            const additionalDetails = lead.notes.trim();

                            return (
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
                                <b>Follow-Up:</b> {lead.followUpDate || "N/A"}
                              </p>

                              <p style={leadLine}>
                                <b>Last Updated:</b> {formatActivityTime(lead.updatedAt)}
                              </p>

                              <p style={leadLine}>
                                <b>Priority:</b> {lead.priority}
                              </p>

                              <p style={leadLine}>
                                <b>Next Action:</b> {lead.nextAction}
                              </p>

                              {additionalDetails ? (
                                <>
                                  <p style={leadNotes}>
                                    <b>Additional Details:</b>{" "}
                                    {expandedNotes[lead.id] || additionalDetails.length <= 120
                                      ? additionalDetails
                                      : `${additionalDetails.slice(0, 120)}...`}
                                  </p>
                                  {additionalDetails.length > 120 ? (
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
                                </>
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
                          );
                          })
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

                      <p style={leadLine}>
                        <b>Next Action:</b> {lead.nextAction}
                      </p>

                      {lead.notes.trim() ? (
                        <p style={leadNotes}>
                          <b>Additional Details:</b> {lead.notes}
                        </p>
                      ) : null}

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
                <p style={{ margin: 0, color: "#9CA3AF" }}>No archived leads yet.</p>
              )}
            </section>
      ) : activeTab === "team-chat" ? (
            <section style={activitySection}>
              <div style={activityHeaderRow}>
                <h2 style={{ margin: 0 }}>Team Chat</h2>
                <p style={searchFeedbackText}>
                  Messages update in real time. Press Enter to send, Shift+Enter for a new line.
                </p>
              </div>

              <div style={teamChatComposer}>
                <textarea
                  ref={teamMessageInputRef}
                  style={teamChatInput}
                  placeholder="Type a team message..."
                  value={teamMessageInput}
                  onChange={(e) => setTeamMessageInput(e.target.value)}
                  onKeyDown={handleTeamMessageKeyDown}
                />
                <button
                  type="button"
                  onClick={() => void sendTeamMessage()}
                  disabled={isSendingTeamMessage || teamMessageInput.trim().length === 0}
                  style={{
                    ...primaryButton,
                    ...(isSendingTeamMessage || teamMessageInput.trim().length === 0
                      ? disabledButton
                      : {}),
                  }}
                >
                  Send
                </button>
              </div>

              {pinnedTeamMessages.length > 0 ? (
                <div style={teamPinnedSection}>
                  <p style={teamPinnedTitle}>Pinned Messages</p>
                  <div style={teamPinnedList}>
                    {pinnedTeamMessages.map((message) => {
                      const sender = message.userName || message.userEmail.split("@")[0] || "unknown";
                      return (
                        <div key={`pinned-${message.id}`} style={teamPinnedItem}>
                          <p style={teamPinnedText}>
                            <strong>{sender}:</strong> {getTeamMessagePreview(message.text)}
                          </p>
                          <button
                            type="button"
                            onClick={() => void toggleTeamMessagePinned(message)}
                            style={teamPinButton}
                            aria-label="Unpin message"
                          >
                            📌
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div ref={chatListRef} style={teamChatList}>
                {teamMessages.length > 0 ? (
                  teamMessages.map((message) => {
                    const sender = message.userName || message.userEmail.split("@")[0] || "unknown";
                    return (
                      <div key={message.id} style={teamChatMessageItem}>
                        <div style={teamChatMessageHeader}>
                          <p style={teamChatSenderLine}>
                            <strong>{sender}</strong> <span style={activityMetaText}>({message.userEmail})</span>
                          </p>
                          <button
                            type="button"
                            onClick={() => void toggleTeamMessagePinned(message)}
                            style={teamPinButton}
                            aria-label={message.pinned ? "Unpin message" : "Pin message"}
                            title={message.pinned ? "Unpin message" : "Pin message"}
                          >
                            {message.pinned ? "📌" : "📍"}
                          </button>
                        </div>
                        <p style={teamChatMessageText}>{message.text}</p>
                        <p style={activityMetaText}>{formatTeamMessageTime(message.createdAt)}</p>
                        <div style={teamReactionBar}>
                          {teamReactionOptions.map((emoji) => {
                            const count = getTeamReactionCount(message.reactionByUser, emoji);
                            const isSelectedByCurrentUser =
                              Boolean(user?.email) && message.reactionByUser[user.email || ""] === emoji;

                            return (
                              <button
                                key={`${message.id}-${emoji}`}
                                type="button"
                                onClick={() => void setTeamMessageReaction(message, emoji)}
                                style={{
                                  ...teamReactionButton,
                                  ...(isSelectedByCurrentUser ? teamReactionButtonActive : {}),
                                }}
                                aria-label={`React ${emoji}`}
                              >
                                <span>{emoji}</span>
                                <span>{count}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p style={{ margin: 0, color: "#9CA3AF" }}>No messages yet. Start the conversation.</p>
                )}
              </div>
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
                <p style={{ margin: 0, color: "#9CA3AF" }}>No recent activity yet.</p>
              )}
            </section>
          )}

      {teamChatToast ? (
        <button
          type="button"
          onClick={openTeamChatTab}
          style={teamToast}
        >
          <p style={teamToastTitle}>New Team Message</p>
          <p style={teamToastBody}>From: {teamChatToast.sender}</p>
          <p style={teamToastPreview}>{teamChatToast.preview}</p>
        </button>
      ) : null}
    </main>
  );
}

const page = {
  width: "100%",
  maxWidth: 1280,
  margin: "0 auto",
  padding: 16,
  boxSizing: "border-box" as const,
  fontFamily: "Arial, sans-serif",
  background: "#111827",
  color: "#F9FAFB",
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
  border: "1px solid #374151",
  borderRadius: 12,
  background: "#1F2937",
  boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
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
  border: "1px solid #374151",
  borderRadius: 12,
  background: "#1F2937",
  width: "fit-content",
  boxShadow: "0 6px 18px rgba(0, 0, 0, 0.22)",
};
const tabButton = {
  padding: "10px 14px",
  borderRadius: 8,
  border: "1px solid transparent",
  background: "transparent",
  color: "#9CA3AF",
  cursor: "pointer",
  fontWeight: 700,
};
const tabButtonActive = {
  background: "#374151",
  color: "#F9FAFB",
};
const statsGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 14,
};
const statCard = {
  background: "#1F2937",
  borderStyle: "solid",
  borderWidth: 1,
  borderColor: "#374151",
  borderRadius: 12,
  padding: 18,
  minHeight: 110,
  display: "grid",
  alignContent: "space-between",
  textAlign: "left" as const,
  cursor: "pointer",
  boxShadow: "0 6px 16px rgba(0, 0, 0, 0.2)",
};
const selectedStatCard = {
  borderWidth: 2,
  borderColor: "#0f766e",
  boxShadow: "0 10px 24px rgba(15, 118, 110, 0.2)",
  transform: "translateY(-1px)",
};
const statLabel = { margin: 0, color: "#9CA3AF", fontSize: 14, fontWeight: 600 };
const statNumber = {
  margin: "12px 0 0",
  fontSize: 42,
  lineHeight: 1,
  fontWeight: 700,
  color: "#F9FAFB",
};
const formSection = {
  border: "1px solid #374151",
  borderRadius: 12,
  padding: 16,
  background: "#1F2937",
  boxShadow: "0 8px 20px rgba(0, 0, 0, 0.22)",
};
const sectionTitle = {
  marginTop: 0,
  marginBottom: 14,
};
const formGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  columnGap: 12,
  rowGap: 12,
};
const input = {
  width: "100%",
  padding: 10,
  border: "1px solid #374151",
  borderRadius: 8,
  background: "#111827",
  color: "#F9FAFB",
  boxSizing: "border-box" as const,
};
const dateInputWrapper = {
  position: "relative" as const,
  width: "100%",
};
const dateInputField = {
  paddingRight: 42,
};
const datePickerButton = {
  position: "absolute" as const,
  right: 6,
  top: "50%",
  transform: "translateY(-50%)",
  border: "1px solid #4B5563",
  borderRadius: 6,
  background: "#1F2937",
  color: "#F9FAFB",
  width: 28,
  height: 28,
  display: "grid",
  placeItems: "center",
  cursor: "pointer",
  lineHeight: 1,
  padding: 0,
};
const notesInput = {
  gridColumn: "1 / -1",
  width: "100%",
  minHeight: 84,
  padding: 12,
  border: "1px solid #374151",
  borderRadius: 8,
  background: "#111827",
  color: "#F9FAFB",
  boxSizing: "border-box" as const,
  resize: "vertical" as const,
};
const primaryButton = {
  padding: "10px 14px",
  border: 0,
  borderRadius: 8,
  background: "#374151",
  color: "#F9FAFB",
  cursor: "pointer",
};
const addLeadButton = {
  ...primaryButton,
  gridColumn: "1 / -1",
  width: "100%",
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
  background: "#1F2937",
  border: "1px solid #374151",
  borderRadius: 12,
  padding: 14,
  minWidth: 0,
  minHeight: 280,
  display: "flex",
  flexDirection: "column" as const,
  gap: 10,
  boxShadow: "0 8px 20px rgba(0, 0, 0, 0.2)",
};
const columnTitle = { fontSize: 16, color: "#F9FAFB" };
const emptyColumnState = {
  minHeight: 180,
  display: "grid",
  placeItems: "center",
  border: "1px dashed #374151",
  borderRadius: 10,
  background: "#111827",
  padding: 16,
};

const emptyColumnText = {
  margin: 0,
  color: "#9CA3AF",
  fontSize: 14,
  textAlign: "center" as const,
};
const leadCard = {
  border: "1px solid #374151",
  borderRadius: 10,
  padding: 10,
  marginBottom: 8,
  background: "#111827",
  minWidth: 0,
  fontSize: 14,
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.2)",
};
const leadLine = {
  margin: "6px 0 0",
  lineHeight: 1.35,
  overflowWrap: "anywhere" as const,
};
const leadNotes = {
  margin: "8px 0 0",
  lineHeight: 1.35,
  color: "#F9FAFB",
  background: "#1F2937",
  border: "1px solid #374151",
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
  border: "1px solid #374151",
  borderRadius: 8,
  background: "#1F2937",
  color: "#F9FAFB",
  cursor: "pointer",
};

const exportButton = {
  padding: "10px 14px",
  border: "1px solid #374151",
  borderRadius: 8,
  background: "#1F2937",
  color: "#F9FAFB",
  cursor: "pointer",
};

const fieldLabel = {
  display: "grid",
  gap: 6,
  fontSize: 13,
  fontWeight: 700,
  color: "#9CA3AF",
};

const formRow = {
  display: "grid",
  gap: 12,
  gridColumn: "1 / -1",
};

const formActionsRow = {
  display: "grid",
  gap: 12,
  width: "100%",
  gridColumn: "1 / -1",
};

const authCard = {
  maxWidth: 420,
  margin: "80px auto",
  padding: 24,
  borderRadius: 12,
  border: "1px solid #374151",
  background: "#1F2937",
  boxShadow: "0 10px 26px rgba(0, 0, 0, 0.28)",
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
  color: "#9CA3AF",
};

const searchSection = {
  display: "grid",
  gap: 8,
  borderStyle: "solid",
  borderWidth: 1,
  borderColor: "#374151",
  borderRadius: 12,
  padding: 16,
  background: "#1F2937",
  position: "sticky" as const,
  top: 0,
  zIndex: 40,
};

const searchSectionScrolled = {
  borderColor: "#4b5563",
  boxShadow: "0 8px 20px rgba(0, 0, 0, 0.3)",
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
  border: "1px solid #374151",
  borderRadius: 10,
  background: "#111827",
  color: "#F9FAFB",
  boxSizing: "border-box" as const,
};

const clearSearchButton = {
  padding: "12px 14px",
  border: "1px solid #374151",
  borderRadius: 10,
  background: "#111827",
  color: "#F9FAFB",
  cursor: "pointer",
  fontWeight: 700,
};

const searchFeedbackText = {
  margin: 0,
  color: "#9CA3AF",
  fontSize: 13,
};

const noResultsState = {
  minHeight: 220,
  display: "grid",
  placeItems: "center",
  border: "1px dashed #374151",
  borderRadius: 12,
  background: "#1F2937",
  padding: 16,
  gridColumn: "1 / -1",
};

const noResultsText = {
  margin: 0,
  color: "#9CA3AF",
  fontSize: 14,
  textAlign: "center" as const,
};

const activitySection = {
  border: "1px solid #374151",
  borderRadius: 12,
  padding: 18,
  background: "#1F2937",
  boxShadow: "0 8px 20px rgba(0, 0, 0, 0.24)",
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
  borderColor: "#374151",
  borderRadius: 999,
  background: "#111827",
  color: "#F9FAFB",
  cursor: "pointer",
  fontWeight: 700,
};

const activityFilterButtonActive = {
  background: "#374151",
  borderColor: "#4b5563",
  color: "#F9FAFB",
};

const activityList = {
  display: "grid",
  gap: 10,
  gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
};

const activityItem = {
  border: "1px solid #374151",
  borderRadius: 10,
  padding: 12,
  background: "#111827",
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.2)",
};

const activityDayGroup = {
  display: "grid",
  gap: 8,
};

const activityDayTitle = {
  margin: "8px 0 0",
  fontSize: 14,
  color: "#9CA3AF",
  letterSpacing: 0.2,
  textTransform: "uppercase" as const,
};

const activityMetaText = {
  margin: "6px 0 0",
  color: "#9CA3AF",
  fontSize: 12,
};

const activityViewButton = {
  marginTop: 10,
  padding: "8px 10px",
  border: "1px solid #374151",
  borderRadius: 8,
  background: "#1F2937",
  color: "#F9FAFB",
  cursor: "pointer",
};

const teamChatList = {
  display: "grid",
  gap: 10,
  maxHeight: 420,
  overflowY: "auto" as const,
  paddingRight: 4,
};

const teamChatMessageItem = {
  border: "1px solid #374151",
  borderRadius: 10,
  padding: 12,
  background: "#111827",
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.2)",
};

const teamChatSenderLine = {
  margin: 0,
  color: "#F9FAFB",
};

const teamChatMessageHeader = {
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
  justifyContent: "space-between",
};

const teamChatMessageText = {
  margin: "8px 0 0",
  whiteSpace: "pre-wrap" as const,
  overflowWrap: "anywhere" as const,
  lineHeight: 1.4,
};

const teamPinButton = {
  border: "1px solid #374151",
  borderRadius: 8,
  background: "#1F2937",
  color: "#F9FAFB",
  cursor: "pointer",
  padding: "4px 8px",
  lineHeight: 1,
  fontSize: 13,
};

const teamPinnedSection = {
  border: "1px solid #374151",
  borderRadius: 10,
  padding: 10,
  marginBottom: 12,
  background: "#111827",
};

const teamPinnedTitle = {
  margin: 0,
  color: "#9CA3AF",
  fontSize: 12,
  textTransform: "uppercase" as const,
  letterSpacing: 0.4,
};

const teamPinnedList = {
  display: "grid",
  gap: 8,
  marginTop: 8,
};

const teamPinnedItem = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  justifyContent: "space-between",
  border: "1px solid #374151",
  borderRadius: 8,
  padding: "6px 8px",
  background: "#1F2937",
};

const teamPinnedText = {
  margin: 0,
  color: "#F9FAFB",
  fontSize: 13,
  overflowWrap: "anywhere" as const,
};

const teamReactionBar = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap" as const,
  marginTop: 8,
};

const teamReactionButton = {
  border: "1px solid #374151",
  borderRadius: 999,
  background: "#1F2937",
  color: "#F9FAFB",
  cursor: "pointer",
  padding: "4px 8px",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
};

const teamReactionButtonActive = {
  borderColor: "#4b5563",
  background: "#374151",
};

const teamToast = {
  position: "fixed" as const,
  right: 16,
  bottom: 16,
  width: "min(340px, calc(100% - 32px))",
  border: "1px solid #4b5563",
  borderRadius: 10,
  background: "#111827",
  color: "#F9FAFB",
  textAlign: "left" as const,
  padding: 12,
  boxShadow: "0 12px 30px rgba(0, 0, 0, 0.35)",
  cursor: "pointer",
  zIndex: 60,
};

const teamToastTitle = {
  margin: 0,
  fontWeight: 700,
};

const teamToastBody = {
  margin: "6px 0 0",
  color: "#9CA3AF",
  fontSize: 12,
};

const teamToastPreview = {
  margin: "6px 0 0",
  fontSize: 13,
  overflowWrap: "anywhere" as const,
};

const teamChatComposer = {
  display: "grid",
  gap: 10,
  marginTop: 14,
};

const teamChatInput = {
  width: "100%",
  minHeight: 90,
  padding: 12,
  border: "1px solid #374151",
  borderRadius: 10,
  background: "#111827",
  color: "#F9FAFB",
  boxSizing: "border-box" as const,
  resize: "vertical" as const,
};

const disabledButton = {
  opacity: 0.6,
  cursor: "not-allowed",
};

const mobileButton = {
  width: "100%",
  marginLeft: 0,
};
