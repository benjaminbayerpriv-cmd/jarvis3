export type ChatMeta = { title?: string; folder?: string; auto?: boolean; provisional?: boolean };

export function needsChatTitle(meta: ChatMeta | undefined) {
  return meta?.auto === true && (meta.provisional === true ||
    meta.provisional === undefined && (meta.title === "Neuer Chat" || !!meta.title?.includes(" · ")));
}

export function visibleChatTitle(meta: ChatMeta | undefined) {
  const title = meta?.title;
  return title && needsChatTitle(meta) ? title.replaceAll(" · ", " ") : title;
}

export function titleExcerpt(text: string, limit: number) {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function provisionalChatTitle(text: string) {
  const excerpt = titleExcerpt(text, 81);
  if (excerpt.length <= 80) return excerpt || "Neuer Chat";
  const end = excerpt.lastIndexOf(" ", 79);
  return excerpt.slice(0, end > 0 ? end : 79).trimEnd() + "…";
}

export function parseChatTitle(text: string) {
  const title = text.split("\n").map(line => line.trim()).filter(Boolean)[0]
    ?.replace(/^["„“'`*#\s]+|["“”'`*.\s]+$/g, "")
    .replace(/^(?:Titel|Title)\s*:\s*/i, "");
  return title && title.length >= 3 && title.length <= 60 && title.split(/\s+/).length <= 8
    && !/[!?]$/.test(title) && !title.includes(" · ") && title !== "Neuer Chat" ? title : null;
}
