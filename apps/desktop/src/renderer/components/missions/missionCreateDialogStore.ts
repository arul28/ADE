import { create } from "zustand";

type MissionCreateDialogStore = {
  open: boolean;
  resetVersion: number;
  openDialog: () => void;
  closeDialog: () => void;
  resetDialog: () => void;
};

export const useMissionCreateDialogStore = create<MissionCreateDialogStore>((set) => ({
  open: false,
  resetVersion: 0,
  openDialog: () => set({ open: true }),
  closeDialog: () => set({ open: false }),
  resetDialog: () => set((state) => ({ open: false, resetVersion: state.resetVersion + 1 })),
}));

export function openMissionCreateDialog(): void {
  useMissionCreateDialogStore.getState().openDialog();
}

export function closeMissionCreateDialog(): void {
  useMissionCreateDialogStore.getState().closeDialog();
}

export function resetMissionCreateDialog(): void {
  useMissionCreateDialogStore.getState().resetDialog();
}
