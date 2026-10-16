/** Clipboard API needs a secure context; plain HTTP can use a user-initiated copy. */
export async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* Try the HTTP fallback. */
    }
  }
  const previous = document.activeElement as HTMLElement | null;
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.cssText = "position:fixed;left:-10000px;top:0";
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
  } finally {
    input.remove();
    previous?.focus();
  }
}
