import React, { createContext, useContext, useEffect, useState } from "react";

const QUARTER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const DOT_FRAMES = [".  ", ".. ", "...", "   "] as const;

const SpinTickContext = createContext(0);

export function SpinTickProvider({ children }: { children: React.ReactNode }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 1000), 100);
    return () => clearInterval(id);
  }, []);

  return (
    <SpinTickContext.Provider value={tick}>
      {children}
    </SpinTickContext.Provider>
  );
}

export function useSpinFrame(): string {
  const tick = useContext(SpinTickContext);
  // Quarter-circle frames advance every ~300ms: tick / 3 over
  // QUARTER_FRAMES gives a full ~1200ms cycle.
  const index = Math.floor(tick / 3) % QUARTER_FRAMES.length;
  return QUARTER_FRAMES[index]!;
}

export function useBrailleSpin(): string {
  const tick = useContext(SpinTickContext);
  // Braille cycle ticks every ~100ms — one frame per base tick.
  const index = tick % BRAILLE_FRAMES.length;
  return BRAILLE_FRAMES[index]!;
}

export function useDotPulse(): string {
  const tick = useContext(SpinTickContext);
  // Dot pulse advances every ~300ms, giving the familiar "working..."
  // affordance without stealing attention from the transcript.
  const index = Math.floor(tick / 3) % DOT_FRAMES.length;
  return DOT_FRAMES[index]!;
}
