import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChatCircleText } from "@phosphor-icons/react";
import {
  SURVEY_RESPONSE_MAX_LENGTH,
  type ProductSurvey,
  type ProductSurveyAnswer,
  type ProductSurveyQuestion,
} from "../../../../shared/types/productSurveys";
import { APP_BANNER_PRIORITY, useAppBanner, useVisibleAppSuggestion, type NoticeAction } from "../../ui/notice";
import { showToast } from "../toast/toastStore";
import { openExternalUrl } from "../../../lib/openExternal";

const BANNER_ID = "product-survey";

/** Layout only: the kit classes own colour and type. */
const STACK: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, marginTop: 2 };
const CHOICES: CSSProperties = { display: "flex", flexDirection: "column", alignItems: "stretch" };
const CHOICE_BUTTON: CSSProperties = { height: "auto", minHeight: 24, padding: "3px 8px", textAlign: "left", whiteSpace: "normal" };
const RATING: CSSProperties = { display: "flex", flexWrap: "wrap" };
const RATING_LABELS: CSSProperties = { display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--kit-text-3)" };
const TEXTAREA: CSSProperties = { height: 72, width: "100%", padding: "6px 10px", resize: "none", boxSizing: "border-box" };
const OTHER_INPUT: CSSProperties = { width: "100%", boxSizing: "border-box" };

function ratingValues(question: Extract<ProductSurveyQuestion, { type: "rating" }>): number[] {
  return Array.from({ length: question.max - question.min + 1 }, (_, index) => question.min + index);
}

/**
 * One in-app survey, a question at a time, in the corner card the
 * situational suggestions use (`docs/design/notices.md`, Suggestions). It sits
 * one band behind real suggestions, so a suggestion that claims the corner
 * goes first, and it is recorded as shown only once it is actually on screen.
 * "Not now" is the dismissal. Loaded lazily by `SurveyHost`, and only when
 * the main process offered a survey.
 */
export default function SurveyCard({
  survey,
  onDone,
}: {
  survey: ProductSurvey;
  onDone: () => void;
}): null {
  const bridge = window.ade?.analytics?.surveys;
  const [step, setStep] = useState(0);
  const [choices, setChoices] = useState<Record<string, ProductSurveyAnswer>>({});
  /** Whether each question has an answer the person can send. */
  const [filled, setFilled] = useState<Record<string, boolean>>({});
  // Typed text stays in refs: a keystroke must not re-register the card.
  const texts = useRef<Record<string, string>>({});
  const otherTexts = useRef<Record<string, string>>({});
  const shownRef = useRef(false);
  const doneRef = useRef(false);
  const sendingRef = useRef(false);
  const question = survey.questions[step];
  const last = step === survey.questions.length - 1;

  const visible = useVisibleAppSuggestion();
  const onScreen = visible?.model.id === BANNER_ID;
  useEffect(() => {
    if (!onScreen || shownRef.current) return;
    shownRef.current = true;
    void bridge?.record({ kind: "shown", surveyId: survey.id }).catch(() => undefined);
  }, [bridge, onScreen, survey.id]);

  const setFilledFor = useCallback((id: string, value: boolean) => {
    setFilled((current) => (current[id] === value ? current : { ...current, [id]: value }));
  }, []);

  const otherLabel = (q: ProductSurveyQuestion): string | null =>
    (q.type === "single_choice" || q.type === "multiple_choice") && q.hasOpenChoice ? q.choices[q.choices.length - 1] ?? null : null;

  const isFilled = useCallback((q: ProductSurveyQuestion, answer: ProductSurveyAnswer | undefined): boolean => {
    const other = otherLabel(q);
    const otherOk = (otherTexts.current[q.id] ?? "").trim().length > 0;
    if (q.type === "single_choice") return typeof answer === "string" && (answer !== other || otherOk);
    if (q.type === "multiple_choice") return Array.isArray(answer) && answer.length > 0 && (!other || !answer.includes(other) || otherOk);
    return answer != null;
  }, []);

  const pick = useCallback((q: ProductSurveyQuestion, value: string) => {
    let next: ProductSurveyAnswer = value;
    if (q.type === "multiple_choice") {
      const list = Array.isArray(choices[q.id]) ? choices[q.id] as string[] : [];
      next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
    }
    setChoices({ ...choices, [q.id]: next });
    setFilledFor(q.id, isFilled(q, next));
  }, [choices, isFilled, setFilledFor]);

  const finish = useCallback(() => {
    doneRef.current = true;
    onDone();
  }, [onDone]);

  const dismiss = useCallback(() => {
    if (doneRef.current) return;
    const partiallyCompleted = step > 0 || Object.values(filled).some(Boolean);
    void bridge?.record({ kind: "dismissed", surveyId: survey.id, partiallyCompleted }).catch(() => undefined);
    finish();
  }, [bridge, filled, finish, step, survey.id]);

  const send = useCallback(async (override: Record<string, ProductSurveyAnswer> = {}) => {
    if (doneRef.current || sendingRef.current) return;
    const answers: Record<string, ProductSurveyAnswer> = {};
    for (const q of survey.questions) {
      const other = otherLabel(q);
      const otherText = (otherTexts.current[q.id] ?? "").trim();
      if (q.type === "open") {
        const typed = (texts.current[q.id] ?? "").trim();
        if (typed) answers[q.id] = typed;
      } else if (q.type === "single_choice") {
        const picked = choices[q.id];
        if (typeof picked === "string") answers[q.id] = picked === other ? otherText : picked;
      } else if (q.type === "multiple_choice") {
        const picked = choices[q.id];
        if (Array.isArray(picked) && picked.length > 0) {
          answers[q.id] = picked.map((item) => (item === other ? otherText : item)).filter(Boolean);
        }
      } else if (choices[q.id] != null) {
        answers[q.id] = choices[q.id];
      }
    }
    Object.assign(answers, override);
    sendingRef.current = true;
    const result = await bridge?.record({ kind: "sent", surveyId: survey.id, answers }).catch(() => null);
    sendingRef.current = false;
    // Thank the person only for an answer that left; otherwise keep the card so they can try again.
    if (!result?.accepted) {
      showToast({ tone: "warning", title: "Your answer wasn't sent", message: "Check your answers and try again." });
      return;
    }
    showToast({ tone: "success", title: "Thanks for telling us", message: "Your answer goes straight to the people building ADE." });
    finish();
  }, [bridge, choices, finish, survey]);

  const advance = useCallback(() => {
    if (last) void send();
    else setStep((current) => current + 1);
  }, [last, send]);

  const extra = useMemo(() => {
    if (!question) return null;
    const answer = choices[question.id];
    if (question.type === "open") {
      return (
        <div style={STACK}>
          <textarea
            key={question.id}
            className="kit-input"
            style={TEXTAREA}
            maxLength={SURVEY_RESPONSE_MAX_LENGTH}
            placeholder="Type your answer"
            aria-label={question.question}
            defaultValue={texts.current[question.id] ?? ""}
            onChange={(event) => {
              texts.current[question.id] = event.target.value;
              setFilledFor(question.id, event.target.value.trim().length > 0);
            }}
          />
        </div>
      );
    }
    if (question.type === "rating") {
      return (
        <div style={STACK}>
          <div className="kit-seg" data-case="sentence" role="radiogroup" aria-label={question.question} style={RATING}>
            {ratingValues(question).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={answer === String(value)}
                onClick={() => pick(question, String(value))}
              >
                {value}
              </button>
            ))}
          </div>
          {question.lowerBoundLabel || question.upperBoundLabel ? (
            <div style={RATING_LABELS}>
              <span>{question.lowerBoundLabel}</span>
              <span>{question.upperBoundLabel}</span>
            </div>
          ) : null}
        </div>
      );
    }
    if (question.type === "single_choice" || question.type === "multiple_choice") {
      const multiple = question.type === "multiple_choice";
      const other = otherLabel(question);
      const otherPicked = other != null && (multiple ? Array.isArray(answer) && answer.includes(other) : answer === other);
      return (
        <div style={STACK}>
          <div
            className="kit-seg"
            data-case="sentence"
            role={multiple ? "group" : "radiogroup"}
            aria-label={question.question}
            style={CHOICES}
          >
            {question.choices.map((choice) => {
              const checked = multiple ? Array.isArray(answer) && answer.includes(choice) : answer === choice;
              return (
                <button
                  key={choice}
                  type="button"
                  role={multiple ? "checkbox" : "radio"}
                  aria-checked={checked}
                  style={CHOICE_BUTTON}
                  onClick={() => pick(question, choice)}
                >
                  {choice}
                </button>
              );
            })}
          </div>
          {otherPicked ? (
            <input
              key={`${question.id}:other`}
              className="kit-input"
              style={OTHER_INPUT}
              maxLength={SURVEY_RESPONSE_MAX_LENGTH}
              placeholder="Tell us more"
              aria-label={other ?? "Other"}
              defaultValue={otherTexts.current[question.id] ?? ""}
              onChange={(event) => {
                otherTexts.current[question.id] = event.target.value;
                setFilledFor(question.id, isFilled(question, answer));
              }}
            />
          ) : null}
        </div>
      );
    }
    return null;
  }, [choices, isFilled, pick, question, setFilledFor]);

  const actions = useMemo((): NoticeAction[] => {
    if (!question) return [];
    const primaryLabel = question.buttonText ?? (last ? "Send" : "Next");
    const primary: NoticeAction = question.type === "link"
      ? {
          label: question.buttonText ?? "Open",
          variant: "solid",
          disabled: !question.link,
          onClick: () => {
            if (question.link) openExternalUrl(question.link);
            if (last) void send({ [question.id]: "link clicked" });
            else {
              setChoices((current) => ({ ...current, [question.id]: "link clicked" }));
              setStep((current) => current + 1);
            }
          },
        }
      : {
          label: primaryLabel,
          variant: "solid",
          disabled: !question.optional && !filled[question.id],
          onClick: advance,
        };
    return [primary, { label: "Not now", variant: "secondary", title: "Hide this question", onClick: dismiss }];
  }, [advance, dismiss, filled, last, question, send]);

  const icon = useMemo(() => <ChatCircleText size={21} weight="duotone" />, []);

  useAppBanner(
    question
      ? {
          id: BANNER_ID,
          tone: "accent",
          icon,
          eyebrow: survey.questions.length > 1 ? `Quick question · ${step + 1} of ${survey.questions.length}` : "Quick question",
          title: question.question,
          detail: question.description ?? undefined,
          extra,
          actions,
        }
      : null,
    // One band behind situational suggestions: a suggestion that wants the
    // corner gets it, and the survey waits its turn.
    { placement: "suggestion", priority: APP_BANNER_PRIORITY.default },
  );

  return null;
}
