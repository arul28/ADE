import React, { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

export function App() {
  const termHostRef = useRef<HTMLDivElement | null>(null);
  const term = useMemo(() => new Terminal({ cursorBlink: true }), []);
  const fitAddon = useMemo(() => new FitAddon(), []);
  const [ping, setPing] = useState<string>("(loading)");

  useEffect(() => {
    let cancelled = false;
    window.ade.ping().then((v) => {
      if (!cancelled) setPing(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!termHostRef.current) return;

    term.loadAddon(fitAddon);
    term.open(termHostRef.current);
    fitAddon.fit();
    term.writeln("ADE desktop scaffold");
    term.writeln(`ping: ${ping}`);

    const onResize = () => fitAddon.fit();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
    };
    // Intentionally not depending on `ping`: we just display it once in the terminal for now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr", height: "100vh" }}>
      <div style={{ padding: 12, borderBottom: "1px solid #222", fontFamily: "ui-sans-serif" }}>
        <strong>ADE</strong> (desktop scaffold) | preload ping: {ping}
      </div>
      <div ref={termHostRef} style={{ padding: 12 }} />
    </div>
  );
}

