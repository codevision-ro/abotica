"use client";

import { SendHorizontalIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { answerQuestion } from "@/server/actions/inbox";

/** The choices an open question offers; `system` marks the platform's own (continue, redirect, cancel). */
export type QuestionChoices = { options: string[]; recommendation?: string; system?: string } | null;

/**
 * Answers an open question: one tap on an option, or the user's own words. The answer reaches the asker
 * at once; the question then leaves the inbox.
 */
export function QuestionAnswer({
  questionId,
  taskId,
  choices,
  className,
}: {
  questionId: string;
  taskId: string;
  choices: QuestionChoices;
  className?: string;
}) {
  const t = useTranslations("inbox.question");
  const [text, setText] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputId = useId();

  const label = (option: string) => {
    if (!choices?.system) return option;
    const key = `systemOptions.${option}` as Parameters<typeof t>[0];
    return t.has(key) ? t(key) : option;
  };

  function send(answer: string) {
    const value = answer.trim();
    if (!value || pending) return;
    setSending(value);
    startTransition(async () => {
      const res = await answerQuestion({ questionId, taskId, text: value });
      setSending(null);
      if (!res.ok) return void toast.error(res.error);
      setText("");
      toast.success(t("sent"));
    });
  }

  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      {choices?.options.length ? (
        <div className="flex flex-wrap gap-2">
          {choices.options.map((option) => (
            <Button
              key={option}
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => send(option)}
              className="h-auto min-h-8 max-w-full py-1.5 text-left whitespace-normal"
            >
              {pending && sending === option && <Spinner />}
              <span className="min-w-0 wrap-anywhere">{label(option)}</span>
              {option === choices.recommendation && (
                <Badge variant="secondary" className="shrink-0 bg-primary/10 text-primary">
                  {t("recommended")}
                </Badge>
              )}
            </Button>
          ))}
        </div>
      ) : null}
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          {t("label")}
        </label>
        <Textarea
          id={inputId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(text);
          }}
          placeholder={choices?.options.length ? t("placeholder") : t("label")}
          rows={1}
          className="min-h-9 flex-1 bg-background dark:bg-input/30"
        />
        <Button type="submit" size="sm" variant="outline" className="self-end" disabled={pending || !text.trim()}>
          {pending && sending === text.trim() ? <Spinner /> : <SendHorizontalIcon />}
          {t("send")}
        </Button>
      </form>
    </div>
  );
}
