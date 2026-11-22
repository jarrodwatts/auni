/** Whether a search term names a field: the whole of it, or a whole word in it from three letters. */
export function matchesTerm(term: string, ...fields: string[]): boolean {
  const wanted = term.toLowerCase();
  return fields.some((field) => {
    const value = field.toLowerCase();
    return (
      value === wanted ||
      (wanted.length >= 3 && new RegExp(`\\b${escape(wanted)}\\b`, "u").test(value))
    );
  });
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
