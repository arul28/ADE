import React from "react";
import { Box, Text, type DOMElement } from "ink";
import { theme } from "../../theme";
import type { SetupPaneRow, SetupPaneRowKind } from "../../types";
import { useHoveredHitId } from "../../hitTestRegistry";
import { KeyHints } from "../designKit";
import type { ModelPickerAuthStatus, ModelPickerEntry, ModelPickerRailEntry, ModelPickerState } from "./types";
import { normalizeProviderToken, providerFamilyLabel, titleCaseProviderName } from "../../providerMetadata";
// The model list is a FIXED-height window so a long catalog (e.g. OpenCode's
// dozens of providers) scrolls inside its own region instead of shoving the
// settings footer around. Settings stay stickied below. Geometry constants +
// the windowing function live in modelPickerGeometry so the click hit-test in
// app.tsx computes identical rects from a SINGLE source.
import {
  headerLineCount,
  hasSubProviderSelector,
  isSearching,
  modelEntryHeightForState,
  modelListRowsForState,
  providerTabSegments,
  RAIL_WIDTH,
  RAIL_TO_LIST_GAP,
  rowWindow,
  usesCompactProviderRows,
} from "./modelPickerGeometry";

function endTruncate(value: string, max: number): string {
  if (max <= 1) return value.length ? "…" : "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

// Amber pip for a provider that needs sign-in; nothing for a ready provider
// (green would read as idle chrome).
function authPip(status: ModelPickerAuthStatus): { glyph: string; color: string } | null {
  if (status === "unavailable") return { glyph: "!", color: theme.color.danger };
  return null;
}

function titleCaseProvider(value: string): string {
  return PROVIDER_MARKS[normalizeProviderToken(value)]?.label ?? titleCaseProviderName(value);
}

function providerLabelFor(entry: Pick<ModelPickerEntry, "family" | "subProvider">): string {
  if (entry.subProvider?.trim()) return titleCaseProvider(entry.subProvider);
  return providerFamilyLabel(entry.family);
}

type ProviderMark = {
  label: string;
  short: string;
  terminal?: string;
  color: string;
  iconFill?: string;
  svgPath?: string;
  svgPaths?: Array<{ d: string; fill: string }>;
  viewBox?: string;
  svg?: string;
};

// Path data is sourced from the same brand mark set the desktop picker uses
// (@lobehub/icons), with ADE's local Droid SVG embedded below for terminals
// that can render inline images.
const OPENAI_PATH = "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z";
const ANTHROPIC_PATH = "M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z";
const CLAUDE_PATH = "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z";
const CODEX_PATH = "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z";
const GEMINI_PATH = "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z";
const OPENCODE_PATH = "M16 6H8v12h8V6zm4 16H4V2h16v20z";
const GOOGLE_PATHS = [
  "M23 12.245c0-.905-.075-1.565-.236-2.25h-10.54v4.083h6.186c-.124 1.014-.797 2.542-2.294 3.569l-.021.136 3.332 2.53.23.022C21.779 18.417 23 15.593 23 12.245z",
  "M12.225 23c3.03 0 5.574-.978 7.433-2.665l-3.542-2.688c-.948.648-2.22 1.1-3.891 1.1a6.745 6.745 0 01-6.386-4.572l-.132.011-3.465 2.628-.045.124C4.043 20.531 7.835 23 12.225 23z",
  "M5.84 14.175A6.65 6.65 0 015.463 12c0-.758.138-1.491.361-2.175l-.006-.147-3.508-2.67-.115.054A10.831 10.831 0 001 12c0 1.772.436 3.447 1.197 4.938l3.642-2.763z",
  "M12.225 5.253c2.108 0 3.529.892 4.34 1.638l3.167-3.031C17.787 2.088 15.255 1 12.225 1 7.834 1 4.043 3.469 2.197 7.062l3.63 2.763a6.77 6.77 0 016.398-4.572z",
];
const GOOGLE_FILLS = ["#4285F4", "#34A853", "#FBBC05", "#EB4335"];
const MISTRAL_PATHS = [
  { d: "M3.428 3.4h3.429v3.428H3.428V3.4zm13.714 0h3.43v3.428h-3.43V3.4z", fill: "gold" },
  { d: "M3.428 6.828h6.857v3.429H3.429V6.828zm10.286 0h6.857v3.429h-6.857V6.828z", fill: "#FFAF00" },
  { d: "M3.428 10.258h17.144v3.428H3.428v-3.428z", fill: "#FF8205" },
  { d: "M3.428 13.686h3.429v3.428H3.428v-3.428zm6.858 0h3.429v3.428h-3.429v-3.428zm6.856 0h3.43v3.428h-3.43v-3.428z", fill: "#FA500F" },
  { d: "M0 17.114h10.286v3.429H0v-3.429zm13.714 0H24v3.429H13.714v-3.429z", fill: "#E10500" },
];
const DEEPSEEK_PATH = "M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z";
const XAI_PATH = "M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z";
const GROQ_PATH = "M12.036 2c-3.853-.035-7 3-7.036 6.781-.035 3.782 3.055 6.872 6.908 6.907h2.42v-2.566h-2.292c-2.407.028-4.38-1.866-4.408-4.23-.029-2.362 1.901-4.298 4.308-4.326h.1c2.407 0 4.358 1.915 4.365 4.278v6.305c0 2.342-1.944 4.25-4.323 4.279a4.375 4.375 0 01-3.033-1.252l-1.851 1.818A7 7 0 0012.029 22h.092c3.803-.056 6.858-3.083 6.879-6.816v-6.5C18.907 4.963 15.817 2 12.036 2z";
const OPENROUTER_PATH = "M16.804 1.957l7.22 4.105v.087L16.73 10.21l.017-2.117-.821-.03c-1.059-.028-1.611.002-2.268.11-1.064.175-2.038.577-3.147 1.352L8.345 11.03c-.284.195-.495.336-.68.455l-.515.322-.397.234.385.23.53.338c.476.314 1.17.796 2.701 1.866 1.11.775 2.083 1.177 3.147 1.352l.3.045c.694.091 1.375.094 2.825.033l.022-2.159 7.22 4.105v.087L16.589 22l.014-1.862-.635.022c-1.386.042-2.137.002-3.138-.162-1.694-.28-3.26-.926-4.881-2.059l-2.158-1.5a21.997 21.997 0 00-.755-.498l-.467-.28a55.927 55.927 0 00-.76-.43C2.908 14.73.563 14.116 0 14.116V9.888l.14.004c.564-.007 2.91-.622 3.809-1.124l1.016-.58.438-.274c.428-.28 1.072-.726 2.686-1.853 1.621-1.133 3.186-1.78 4.881-2.059 1.152-.19 1.974-.213 3.814-.138l.02-1.907z";
const KIMI_PATHS = [
  { d: "M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z", fill: "#FFFFFF" },
  { d: "M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z", fill: "#FFFFFF" },
];
const OLLAMA_PATH = "M7.905 1.09c.216.085.411.225.588.41.295.306.544.744.734 1.263.191.522.315 1.1.362 1.68a5.054 5.054 0 012.049-.636l.051-.004c.87-.07 1.73.087 2.48.474.101.053.2.11.297.17.05-.569.172-1.134.36-1.644.19-.52.439-.957.733-1.264a1.67 1.67 0 01.589-.41c.257-.1.53-.118.796-.042.401.114.745.368 1.016.737.248.337.434.769.561 1.287.23.934.27 2.163.115 3.645l.053.04.026.019c.757.576 1.284 1.397 1.563 2.35.435 1.487.216 3.155-.534 4.088l-.018.021.002.003c.417.762.67 1.567.724 2.4l.002.03c.064 1.065-.2 2.137-.814 3.19l-.007.01.01.024c.472 1.157.62 2.322.438 3.486l-.006.039a.651.651 0 01-.747.536.648.648 0 01-.54-.742c.167-1.033.01-2.069-.48-3.123a.643.643 0 01.04-.617l.004-.006c.604-.924.854-1.83.8-2.72-.046-.779-.325-1.544-.8-2.273a.644.644 0 01.18-.886l.009-.006c.243-.159.467-.565.58-1.12a4.229 4.229 0 00-.095-1.974c-.205-.7-.58-1.284-1.105-1.683-.595-.454-1.383-.673-2.38-.61a.653.653 0 01-.632-.371c-.314-.665-.772-1.141-1.343-1.436a3.288 3.288 0 00-1.772-.332c-1.245.099-2.343.801-2.67 1.686a.652.652 0 01-.61.425c-1.067.002-1.893.252-2.497.703-.522.39-.878.935-1.066 1.588a4.07 4.07 0 00-.068 1.886c.112.558.331 1.02.582 1.269l.008.007c.212.207.257.53.109.785-.36.622-.629 1.549-.673 2.44-.05 1.018.186 1.902.719 2.536l.016.019a.643.643 0 01.095.69c-.576 1.236-.753 2.252-.562 3.052a.652.652 0 01-1.269.298c-.243-1.018-.078-2.184.473-3.498l.014-.035-.008-.012a4.339 4.339 0 01-.598-1.309l-.005-.019a5.764 5.764 0 01-.177-1.785c.044-.91.278-1.842.622-2.59l.012-.026-.002-.002c-.293-.418-.51-.953-.63-1.545l-.005-.024a5.352 5.352 0 01.093-2.49c.262-.915.777-1.701 1.536-2.269.06-.045.123-.09.186-.132-.159-1.493-.119-2.73.112-3.67.127-.518.314-.95.562-1.287.27-.368.614-.622 1.015-.737.266-.076.54-.059.797.042zm4.116 9.09c.936 0 1.8.313 2.446.855.63.527 1.005 1.235 1.005 1.94 0 .888-.406 1.58-1.133 2.022-.62.375-1.451.557-2.403.557-1.009 0-1.871-.259-2.493-.734-.617-.47-.963-1.13-.963-1.845 0-.707.398-1.417 1.056-1.946.668-.537 1.55-.849 2.485-.849zm0 .896a3.07 3.07 0 00-1.916.65c-.461.37-.722.835-.722 1.25 0 .428.21.829.61 1.134.455.347 1.124.548 1.943.548.799 0 1.473-.147 1.932-.426.463-.28.7-.686.7-1.257 0-.423-.246-.89-.683-1.256-.484-.405-1.14-.643-1.864-.643zm.662 1.21l.004.004c.12.151.095.37-.056.49l-.292.23v.446a.375.375 0 01-.376.373.375.375 0 01-.376-.373v-.46l-.271-.218a.347.347 0 01-.052-.49.353.353 0 01.494-.051l.215.172.22-.174a.353.353 0 01.49.051zm-5.04-1.919c.478 0 .867.39.867.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zm8.706 0c.48 0 .868.39.868.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zM7.44 2.3l-.003.002a.659.659 0 00-.285.238l-.005.006c-.138.189-.258.467-.348.832-.17.692-.216 1.631-.124 2.782.43-.128.899-.208 1.404-.237l.01-.001.019-.034c.046-.082.095-.161.148-.239.123-.771.022-1.692-.253-2.444-.134-.364-.297-.65-.453-.813a.628.628 0 00-.107-.09L7.44 2.3zm9.174.04l-.002.001a.628.628 0 00-.107.09c-.156.163-.32.45-.453.814-.29.794-.387 1.776-.23 2.572l.058.097.008.014h.03a5.184 5.184 0 011.466.212c.086-1.124.038-2.043-.128-2.722-.09-.365-.21-.643-.349-.832l-.004-.006a.659.659 0 00-.285-.239h-.004z";
const LMSTUDIO_PATHS = [
  { d: "M2.84 2a1.273 1.273 0 100 2.547h14.107a1.273 1.273 0 100-2.547H2.84zM7.935 5.33a1.273 1.273 0 000 2.548H22.04a1.274 1.274 0 000-2.547H7.935zM3.624 9.935c0-.704.57-1.274 1.274-1.274h14.106a1.274 1.274 0 010 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM1.273 12.188a1.273 1.273 0 100 2.547H15.38a1.274 1.274 0 000-2.547H1.273zM3.624 16.792c0-.704.57-1.274 1.274-1.274h14.106a1.273 1.273 0 110 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM13.029 18.849a1.273 1.273 0 100 2.547h9.698a1.273 1.273 0 100-2.547h-9.698z", fill: "rgba(255,255,255,.3)" },
  { d: "M2.84 2a1.273 1.273 0 100 2.547h10.287a1.274 1.274 0 000-2.547H2.84zM7.935 5.33a1.273 1.273 0 000 2.548H18.22a1.274 1.274 0 000-2.547H7.935zM3.624 9.935c0-.704.57-1.274 1.274-1.274h10.286a1.273 1.273 0 010 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM1.273 12.188a1.273 1.273 0 100 2.547H11.56a1.274 1.274 0 000-2.547H1.273zM3.624 16.792c0-.704.57-1.274 1.274-1.274h10.286a1.273 1.273 0 110 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM13.029 18.849a1.273 1.273 0 100 2.547h5.78a1.273 1.273 0 100-2.547h-5.78z", fill: "#FFFFFF" },
];
const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#000"/><path fill="#fff" d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"/></svg>`;
const DROID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 508 508"><circle cx="254" cy="254" r="254" fill="#020202"/><path d="M321.997 150.712C321.401 150.568 320.844 150.299 320.363 149.925C319.883 149.551 319.491 149.08 319.215 148.544C318.938 148.008 318.783 147.42 318.76 146.821C318.738 146.22 318.848 145.624 319.084 145.07C327.226 125.716 330.819 110.23 325.021 103.747C309.666 86.5471 248.085 120.749 228.451 132.333C227.925 132.642 227.337 132.837 226.728 132.903C226.118 132.969 225.501 132.906 224.918 132.719C224.336 132.531 223.801 132.223 223.351 131.815C222.902 131.407 222.548 130.909 222.313 130.356C214.06 111.043 205.384 97.6094 196.589 97.0268C173.279 95.4688 154.491 162.187 148.991 183.932C148.844 184.515 148.57 185.06 148.188 185.528C147.805 185.998 147.323 186.381 146.775 186.651C146.227 186.921 145.626 187.072 145.012 187.094C144.399 187.116 143.788 187.009 143.221 186.778C123.406 178.825 107.545 175.316 100.914 180.98C83.305 195.978 118.315 256.126 130.175 275.304C130.492 275.816 130.692 276.391 130.76 276.987C130.829 277.582 130.765 278.186 130.573 278.755C130.381 279.325 130.065 279.847 129.647 280.286C129.228 280.725 128.718 281.07 128.15 281.298C108.384 289.359 94.6306 297.834 94.0272 306.424C92.439 329.192 160.74 347.544 183.01 352.916C183.605 353.061 184.16 353.33 184.64 353.704C185.118 354.077 185.509 354.548 185.785 355.083C186.061 355.618 186.215 356.205 186.237 356.803C186.26 357.402 186.151 357.998 185.916 358.551C177.773 377.905 174.181 393.398 179.979 399.874C195.334 417.074 256.921 382.877 276.556 371.293C277.081 370.984 277.67 370.789 278.28 370.722C278.889 370.655 279.507 370.717 280.09 370.905C280.673 371.093 281.207 371.402 281.657 371.81C282.106 372.219 282.46 372.717 282.694 373.271C290.947 392.578 299.616 406.012 308.417 406.601C331.728 408.153 350.516 341.44 356.009 319.688C356.157 319.106 356.432 318.562 356.816 318.094C357.2 317.625 357.682 317.243 358.231 316.974C358.779 316.705 359.381 316.554 359.995 316.533C360.608 316.511 361.219 316.619 361.786 316.85C381.601 324.803 397.455 328.304 404.093 322.648C421.702 307.65 386.684 247.495 374.825 228.317C374.51 227.804 374.312 227.229 374.245 226.634C374.177 226.039 374.242 225.436 374.434 224.868C374.626 224.299 374.941 223.777 375.358 223.338C375.775 222.899 376.284 222.552 376.85 222.323C396.623 214.261 410.376 205.786 410.973 197.196C412.568 174.428 344.26 156.078 321.997 150.712ZM295.254 128.885C299.734 136.73 276.646 189 259.474 225.561C259.186 226.172 258.715 226.682 258.121 227.024C257.528 227.365 256.842 227.521 256.155 227.47C255.468 227.419 254.814 227.164 254.28 226.739C253.746 226.314 253.358 225.739 253.169 225.093C246.234 201.322 238.306 173.392 229.824 149.683C229.491 148.752 229.508 147.736 229.871 146.817C230.235 145.897 230.921 145.133 231.808 144.662C252.989 133.363 289.234 118.358 295.254 128.885ZM193.746 135.355C202.589 137.807 224.103 190.714 238.424 228.426C238.664 229.056 238.699 229.742 238.527 230.393C238.354 231.044 237.983 231.627 237.461 232.065C236.939 232.503 236.292 232.775 235.608 232.844C234.923 232.913 234.234 232.775 233.632 232.45C211.501 220.453 185.694 206.159 162.529 195.253C161.622 194.823 160.901 194.093 160.493 193.192C160.085 192.292 160.018 191.279 160.303 190.335C167.12 167.736 181.865 132.069 193.746 135.355ZM126.652 210.04C134.676 205.664 188.197 228.216 225.621 244.989C226.248 245.269 226.771 245.73 227.12 246.31C227.47 246.889 227.629 247.56 227.577 248.23C227.524 248.901 227.264 249.54 226.828 250.062C226.393 250.582 225.805 250.962 225.143 251.147C200.813 257.921 172.211 265.664 147.937 273.949C146.985 274.272 145.946 274.255 145.007 273.9C144.067 273.545 143.286 272.876 142.805 272.011C131.257 251.322 115.867 215.92 126.652 210.04ZM133.275 309.188C135.779 300.551 189.952 279.537 228.562 265.548C229.207 265.315 229.91 265.28 230.576 265.448C231.243 265.617 231.84 265.98 232.288 266.49C232.736 266.999 233.015 267.631 233.085 268.299C233.155 268.968 233.015 269.641 232.682 270.23C220.392 291.846 205.758 317.053 194.592 339.672C194.156 340.561 193.409 341.269 192.486 341.668C191.563 342.068 190.525 342.134 189.557 341.853C166.42 335.235 129.905 320.792 133.275 309.188ZM209.739 374.722C205.252 366.884 228.347 314.608 245.519 278.054C245.806 277.442 246.279 276.931 246.872 276.59C247.465 276.249 248.151 276.093 248.838 276.144C249.525 276.194 250.179 276.45 250.713 276.875C251.247 277.3 251.634 277.874 251.824 278.521C258.759 302.285 266.686 330.222 275.169 353.932C275.499 354.862 275.481 355.877 275.117 356.795C274.752 357.713 274.064 358.475 273.178 358.945C252.004 370.223 215.752 385.256 209.76 374.722H209.739ZM311.247 368.252C302.397 365.807 280.883 312.894 266.562 275.182C266.322 274.55 266.285 273.862 266.458 273.21C266.63 272.559 267.003 271.974 267.526 271.536C268.049 271.097 268.697 270.826 269.382 270.758C270.068 270.69 270.759 270.83 271.361 271.157C293.485 283.154 319.299 297.455 342.457 308.362C343.366 308.789 344.089 309.519 344.497 310.42C344.905 311.321 344.971 312.335 344.683 313.28C337.872 335.912 323.128 371.544 311.247 368.252ZM378.341 293.566C370.31 297.949 316.795 275.391 279.365 258.618C278.738 258.338 278.215 257.877 277.866 257.297C277.516 256.718 277.357 256.047 277.409 255.377C277.461 254.706 277.722 254.067 278.158 253.546C278.593 253.025 279.181 252.646 279.843 252.461C304.18 245.687 332.775 237.943 357.049 229.658C358.003 229.335 359.043 229.353 359.984 229.709C360.925 230.065 361.706 230.737 362.188 231.603C373.729 252.285 389.119 287.693 378.341 293.566ZM371.718 194.419C369.207 203.063 315.041 224.077 276.431 238.066C275.784 238.3 275.08 238.335 274.413 238.167C273.746 237.999 273.148 237.635 272.698 237.124C272.249 236.613 271.972 235.98 271.903 235.31C271.833 234.641 271.975 233.966 272.311 233.377C284.594 211.768 299.228 186.554 310.394 163.935C310.833 163.048 311.58 162.343 312.502 161.945C313.425 161.546 314.462 161.481 315.429 161.76C338.566 168.413 375.081 182.815 371.718 194.419Z" fill="#FAFAFA"/></svg>';

const PROVIDER_MARKS: Record<string, ProviderMark> = {
  anthropic: { label: "Anthropic", short: "AI", terminal: "AI", color: "#F1F0E8", iconFill: "#141413", svgPath: ANTHROPIC_PATH },
  claude: { label: "Anthropic", short: "AI", terminal: "AI", color: "#F1F0E8", iconFill: "#141413", svgPath: ANTHROPIC_PATH },
  openai: { label: "OpenAI", short: "OA", terminal: "◎", color: "#F0F0F2", iconFill: "#050505", svgPath: OPENAI_PATH },
  codex: { label: "OpenAI", short: "OA", terminal: "◎", color: "#F0F0F2", iconFill: "#050505", svgPath: OPENAI_PATH },
  google: { label: "Google", short: "G", terminal: "G", color: "#4285F4", svgPaths: GOOGLE_PATHS.map((d, index) => ({ d, fill: GOOGLE_FILLS[index] ?? "#FFFFFF" })) },
  gemini: { label: "Google", short: "G", terminal: "✦", color: "#3186FF", svgPath: GEMINI_PATH, iconFill: "#3186FF" },
  deepseek: { label: "DeepSeek", short: "DS", terminal: "∿", color: "#4D6BFE", svgPath: DEEPSEEK_PATH },
  mistral: { label: "Mistral", short: "MI", terminal: "▥", color: "#FF8205", svgPaths: MISTRAL_PATHS },
  xai: { label: "xAI", short: "xA", terminal: "X", color: "#F0F0F2", iconFill: "#000000", svgPath: XAI_PATH },
  grok: { label: "xAI", short: "xA", terminal: "X", color: "#F0F0F2", iconFill: "#000000", svgPath: XAI_PATH },
  groq: { label: "Groq", short: "GQ", terminal: "Gq", color: "#F55036", svgPath: GROQ_PATH },
  together: { label: "Together", short: "TG", terminal: "T", color: "#22C55E" },
  openrouter: { label: "OpenRouter", short: "OR", terminal: "⇄", color: "#6566F1", svgPath: OPENROUTER_PATH },
  opencode: { label: "OpenCode", short: "OC", terminal: "▣", color: "#F0F0F2", svgPath: OPENCODE_PATH },
  droid: { label: "Droid", short: "DR", terminal: "✺", color: "#06B6D4", svg: DROID_SVG },
  factory: { label: "Droid", short: "DR", terminal: "✺", color: "#06B6D4", svg: DROID_SVG },
  cursor: { label: "Cursor", short: "CU", terminal: "⬢", color: "#0EA5E9", svg: CURSOR_SVG },
  kimi: { label: "Kimi", short: "Ki", terminal: "Ki", color: "#F0F0F2", svgPaths: KIMI_PATHS },
  moonshot: { label: "Kimi", short: "Ki", terminal: "Ki", color: "#F0F0F2", svgPaths: KIMI_PATHS },
  moonshotai: { label: "Kimi", short: "Ki", terminal: "Ki", color: "#F0F0F2", svgPaths: KIMI_PATHS },
  kimiforcoding: { label: "Kimi", short: "Ki", terminal: "Ki", color: "#F0F0F2", svgPaths: KIMI_PATHS },
  ollama: { label: "Ollama", short: "OL", terminal: "◕", color: "#F0F0F2", iconFill: "#000000", svgPath: OLLAMA_PATH },
  lmstudio: { label: "LM Studio", short: "LM", terminal: "≋", color: "#8B5CF6", svgPaths: LMSTUDIO_PATHS },
};

const ROW_MARKS: Record<string, ProviderMark> = {
  claude: { label: "Claude", short: "Cl", terminal: "✻", color: "#D97757", svgPath: CLAUDE_PATH },
  anthropic: { label: "Claude", short: "Cl", terminal: "✻", color: "#D97757", svgPath: CLAUDE_PATH },
  codex: { label: "Codex", short: "Cx", terminal: "✦", color: "#A78BFA", svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#fff"/><path fill="url(#codex-gradient)" d="${CODEX_PATH}"/><defs><linearGradient id="codex-gradient" x1="12" x2="12" y1="0" y2="24" gradientUnits="userSpaceOnUse"><stop stop-color="#B1A7FF"/><stop offset=".5" stop-color="#7A9DFF"/><stop offset="1" stop-color="#3941FF"/></linearGradient></defs></svg>` },
  openai: { label: "OpenAI", short: "OA", color: "#050505", svgPath: OPENAI_PATH },
  google: { label: "Gemini", short: "Ge", color: "#FFFFFF", svgPath: GEMINI_PATH, iconFill: "#3186FF" },
  gemini: { label: "Gemini", short: "Ge", color: "#FFFFFF", svgPath: GEMINI_PATH, iconFill: "#3186FF" },
  deepseek: PROVIDER_MARKS.deepseek!,
  mistral: PROVIDER_MARKS.mistral!,
  xai: PROVIDER_MARKS.xai!,
  grok: PROVIDER_MARKS.grok!,
  groq: PROVIDER_MARKS.groq!,
  kimi: PROVIDER_MARKS.kimi!,
  moonshot: PROVIDER_MARKS.moonshot!,
  moonshotai: PROVIDER_MARKS.moonshotai!,
  kimiforcoding: PROVIDER_MARKS.kimiforcoding!,
  openrouter: PROVIDER_MARKS.openrouter!,
  opencode: PROVIDER_MARKS.opencode!,
  droid: PROVIDER_MARKS.droid!,
  factory: PROVIDER_MARKS.factory!,
  cursor: PROVIDER_MARKS.cursor!,
  ollama: PROVIDER_MARKS.ollama!,
  lmstudio: PROVIDER_MARKS.lmstudio!,
};

function markSvg(mark: ProviderMark): string | null {
  if (mark.svg) return mark.svg;
  if (mark.svgPaths) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.viewBox ?? "0 0 24 24"}"><rect width="24" height="24" rx="6" fill="${mark.color}"/>${mark.svgPaths.map((path) => `<path fill="${path.fill}" d="${path.d}"/>`).join("")}</svg>`;
  }
  if (!mark.svgPath) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.viewBox ?? "0 0 24 24"}"><rect width="24" height="24" rx="6" fill="${mark.color}"/><path fill="${mark.iconFill ?? "#fff"}" d="${mark.svgPath}"/></svg>`;
}

function supportsInlineLogoImages(): boolean {
  if (process.env.ADE_TUI_INLINE_LOGOS === "0") return false;
  if (process.env.ADE_TUI_INLINE_LOGOS === "1") return true;
  const termProgram = (process.env.TERM_PROGRAM ?? "").toLowerCase();
  return termProgram.includes("iterm") || termProgram.includes("wezterm");
}

function inlineLogoEscape(mark: ProviderMark): string | null {
  if (!supportsInlineLogoImages()) return null;
  const svg = markSvg(mark);
  if (!svg) return null;
  const encoded = Buffer.from(svg).toString("base64");
  return `\u001b]1337;File=inline=1;width=2;height=1;preserveAspectRatio=1;type=image/svg+xml:${encoded}\u0007`;
}

function drawInlineLogo(mark: ProviderMark, x: number, y: number): void {
  if (!process.stdout.isTTY) return;
  const image = inlineLogoEscape(mark);
  if (!image) return;
  process.stdout.write(`\u001b7\u001b[${Math.max(1, Math.round(y))};${Math.max(1, Math.round(x))}H${image}\u001b8`);
}

function markForProvider(provider: string | null | undefined): ProviderMark {
  const normalized = normalizeProviderToken(provider);
  return PROVIDER_MARKS[normalized] ?? {
    label: titleCaseProvider(provider ?? "Provider") || "Provider",
    short: endTruncate((provider ?? "?").trim().toUpperCase(), 2),
    color: theme.color.t3,
  };
}

function markForEntry(entry: ModelPickerEntry): ProviderMark {
  const keyMark = ROW_MARKS[normalizeProviderToken(entry.subProviderKey)];
  if (keyMark) return keyMark;
  const labelMark = ROW_MARKS[normalizeProviderToken(entry.subProvider)];
  if (labelMark) return labelMark;
  return ROW_MARKS[normalizeProviderToken(entry.family)] ?? markForProvider(entry.family);
}

function LogoCell({ mark, dim = false }: { mark: ProviderMark; dim?: boolean }) {
  const glyph = endTruncate((mark.terminal ?? mark.short).padEnd(2), 2);
  return (
    <Text color={dim ? theme.color.t5 : mark.color} dimColor={dim}>
      {glyph}
    </Text>
  );
}

function RailLogoSlot({ mark, dim = false }: { mark: ProviderMark; dim?: boolean }) {
  return <LogoCell mark={mark} dim={dim} />;
}

function settingIcon(kind: SetupPaneRowKind): string {
  switch (kind) {
    case "interface": return "⇄";
    case "import-session": return "⇩";
    case "reasoning": return "✦";
    case "permission": return "◆";
    case "codex-fast": return "↯";
    case "output-style": return "✎";
    case "refresh-status": return "↻";
    default: return "·";
  }
}

// ── Vertical icon rail (categories / provider families) ──────────────────────

function VerticalRail({
  entries,
  selectedIndex,
  hoveredId,
  focused,
}: {
  entries: ModelPickerRailEntry[];
  selectedIndex: number;
  hoveredId: string | null;
  focused: boolean;
}) {
  return (
    <Box flexDirection="column" width={RAIL_WIDTH} flexShrink={0}>
      {entries.map((entry, index) => {
        const selected = index === selectedIndex;
        const hovered = hoveredId === `right:model-picker:rail:${index}`;
        // The selected category stays violet even when focus moves to the model
        // list; the small arrow appears only while the rail column owns focus.
        const showCursor = selected && focused;
        const pip = entry.kind === "provider" ? authPip(entry.authStatus) : null;
        const label = entry.kind === "provider"
          ? providerFamilyLabel(entry.provider)
          : entry.kind === "favorites"
            ? "Favs"
            : "Recents";
        const labelWidth = RAIL_WIDTH - 5;
        const color = selected || hovered ? theme.color.violet : theme.color.t3;
        const mark = entry.kind === "provider" ? markForProvider(entry.provider) : null;
        const labelText = endTruncate(label, Math.max(3, labelWidth)).padEnd(labelWidth);
        return (
          <Box key={`${entry.kind}:${entry.kind === "provider" ? entry.provider : entry.label}`} flexDirection="row">
            <Text color={showCursor ? theme.color.violet : theme.color.t5}>{showCursor ? "›" : " "}</Text>
            {mark ? (
              <RailLogoSlot mark={mark} dim={entry.kind === "provider" && entry.authStatus === "unavailable"} />
            ) : (
              <Text color={entry.kind === "favorites" ? theme.color.warning : theme.color.t3}>
                {entry.kind === "favorites" ? "★ " : "◷ "}
              </Text>
            )}
            <Text>{" "}</Text>
            <Text color={color} bold={showCursor} wrap="truncate-end">{labelText}</Text>
            {pip ? <Text color={pip.color}>{pip.glyph}</Text> : <Text>{" "}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}

// ── Compact sub-provider tab strip ───────────────────────────────────────────
// Terminal-width version of the desktop tab bar. It keeps the group names
// visible instead of reducing them to "3/136" bookkeeping.
function SubProviderTabs({
  tabs,
  selectedIndex,
  width,
}: {
  tabs: { key: string; label: string }[];
  selectedIndex: number;
  width: number;
}) {
  const hoveredId = useHoveredHitId();
  if (tabs.length <= 1) return null;
  const safe = Math.max(0, Math.min(selectedIndex, tabs.length - 1));
  if (!tabs[safe]) return null;
  const visible = providerTabSegments(tabs, safe, width);
  return (
    <Box flexDirection="row" marginBottom={1}>
      {visible.map((segment, index) => (
        <Text
          key={`${segment.index}:${index}`}
          color={
            segment.active
              ? theme.color.violet
              : hoveredId === `right:model-picker:provider-tab:${segment.index}`
                ? theme.color.t1
                : theme.color.t3
          }
          bold={segment.active}
          dimColor={!segment.active && hoveredId !== `right:model-picker:provider-tab:${segment.index}`}
        >
          {segment.text}
        </Text>
      ))}
    </Box>
  );
}

// ── Model list row (desktop-style title + provider subtitle) ─────────────────

// Fixed prefix drawn before every name: cursor arrow (1) + favorite star (1)
// + " " + 2-cell logo + " " = 6 cols.
const ROW_PREFIX_WIDTH = 6;
// Per-row suffix, measured to the character so the name reservation is exact and
// a row can never wrap past its title line:
//   unavailable -> "  SIGN IN" (9 cols)
const ROW_SUFFIX_UNAVAILABLE = "  SIGN IN".length;
const ROW_NAME_MIN = 6;

function ModelListRow({
  entry,
  selected,
  hovered,
  listFocused,
  contentWidth,
  showProviderMark,
  showSubtitle,
}: {
  entry: ModelPickerEntry;
  selected: boolean;
  hovered: boolean;
  listFocused: boolean;
  contentWidth: number;
  showProviderMark: boolean;
  showSubtitle: boolean;
}) {
  // The cursor is the SINGLE source of truth: a small purple "›" arrow + a purple
  // name. It reads bold while the model column holds focus. Every other available
  // model is plain white; unavailable models are dimmed. (No "now" badge — the
  // picker opens with the cursor already on the active model.)
  const accent = selected || hovered;
  const mark = markForEntry(entry);
  const providerLabel = providerLabelFor(entry);
  const nameColor = !entry.isAvailable
    ? theme.color.t5
    : accent
      ? theme.color.violet
      : theme.color.t1;
  const subtitleColor = !entry.isAvailable
    ? theme.color.t5
    : accent
      ? theme.color.t2
      : theme.color.t3;
  const suffixWidth = !entry.isAvailable ? ROW_SUFFIX_UNAVAILABLE : 0;
  const prefixWidth = showProviderMark ? ROW_PREFIX_WIDTH : 3;
  const nameWidth = Math.max(ROW_NAME_MIN, contentWidth - prefixWidth - suffixWidth);
  const subtitleWidth = Math.max(ROW_NAME_MIN, contentWidth - prefixWidth);
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {/* Cursor arrow — shows ONLY while the model list holds focus; the selected
            row still stays purple when focus is on the rail, just without the arrow. */}
        <Text color={selected && listFocused ? theme.color.violet : theme.color.t5}>{selected && listFocused ? "›" : " "}</Text>
        <Text color={entry.isFavorite ? theme.color.warning : theme.color.t5}>{entry.isFavorite ? "★" : "☆"}</Text>
        <Text>{" "}</Text>
        {showProviderMark ? (
          <>
            <LogoCell mark={mark} dim={!entry.isAvailable} />
            <Text>{" "}</Text>
          </>
        ) : null}
        <Text color={nameColor} dimColor={!entry.isAvailable} bold={selected && listFocused} wrap="truncate-end">
          {endTruncate(entry.displayName, nameWidth)}
        </Text>
        {!entry.isAvailable ? <Text color={theme.color.attention} dimColor>{"  SIGN IN"}</Text> : null}
      </Box>
      {showSubtitle ? (
        <Box flexDirection="row">
          <Text color={theme.color.t5}>{" ".repeat(prefixWidth)}</Text>
          <Text color={subtitleColor} dimColor={!accent || !entry.isAvailable} wrap="truncate-end">
            {endTruncate(providerLabel, subtitleWidth)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ── Sticky settings footer ───────────────────────────────────────────────────

function SettingsFooter({
  rows,
  footerFocus,
  width,
  hoveredId,
}: {
  rows: SetupPaneRow[];
  footerFocus: SetupPaneRowKind | null;
  width: number;
  hoveredId: string | null;
}) {
  if (!rows.length) return null;
  const visibleRows = rows.filter((row) => row.kind !== "provider" && row.kind !== "model");
  if (!visibleRows.length) return null;
  const settingRows = visibleRows.filter((row) => row.kind !== "apply");
  const applyRow = visibleRows.find((row) => row.kind === "apply") ?? null;
  const focusedDetail = footerFocus
    ? settingRows.find((row) => row.kind === footerFocus && !row.disabled)?.detail?.trim() ?? null
    : null;
  const divider = "─".repeat(Math.max(4, width));

  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      <Text color={theme.color.border}>{divider}</Text>
      {settingRows.length ? (
        <Box flexDirection="column" marginTop={1}>
          {settingRows.map((row) => {
            const focused = footerFocus === row.kind;
            const hovered = hoveredId === `right:model-picker:setting:${row.kind}`;
            const accent = focused || hovered;
            const labelColor = row.disabled ? theme.color.t5 : theme.color.t4;
            const valueColor = row.disabled ? theme.color.t5 : accent ? theme.color.violet : theme.color.t2;
            return (
              <Box key={row.kind} flexDirection="row">
                <Text color={accent ? theme.color.violet : theme.color.t5}>{focused ? theme.rail : " "}</Text>
                <Text color={row.disabled ? theme.color.t5 : accent ? theme.color.violet : theme.color.t3}>{`${settingIcon(row.kind)} `}</Text>
                <Text color={labelColor} dimColor={!row.disabled}>{endTruncate(row.label.toLowerCase(), 12)}{" "}</Text>
                <Text color={valueColor} bold={focused}>{endTruncate(row.value, 14)}</Text>
              </Box>
            );
          })}
          {focusedDetail ? (
            <Box paddingLeft={3}>
              <Text color={theme.color.t5} dimColor wrap="truncate-end">
                {endTruncate(focusedDetail, Math.max(4, width - 3))}
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      {applyRow ? (
        <Box marginTop={1}>
          {(() => {
            const focused = footerFocus === "apply";
            const hovered = hoveredId === "right:model-picker:setting:apply";
            const accent = focused || hovered;
            const color = applyRow.disabled ? theme.color.t5 : accent ? theme.color.violet : theme.color.violetDeep;
            return <Text color={color} bold={accent}>{`[ ${endTruncate(applyRow.label, 20)} ]`}</Text>;
          })()}
        </Box>
      ) : null}
    </Box>
  );
}

// ── Windowing ────────────────────────────────────────────────────────────────
// rowWindow + sizing helpers are imported from modelPickerGeometry (the single
// geometry source shared with the app.tsx click hit-test).

function emptyStateLabel(state: ModelPickerState, railEntry: ModelPickerRailEntry | undefined): string {
  if (state.query.trim()) return "No models match your search.";
  if (railEntry?.kind === "favorites") return "Star a model to pin it here.";
  if (railEntry?.kind === "recents") return "Models you use will appear here.";
  if (railEntry?.kind === "provider" && railEntry.authStatus === "unavailable") return "Sign in to use this provider.";
  return "No models available.";
}

// Absolute screen cell (0-based) of an Ink element, by summing each ancestor's
// Yoga-computed offset up to the root. Ink renders the whole app at the
// terminal's top-left, so this is the true painted position — the source of
// truth for click hit-testing, replacing hand-derived offset math. Uses Ink
// internals (yogaNode / parentNode) not in the public types, hence the casts;
// fully guarded so any failure leaves the caller on its geometry-math fallback.
function measurePaneOrigin(node: DOMElement): { x: number; y: number; width: number } | null {
  try {
    const rootYoga = (node as unknown as { yogaNode?: { getComputedWidth?: () => number } }).yogaNode;
    const width = rootYoga?.getComputedWidth?.() ?? 0;
    let x = 0;
    let y = 0;
    let cur: unknown = node;
    while (cur) {
      const yoga = (cur as { yogaNode?: { getComputedLeft?: () => number; getComputedTop?: () => number } }).yogaNode;
      if (yoga && typeof yoga.getComputedLeft === "function" && typeof yoga.getComputedTop === "function") {
        x += yoga.getComputedLeft();
        y += yoga.getComputedTop();
      }
      cur = (cur as { parentNode?: unknown }).parentNode;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, width: Number.isFinite(width) ? width : 0 };
  } catch {
    return null;
  }
}

export function ModelPickerPane({
  state,
  width,
  railFocused,
  onMeasureOrigin,
}: {
  state: ModelPickerState;
  width: number;
  /** True when the left category rail holds focus; false = the model list. */
  railFocused: boolean;
  /**
   * Reports the pane's measured content origin (1-based screen cell) + width so
   * the click hit-test maps to where rows actually paint at any window size.
   */
  onMeasureOrigin?: (origin: { x: number; y: number; width: number }) => void;
}) {
  const hoveredId = useHoveredHitId();
  const rootRef = React.useRef<DOMElement | null>(null);
  React.useEffect(() => {
    if (!onMeasureOrigin) return;
    const node = rootRef.current;
    if (!node) return;
    const origin = measurePaneOrigin(node);
    // Yoga is 0-based; mouse/hit-test coords are 1-based.
    if (origin) onMeasureOrigin({ x: origin.x + 1, y: origin.y + 1, width: origin.width });
  }, [onMeasureOrigin, width]);
  const innerWidth = Math.max(20, width - 4);
  const searching = isSearching(state);
  const railEntry = state.railEntries[state.railIndex] ?? state.railEntries[0];

  const entryHeight = modelEntryHeightForState(state);
  const visibleRowCount = modelListRowsForState(state);
  const window = rowWindow(state.entries.length, state.focusedIndex, visibleRowCount);
  const visibleEntries = state.entries.slice(window.start, window.end);
  const headerLines = headerLineCount(state);
  const selectorLines = hasSubProviderSelector(state) ? 2 : 0;
  const railLogoKey = React.useMemo(
    () => state.railEntries.map((entry) => entry.kind === "provider" ? entry.provider : entry.kind).join("|"),
    [state.railEntries],
  );
  const visibleLogoKey = React.useMemo(
    () => visibleEntries.map((entry) => `${entry.modelId}:${entry.family}:${entry.subProvider ?? ""}`).join("|"),
    [visibleEntries],
  );
  // Content sits right of the rail (full width while searching). Each row
  // reserves its OWN prefix + unavailable suffix from contentWidth, so the title
  // and subtitle stay inside the fixed two-line row budget.
  const contentWidth = searching ? innerWidth : Math.max(14, innerWidth - RAIL_WIDTH - 2);
  const searchWidth = Math.max(8, innerWidth - 2);
  const compactProviderRows = usesCompactProviderRows(state);
  const rowProviderMarksVisible = !compactProviderRows;
  const rowSubtitleVisible = !compactProviderRows;
  const listFocused = state.footerFocus == null && !railFocused;

  React.useEffect(() => {
    if (!supportsInlineLogoImages()) return;
    const node = rootRef.current;
    if (!node) return;
    const origin = measurePaneOrigin(node);
    if (!origin) return;
    const rootX = origin.x + 1;
    const rootY = origin.y + 1;
    const modelRegionY = rootY + headerLines + 3;
    const listTop = modelRegionY + selectorLines;
    const listLeft = searching ? rootX : rootX + RAIL_WIDTH + RAIL_TO_LIST_GAP;

    if (!searching) {
      state.railEntries.forEach((entry, index) => {
        if (entry.kind !== "provider") return;
        drawInlineLogo(markForProvider(entry.provider), rootX + 1, modelRegionY + index);
      });
    }
    if (!rowProviderMarksVisible) return;
    visibleEntries.forEach((entry, sliceIndex) => {
      drawInlineLogo(markForEntry(entry), listLeft + 3, listTop + (sliceIndex * entryHeight));
    });
  }, [
    entryHeight,
    headerLines,
    railLogoKey,
    rowProviderMarksVisible,
    searching,
    selectorLines,
    visibleLogoKey,
  ]);

  // The list always occupies exactly the same line budget for this view (padded
  // with blanks) so the settings footer never shifts as the catalog length changes.
  const listRows: React.ReactNode[] = [];
  if (state.entries.length === 0) {
    listRows.push(
      <Box key="empty" flexDirection="column">
        <Text color={theme.color.t4} dimColor wrap="truncate-end">
          {endTruncate(emptyStateLabel(state, railEntry), contentWidth)}
        </Text>
        {Array.from({ length: entryHeight - 1 }, (_v, i) => <Text key={i}> </Text>)}
      </Box>,
    );
  } else {
    visibleEntries.forEach((entry, sliceIndex) => {
      const flatIndex = window.start + sliceIndex;
      listRows.push(
        <ModelListRow
          key={entry.modelId || `entry-${flatIndex}`}
          entry={entry}
          selected={flatIndex === state.focusedIndex}
          hovered={hoveredId === `right:model-picker:entry:${entry.modelId}`}
          listFocused={listFocused}
          contentWidth={contentWidth}
          showProviderMark={rowProviderMarksVisible}
          showSubtitle={rowSubtitleVisible}
        />,
      );
    });
  }
  while (listRows.length < visibleRowCount) {
    listRows.push(
      <Box key={`pad-${listRows.length}`} flexDirection="column">
        {Array.from({ length: entryHeight }, (_v, i) => <Text key={i}> </Text>)}
      </Box>,
    );
  }

  return (
    <Box ref={rootRef} flexDirection="column">
      {/* Header (fixed). */}
      <Box flexDirection="column" marginBottom={1} flexShrink={0}>
        <Text color={theme.color.t4} dimColor wrap="truncate-end">
          {state.entries.length} model{state.entries.length === 1 ? "" : "s"}
          {state.laneLabel ? ` · ${endTruncate(state.laneLabel, Math.max(6, innerWidth - 18))}` : ""}
        </Text>
        {state.activeProviderAuthStatus === "unavailable" && state.activeProviderSignInHint ? (
          <Text color={theme.color.attention} wrap="truncate-end">{`Sign in: ${state.activeProviderSignInHint}`}</Text>
        ) : null}
      </Box>

      {/* Search (fixed). */}
      <Box marginBottom={1} flexShrink={0}>
        <Text color={state.searchMode ? theme.color.violet : theme.color.t4}>{"⌕ "}</Text>
        <Text color={state.query ? theme.color.t1 : theme.color.t4} dimColor={!state.query} wrap="truncate-end">
          {endTruncate(state.query || "search models…", Math.max(6, searchWidth - 2))}
        </Text>
        {state.searchMode ? <Text color={theme.color.violet}>▏</Text> : null}
      </Box>

      {/* Bounded model region: icon rail + fixed-height windowed list. */}
      {searching ? (
        <Box flexDirection="column" flexShrink={0}>{listRows}</Box>
      ) : (
        <Box flexDirection="row" flexShrink={0}>
          <VerticalRail entries={state.railEntries} selectedIndex={state.railIndex} hoveredId={hoveredId} focused={railFocused} />
          <Box
            flexDirection="column"
            flexGrow={1}
            borderStyle="single"
            borderColor={theme.color.border}
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            paddingLeft={1}
          >
            <SubProviderTabs tabs={state.providerTabs} selectedIndex={state.providerTabIndex} width={contentWidth} />
            {listRows}
          </Box>
        </Box>
      )}
      {/* Sticky settings footer. */}
      <SettingsFooter rows={state.settingsRows} footerFocus={state.footerFocus} width={innerWidth} hoveredId={hoveredId} />

      {/* Key hints. */}
      <KeyHints
        items={[
          ["←→", "rail / list"],
          ["↑↓", "move"],
          ["↵", "pick"],
          ...(state.providerTabs.length > 1 ? ([["[ ]", "tabs"]] as Array<[string, string]>) : []),
          ["tab", state.providerTabs.length > 1 ? "tabs" : "rail"],
          ["f", "fav"],
          ["/", "search"],
          ["esc", "close"],
        ]}
      />
    </Box>
  );
}
