let bootDraft = "";

export function setBootDraft(text: string): void {
  bootDraft = text;
}

export function consumeBootDraft(): string {
  const draft = bootDraft;
  bootDraft = "";
  return draft;
}
