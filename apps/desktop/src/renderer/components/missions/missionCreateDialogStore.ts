import { create } from "zustand";

type MissionCreateDialogStore = {
  open: boolean;
  resetVersion: number;
};

export const useMissionCreateDialogStore = create<MissionCreateDialogStore>(() => ({
  open: false,
  resetVersion: 0,
}));

export function openMissionCreateDialog(): void {
  useMissionCreateDialogStore.setState({ open: true });
}

export function closeMissionCreateDialog(): void {
  useMissionCreateDialogStore.setState({ open: false });
}

export function resetMissionCreateDialog(): void {
  useMissionCreateDialogStore.setState((state) => ({ open: false, resetVersion: state.resetVersion + 1 }));
}
