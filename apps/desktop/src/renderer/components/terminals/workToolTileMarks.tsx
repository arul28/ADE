import { AppWindow, ChatsCircle, FolderOpen, Globe, Monitor, TerminalWindow } from "@phosphor-icons/react";
import { BrandMark, osBrandForPlatform } from "./workToolBrandMarks";
import type { CatalogCardId } from "./workToolCatalog";
import type { ToolMachine } from "./useToolMachines";

/**
 * A tile's mark. A tool that IS a brand shows that brand's real mark
 * (`workToolBrandMarks.tsx`: Apple, Android, Git, GitHub, Linear), Screen shows
 * the OS of the machine it runs on, and ADE's own tools (App Control,
 * Terminal, Browser, Files, Side chat) use the app's icon set, Phosphor,
 * rather than a made-up logo.
 */
export function WorkToolTileMark({
  card,
  machine,
  size,
}: {
  card: CatalogCardId;
  machine: ToolMachine | null;
  size: string;
}) {
  switch (card) {
    case "ios":
      return <BrandMark brand="apple" size={size} />;
    case "android":
      return <BrandMark brand="android" size={size} />;
    case "screen": {
      const os = osBrandForPlatform(machine?.platform);
      return os ? <BrandMark brand={os} size={size} /> : <Monitor size={size} weight="duotone" />;
    }
    case "app-control":
      return <AppWindow size={size} weight="duotone" />;
    case "terminal":
      return <TerminalWindow size={size} weight="duotone" />;
    case "browser":
      return <Globe size={size} weight="duotone" />;
    case "git":
      return <BrandMark brand="git" size={size} />;
    case "pr":
      return <BrandMark brand="github" size={size} />;
    case "issues":
      return <BrandMark brand="linear" size={size} />;
    case "files":
      return <FolderOpen size={size} weight="duotone" />;
    case "side-chat":
      return <ChatsCircle size={size} weight="duotone" />;
  }
}

/** A machine's OS mark at label size, in the text's colour. */
export function MachineOsMark({ machine, size = 11 }: { machine: Pick<ToolMachine, "platform">; size?: number }) {
  const os = osBrandForPlatform(machine.platform);
  return os ? <BrandMark brand={os} size={size} color="currentColor" /> : <Monitor size={size} weight="fill" />;
}
