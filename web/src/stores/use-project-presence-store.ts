import { create } from "zustand";

import type { ServerProjectPresence } from "@/services/api/server";

export type ProjectRealtimeStatus = "idle" | "connecting" | "ready" | "reconnecting" | "failed";
type ProjectPresenceState = {
    projectId: string;
    clientId: string;
    status: ProjectRealtimeStatus;
    members: ServerProjectPresence[];
    bind: (projectId: string, clientId: string) => void;
    setStatus: (status: ProjectRealtimeStatus) => void;
    setMembers: (members: ServerProjectPresence[]) => void;
    clear: () => void;
};

export const useProjectPresenceStore = create<ProjectPresenceState>((set) => ({
    projectId: "",
    clientId: "",
    status: "idle",
    members: [],
    bind: (projectId, clientId) => set({ projectId, clientId, status: "connecting", members: [] }),
    setStatus: (status) => set({ status }),
    setMembers: (members) => set({ members }),
    clear: () => set({ projectId: "", clientId: "", status: "idle", members: [] }),
}));
