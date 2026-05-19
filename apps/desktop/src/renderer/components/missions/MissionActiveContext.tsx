import React, { createContext, useContext } from "react";

const MissionActiveContext = createContext(true);

export function MissionActiveProvider({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <MissionActiveContext.Provider value={active}>
      {children}
    </MissionActiveContext.Provider>
  );
}

export function useMissionPageActive(): boolean {
  return useContext(MissionActiveContext);
}
