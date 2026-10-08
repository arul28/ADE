import React from "react";
import type { GitHubIssueFormAnswers, GitHubIssueTemplate } from "../../../shared/githubIssueTemplates";
import { cn } from "../ui/cn";
import { toggle } from "./issueCreateChips";

/** An issue form's fields as native controls. */
export function GitHubIssueFormFields({
  template,
  answers,
  onChange,
}: {
  template: GitHubIssueTemplate;
  answers: GitHubIssueFormAnswers;
  onChange: (next: GitHubIssueFormAnswers) => void;
}) {
  const set = (index: number, value: GitHubIssueFormAnswers[number]) => onChange({ ...answers, [index]: value });
  return (
    <div className="mt-3 flex flex-col gap-4">
      {template.fields.map((field, index) => {
        if (field.type === "markdown") {
          return <p key={index} className="whitespace-pre-wrap text-[12px] text-[color:var(--kit-text-2)]">{field.value}</p>;
        }
        const heading = (
          <div className="mb-1 text-[12.5px] font-medium text-fg/90">
            {field.label}
            {"required" in field && field.required ? <span className="ml-1 text-[color:var(--kit-crit)]">*</span> : null}
            {field.description ? <div className="text-[11.5px] font-normal text-[color:var(--kit-text-3)]">{field.description}</div> : null}
          </div>
        );
        if (field.type === "input") {
          return (
            <label key={index} className="block">
              {heading}
              <input
                className="ade-dialog-input"
                placeholder={field.placeholder ?? undefined}
                value={String(answers[index] ?? "")}
                onChange={(event) => set(index, event.target.value)}
              />
            </label>
          );
        }
        if (field.type === "textarea") {
          return (
            <label key={index} className="block">
              {heading}
              <textarea
                className="ade-dialog-input !h-auto min-h-[88px] resize-y py-2"
                placeholder={field.placeholder ?? undefined}
                value={String(answers[index] ?? "")}
                onChange={(event) => set(index, event.target.value)}
              />
            </label>
          );
        }
        if (field.type === "dropdown") {
          const chosen = Array.isArray(answers[index]) ? answers[index] as string[] : [];
          return (
            <div key={index}>
              {heading}
              <div className="flex flex-wrap gap-1.5">
                {field.options.map((option) => {
                  const on = chosen.includes(option);
                  return (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={on}
                      className={cn(
                        "h-7 rounded-md border px-2 text-[11.5px]",
                        on ? "border-[color:var(--color-accent)] bg-[color:var(--kit-active)] text-fg" : "border-fg/[0.1] text-fg/80 hover:bg-[color:var(--kit-hover)]",
                      )}
                      onClick={() => set(index, field.multiple ? toggle(chosen, option) : on ? [] : [option])}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        }
        if (field.type !== "checkboxes") return null;
        const checked = Array.isArray(answers[index]) ? answers[index] as boolean[] : [];
        return (
          <div key={index}>
            {heading}
            <div className="flex flex-col gap-1">
              {field.options.map((option, optionIndex) => (
                <label key={option.label} className="flex items-start gap-2 text-[12px] text-fg/85">
                  <input
                    type="checkbox"
                    className="mt-[3px]"
                    checked={Boolean(checked[optionIndex])}
                    onChange={(event) => {
                      const next = [...checked];
                      next[optionIndex] = event.target.checked;
                      set(index, next);
                    }}
                  />
                  <span>
                    {option.label}
                    {option.required ? <span className="ml-1 text-[color:var(--kit-crit)]">*</span> : null}
                  </span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
