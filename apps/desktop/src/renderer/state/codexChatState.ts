import type { CodexPendingApprovalRequest, CodexThread, CodexThreadItem, CodexTurn } from "../../shared/types";

type UnknownRecord = Record<string, unknown>;

export type CodexPlanStep = {
  step: string;
  status: string;
};

export type CodexChatItem = {
  id: string;
  type: string;
  status: string | null;
  text: string;
  command: string | null;
  cwd: string | null;
  aggregatedOutput: string | null;
  raw: UnknownRecord;
  startedAt: string | null;
  completedAt: string | null;
};

export type CodexChatTurn = {
  id: string;
  status: string;
  error: string | null;
  itemsById: Record<string, CodexChatItem>;
  itemOrder: string[];
  diff: string | null;
  planExplanation: string | null;
  plan: CodexPlanStep[];
  startedAt: string | null;
  completedAt: string | null;
};

export type CodexChatState = {
  threadId: string | null;
  preview: string | null;
  threadStatus: string | null;
  turnOrder: string[];
  turnsById: Record<string, CodexChatTurn>;
  pendingApprovalsById: Record<string, CodexPendingApprovalRequest>;
  lastError: string | null;
  updatedAt: string;
};

export type CodexChatAction =
  | { type: "reset"; threadId?: string | null; at: string }
  | { type: "hydrate-thread"; thread: CodexThread; at: string }
  | { type: "notification"; method: string; params: unknown; receivedAt: string }
  | { type: "approvals-loaded"; requests: CodexPendingApprovalRequest[]; at: string }
  | { type: "approval-added"; request: CodexPendingApprovalRequest; at: string }
  | { type: "approval-removed"; requestId: string; at: string };

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function threadIdFromParams(params: unknown): string | null {
  const record = asRecord(params);
  if (!record) return null;
  const direct = asString(record.threadId);
  if (direct) return direct;
  const thread = asRecord(record.thread);
  return asString(thread?.id);
}

function buildUserMessageText(record: UnknownRecord): string {
  const content = record.content;
  if (!Array.isArray(content)) return "";
  const fragments: string[] = [];
  for (const row of content) {
    const rowRecord = asRecord(row);
    if (!rowRecord) continue;
    const text = asString(rowRecord.text);
    if (text) {
      fragments.push(text);
      continue;
    }
    const data = asRecord(rowRecord.data);
    const nestedText = asString(data?.text);
    if (nestedText) fragments.push(nestedText);
  }
  return fragments.join("\n");
}

function buildReasoningText(record: UnknownRecord): string {
  const summary = asStringArray(record.summary);
  const content = asStringArray(record.content);
  return [...summary, ...content].join("\n");
}

function buildItemFromRaw(raw: UnknownRecord, at: string, started: boolean): CodexChatItem {
  const id = asString(raw.id) ?? "";
  const type = asString(raw.type) ?? "unknown";
  const status = asString(raw.status);
  const command = asString(raw.command);
  const cwd = asString(raw.cwd);
  const aggregatedOutput = asString(raw.aggregatedOutput);

  let text = "";
  if (type === "agentMessage" || type === "plan") {
    text = asString(raw.text) ?? "";
  } else if (type === "userMessage") {
    text = buildUserMessageText(raw);
  } else if (type === "reasoning") {
    text = buildReasoningText(raw);
  } else if (type === "commandExecution") {
    text = aggregatedOutput ?? "";
  } else {
    text = asString(raw.text) ?? "";
  }

  return {
    id,
    type,
    status,
    text,
    command,
    cwd,
    aggregatedOutput,
    raw,
    startedAt: started ? at : null,
    completedAt: started ? null : at
  };
}

function buildItem(item: CodexThreadItem, at: string, started: boolean): CodexChatItem {
  const record = asRecord(item) ?? { id: item.id, type: item.type };
  return buildItemFromRaw(record, at, started);
}

function buildTurn(turn: CodexTurn, at: string): CodexChatTurn {
  const itemsById: Record<string, CodexChatItem> = {};
  const itemOrder: string[] = [];
  for (const item of turn.items ?? []) {
    const built = buildItem(item, at, false);
    if (!built.id) continue;
    itemsById[built.id] = built;
    itemOrder.push(built.id);
  }

  return {
    id: turn.id,
    status: turn.status,
    error: asString(turn.error?.message) ?? null,
    itemsById,
    itemOrder,
    diff: null,
    planExplanation: null,
    plan: [],
    startedAt: null,
    completedAt: null
  };
}

function ensureTurn(state: CodexChatState, turnId: string, at: string): CodexChatTurn {
  return (
    state.turnsById[turnId] ?? {
      id: turnId,
      status: "running",
      error: null,
      itemsById: {},
      itemOrder: [],
      diff: null,
      planExplanation: null,
      plan: [],
      startedAt: at,
      completedAt: null
    }
  );
}

function upsertTurn(state: CodexChatState, turn: CodexChatTurn, appendOrder: boolean): CodexChatState {
  const nextOrder = appendOrder && !state.turnOrder.includes(turn.id) ? [...state.turnOrder, turn.id] : state.turnOrder;
  return {
    ...state,
    turnOrder: nextOrder,
    turnsById: {
      ...state.turnsById,
      [turn.id]: turn
    }
  };
}

function shouldApplyThreadScopedEvent(state: CodexChatState, params: unknown): boolean {
  if (!state.threadId) return true;
  const eventThreadId = threadIdFromParams(params);
  if (!eventThreadId) return true;
  return eventThreadId === state.threadId;
}

function applyNotification(state: CodexChatState, method: string, params: unknown, receivedAt: string): CodexChatState {
  if (!shouldApplyThreadScopedEvent(state, params)) {
    return state;
  }

  const record = asRecord(params) ?? {};

  if (method === "thread/started") {
    const thread = asRecord(record.thread);
    const threadId = asString(thread?.id) ?? state.threadId;
    const preview = asString(thread?.preview) ?? state.preview;
    return {
      ...state,
      threadId,
      preview,
      updatedAt: receivedAt
    };
  }

  if (method === "thread/status/changed") {
    const status = asString(record.status);
    if (!status) return state;
    return {
      ...state,
      threadStatus: status,
      updatedAt: receivedAt
    };
  }

  if (method === "turn/started") {
    const turnRecord = asRecord(record.turn);
    const turnId = asString(turnRecord?.id);
    if (!turnId) return state;
    const nextTurn = {
      ...ensureTurn(state, turnId, receivedAt),
      ...buildTurn(
        {
          id: turnId,
          status: asString(turnRecord?.status) ?? "running",
          items: [],
          error: null
        },
        receivedAt
      ),
      startedAt: receivedAt,
      completedAt: null
    };
    return {
      ...upsertTurn(state, nextTurn, true),
      updatedAt: receivedAt
    };
  }

  if (method === "turn/completed") {
    const turnRecord = asRecord(record.turn);
    const turnId = asString(turnRecord?.id);
    if (!turnId) return state;
    const prev = ensureTurn(state, turnId, receivedAt);
    const completed = {
      ...prev,
      status: asString(turnRecord?.status) ?? prev.status,
      error: asString(asRecord(turnRecord?.error)?.message) ?? prev.error,
      completedAt: receivedAt
    };
    return {
      ...upsertTurn(state, completed, true),
      updatedAt: receivedAt
    };
  }

  if (method === "turn/diff/updated") {
    const turnId = asString(record.turnId);
    if (!turnId) return state;
    const turn = ensureTurn(state, turnId, receivedAt);
    const nextTurn: CodexChatTurn = {
      ...turn,
      diff: asString(record.diff) ?? turn.diff
    };
    return {
      ...upsertTurn(state, nextTurn, true),
      updatedAt: receivedAt
    };
  }

  if (method === "turn/plan/updated") {
    const turnId = asString(record.turnId);
    if (!turnId) return state;
    const turn = ensureTurn(state, turnId, receivedAt);
    const planRaw = Array.isArray(record.plan) ? record.plan : [];
    const plan: CodexPlanStep[] = planRaw
      .map((entry) => {
        const row = asRecord(entry);
        if (!row) return null;
        const step = asString(row.step);
        const status = asString(row.status);
        if (!step || !status) return null;
        return { step, status };
      })
      .filter((row): row is CodexPlanStep => row !== null);
    const nextTurn: CodexChatTurn = {
      ...turn,
      plan,
      planExplanation: asString(record.explanation)
    };
    return {
      ...upsertTurn(state, nextTurn, true),
      updatedAt: receivedAt
    };
  }

  if (method === "item/started" || method === "item/completed") {
    const turnId = asString(record.turnId);
    const itemRecord = asRecord(record.item);
    const itemId = asString(itemRecord?.id);
    if (!turnId || !itemRecord || !itemId) return state;
    const turn = ensureTurn(state, turnId, receivedAt);
    const nextItem = buildItemFromRaw(itemRecord, receivedAt, method === "item/started");
    const nextOrder = turn.itemOrder.includes(itemId) ? turn.itemOrder : [...turn.itemOrder, itemId];
    const nextTurn: CodexChatTurn = {
      ...turn,
      itemOrder: nextOrder,
      itemsById: {
        ...turn.itemsById,
        [itemId]: {
          ...(turn.itemsById[itemId] ?? nextItem),
          ...nextItem,
          startedAt: method === "item/started" ? receivedAt : turn.itemsById[itemId]?.startedAt ?? receivedAt,
          completedAt: method === "item/completed" ? receivedAt : turn.itemsById[itemId]?.completedAt ?? null
        }
      }
    };
    return {
      ...upsertTurn(state, nextTurn, true),
      updatedAt: receivedAt
    };
  }

  const isDeltaMethod =
    method === "item/agentMessage/delta" ||
    method === "item/commandExecution/outputDelta" ||
    method === "item/fileChange/outputDelta" ||
    method === "item/reasoning/summaryTextDelta" ||
    method === "item/reasoning/textDelta" ||
    method === "item/plan/delta";

  if (isDeltaMethod) {
    const turnId = asString(record.turnId);
    const itemId = asString(record.itemId);
    const delta = asString(record.delta) ?? "";
    if (!turnId || !itemId || !delta.length) return state;

    const turn = ensureTurn(state, turnId, receivedAt);
    const prevItem = turn.itemsById[itemId] ?? {
      id: itemId,
      type: method === "item/commandExecution/outputDelta" ? "commandExecution" : method === "item/fileChange/outputDelta" ? "fileChange" : method === "item/plan/delta" ? "plan" : method.startsWith("item/reasoning/") ? "reasoning" : "agentMessage",
      status: "running",
      text: "",
      command: null,
      cwd: null,
      aggregatedOutput: null,
      raw: { id: itemId },
      startedAt: receivedAt,
      completedAt: null
    };

    const nextText = `${prevItem.text}${delta}`;
    const nextItem: CodexChatItem = {
      ...prevItem,
      text: nextText,
      aggregatedOutput:
        method === "item/commandExecution/outputDelta"
          ? `${prevItem.aggregatedOutput ?? ""}${delta}`
          : prevItem.aggregatedOutput,
      startedAt: prevItem.startedAt ?? receivedAt,
      completedAt: null
    };

    const nextOrder = turn.itemOrder.includes(itemId) ? turn.itemOrder : [...turn.itemOrder, itemId];
    const nextTurn: CodexChatTurn = {
      ...turn,
      itemOrder: nextOrder,
      itemsById: {
        ...turn.itemsById,
        [itemId]: nextItem
      }
    };

    return {
      ...upsertTurn(state, nextTurn, true),
      updatedAt: receivedAt
    };
  }

  if (method === "error") {
    const message = asString(record.message) ?? "Unknown Codex error";
    return {
      ...state,
      lastError: message,
      updatedAt: receivedAt
    };
  }

  return state;
}

export function createInitialCodexChatState(now: string): CodexChatState {
  return {
    threadId: null,
    preview: null,
    threadStatus: null,
    turnOrder: [],
    turnsById: {},
    pendingApprovalsById: {},
    lastError: null,
    updatedAt: now
  };
}

export function codexChatReducer(state: CodexChatState, action: CodexChatAction): CodexChatState {
  switch (action.type) {
    case "reset": {
      return {
        ...createInitialCodexChatState(action.at),
        threadId: action.threadId ?? null
      };
    }

    case "hydrate-thread": {
      const turnsById: Record<string, CodexChatTurn> = {};
      const turnOrder: string[] = [];
      for (const turn of action.thread.turns ?? []) {
        const built = buildTurn(turn, action.at);
        turnsById[built.id] = built;
        turnOrder.push(built.id);
      }
      const approvals = Object.values(state.pendingApprovalsById).filter((request) => request.threadId === action.thread.id);
      const pendingApprovalsById = Object.fromEntries(approvals.map((request) => [request.requestId, request]));

      return {
        ...state,
        threadId: action.thread.id,
        preview: action.thread.preview,
        turnOrder,
        turnsById,
        pendingApprovalsById,
        updatedAt: action.at,
        lastError: null
      };
    }

    case "notification": {
      return applyNotification(state, action.method, action.params, action.receivedAt);
    }

    case "approvals-loaded": {
      const filtered = state.threadId
        ? action.requests.filter((request) => request.threadId === state.threadId)
        : action.requests;
      return {
        ...state,
        pendingApprovalsById: Object.fromEntries(filtered.map((request) => [request.requestId, request])),
        updatedAt: action.at
      };
    }

    case "approval-added": {
      if (state.threadId && action.request.threadId !== state.threadId) {
        return state;
      }
      return {
        ...state,
        pendingApprovalsById: {
          ...state.pendingApprovalsById,
          [action.request.requestId]: action.request
        },
        updatedAt: action.at
      };
    }

    case "approval-removed": {
      if (!state.pendingApprovalsById[action.requestId]) return state;
      const next = { ...state.pendingApprovalsById };
      delete next[action.requestId];
      return {
        ...state,
        pendingApprovalsById: next,
        updatedAt: action.at
      };
    }

    default:
      return state;
  }
}

export function getOrderedTurns(state: CodexChatState): CodexChatTurn[] {
  return state.turnOrder.map((turnId) => state.turnsById[turnId]).filter((turn): turn is CodexChatTurn => Boolean(turn));
}

export function getActiveTurnId(state: CodexChatState): string | null {
  for (let i = state.turnOrder.length - 1; i >= 0; i -= 1) {
    const turn = state.turnsById[state.turnOrder[i]!];
    if (!turn) continue;
    const status = turn.status.toLowerCase();
    if (status === "completed" || status === "failed" || status === "cancelled" || status === "canceled") continue;
    return turn.id;
  }
  return null;
}

export function getApprovalsForTurn(state: CodexChatState, turnId: string): CodexPendingApprovalRequest[] {
  return Object.values(state.pendingApprovalsById)
    .filter((request) => request.turnId === turnId)
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export function getApprovalForItem(state: CodexChatState, itemId: string): CodexPendingApprovalRequest | null {
  for (const request of Object.values(state.pendingApprovalsById)) {
    if (request.itemId === itemId) return request;
  }
  return null;
}
