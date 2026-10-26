import { useMemo, useState } from "react";

import type { PendingInputOption, PendingInputQuestion, PendingInputResponse } from "../sdkTypes";
import { readRecord, type ApprovalRow } from "./transcriptRows";

export type PendingInputRespond = (
  requestId: string,
  response: PendingInputResponse,
) => void | Promise<void>;

export type PendingInputCardProps = {
  row: ApprovalRow;
  onRespond?: PendingInputRespond;
};

type PendingInputShape = {
  requestId: string;
  title: string;
  description: string;
  questions: PendingInputQuestion[];
  options: PendingInputOption[];
  allowsFreeform?: boolean;
  canProceedWithoutAnswer?: boolean;
};

function readOptions(value: unknown): PendingInputOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const option = readRecord(entry);
    if (typeof option?.label !== "string" || typeof option.value !== "string") return [];
    return [{ label: option.label, value: option.value, ...(typeof option.description === "string" ? { description: option.description } : {}) }];
  });
}

function readQuestions(value: unknown): PendingInputQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const question = readRecord(entry);
    if (typeof question?.id !== "string" || typeof question.question !== "string") return [];
    const options = readOptions(question.options);
    return [{
      id: question.id,
      question: question.question,
      ...(typeof question.header === "string" ? { header: question.header } : {}),
      ...(options.length ? { options } : {}),
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
      ...(typeof question.allowsFreeform === "boolean" ? { allowsFreeform: question.allowsFreeform } : {}),
      ...(question.isSecret === true ? { isSecret: true } : {}),
    }];
  });
}

function pendingInputFromRow(row: ApprovalRow): PendingInputShape {
  const detail = readRecord(row.detail);
  const nested = readRecord(detail?.request) ?? readRecord(detail?.pendingInput) ?? detail;
  const questions = row.questions ?? readQuestions(nested?.questions);
  const options = row.options ?? readOptions(nested?.options);
  return {
    requestId: row.requestId ?? (typeof nested?.requestId === "string" ? nested.requestId : row.id),
    title: row.title ?? (typeof nested?.title === "string" ? nested.title : "The assistant needs your input"),
    description: row.description,
    questions,
    options,
    ...(row.allowsFreeform !== undefined
      ? { allowsFreeform: row.allowsFreeform }
      : typeof nested?.allowsFreeform === "boolean" ? { allowsFreeform: nested.allowsFreeform } : {}),
    ...(typeof nested?.canProceedWithoutAnswer === "boolean"
      ? { canProceedWithoutAnswer: nested.canProceedWithoutAnswer }
      : {}),
  };
}

export function PendingInputCard({ row, onRespond }: PendingInputCardProps) {
  const request = useMemo(() => pendingInputFromRow(row), [row]);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const isPlan = row.requestKind === "plan_approval";
  const canRespond = Boolean(onRespond) && row.state === "pending" && !busy && !submitted;
  const hasAnswer = request.questions.length
    ? request.questions.every((question) => {
        const selected = picks[question.id] ?? [];
        return selected.length > 0 || Boolean((notes[question.id] ?? "").trim()) || request.canProceedWithoutAnswer === true;
      })
    : Boolean((notes.response ?? "").trim()) || request.canProceedWithoutAnswer === true;

  const respond = async (response: PendingInputResponse) => {
    if (!onRespond || !canRespond) return;
    setBusy(true);
    setFailure(null);
    try {
      await onRespond(request.requestId, response);
      setPicks({});
      setNotes({});
      setSubmitted(true);
    } catch (cause: unknown) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const submitAnswers = () => {
    const answers: Record<string, string | string[]> = {};
    if (request.questions.length) {
      for (const question of request.questions) {
        const selected = picks[question.id] ?? [];
        const note = (notes[question.id] ?? "").trim();
        const values = [...selected, ...(note ? [note] : [])];
        if (values.length === 1) answers[question.id] = values[0]!;
        else if (values.length > 1) answers[question.id] = values;
      }
    } else {
      const responseText = (notes.response ?? "").trim();
      if (responseText) {
        void respond({ responseText });
        return;
      }
    }
    void respond({ answers });
  };

  const title = isPlan ? "Plan ready for review" : request.title;
  const settledLabel = row.state === "accepted" ? "Answered"
    : row.state === "rejected" ? "Declined"
      : row.state === "cancelled" ? "Cancelled"
        : row.state === "expired" ? "The turn ended before this was answered."
          : submitted ? "Answer sent" : null;

  return (
    <section className="adechat-approval adechat-pending-input" data-state={row.state}>
      <div className="adechat-approval-head">
        <strong className="adechat-approval-title">{title}</strong>
        {settledLabel ? <span className="adechat-approval-settled">{settledLabel}</span> : null}
      </div>

      {isPlan ? (
        <div className="adechat-pending-plan">{request.description || request.questions[0]?.question || "The assistant has prepared a plan."}</div>
      ) : null}

      {!isPlan && request.questions.length ? request.questions.map((question, index) => {
        const options = question.options?.length ? question.options : (index === 0 ? request.options : []);
        const allowText = question.allowsFreeform ?? request.allowsFreeform ?? options.length === 0;
        const answer = notes[question.id] ?? "";
        return (
          <fieldset className="adechat-pending-question" key={question.id} disabled={!canRespond}>
            <legend>{question.header ? <span>{question.header}: </span> : null}{question.question}</legend>
            {options.map((option) => {
              const selected = picks[question.id] ?? [];
              const checked = selected.includes(option.value);
              const toggle = () => setPicks((current) => {
                const values = current[question.id] ?? [];
                const next = question.multiSelect
                  ? checked ? values.filter((value) => value !== option.value) : [...values, option.value]
                  : checked ? [] : [option.value];
                return { ...current, [question.id]: next };
              });
              return (
                <label className="adechat-pending-option" key={option.value}>
                  <input
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={`adechat-question-${row.id}-${question.id}`}
                    checked={checked}
                    onChange={toggle}
                    disabled={!canRespond}
                  />
                  <span>{option.label}{option.description ? <small>{option.description}</small> : null}</span>
                </label>
              );
            })}
            {allowText ? question.isSecret ? (
              <input
                className="adechat-pending-answer"
                type="password"
                autoComplete="off"
                aria-label={`Your answer to ${question.question}`}
                placeholder="Enter a private answer…"
                value={answer}
                onChange={(event) => setNotes((current) => ({ ...current, [question.id]: event.target.value }))}
                disabled={!canRespond}
              />
            ) : (
              <textarea
                className="adechat-pending-answer"
                aria-label={`Your answer to ${question.question}`}
                placeholder="Add a note…"
                value={answer}
                onChange={(event) => setNotes((current) => ({ ...current, [question.id]: event.target.value }))}
                disabled={!canRespond}
              />
            ) : null}
          </fieldset>
        );
      }) : null}

      {!isPlan && request.questions.length === 0 ? (
        <>
          {request.description ? <p className="adechat-pending-description">{request.description}</p> : null}
          {request.allowsFreeform !== false ? (
            <textarea
              className="adechat-pending-answer"
              aria-label="Your answer"
              placeholder="Write your answer…"
              value={notes.response ?? ""}
              onChange={(event) => setNotes((current) => ({ ...current, response: event.target.value }))}
              disabled={!canRespond}
            />
          ) : null}
        </>
      ) : null}

      {!onRespond && row.state === "pending" ? (
        <p className="adechat-approval-note">This client cannot answer questions or approve plans.</p>
      ) : null}

      {onRespond && row.state === "pending" ? (
        <div className="adechat-approval-actions">
          {isPlan ? (
            <>
              <button className="adechat-button" data-variant="primary" type="button" disabled={!canRespond} onClick={() => void respond({ decision: "accept" })}>Approve plan</button>
              <button className="adechat-button" type="button" disabled={!canRespond} onClick={() => void respond({ decision: "decline" })}>Keep planning</button>
            </>
          ) : (
            <button className="adechat-button" data-variant="primary" type="button" disabled={!canRespond || !hasAnswer} onClick={submitAnswers}>{busy ? "Sending…" : "Send answer"}</button>
          )}
        </div>
      ) : null}

      {failure ? <p className="adechat-approval-error" role="alert">Could not send that answer: {failure}</p> : null}
    </section>
  );
}
