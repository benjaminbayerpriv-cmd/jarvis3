import { expect, test } from "bun:test";
import { needsChatTitle, parseChatTitle, provisionalChatTitle, visibleChatTitle } from "./chat-title";

test("alte Ersatztitel bleiben vorläufig, manuelle und fertige Titel bleiben erhalten", () => {
  const legacy = { title: "Video · Speichern", auto: true };
  expect(needsChatTitle(legacy)).toBe(true);
  expect(visibleChatTitle(legacy)).toBe("Video Speichern");
  expect(needsChatTitle({ title: "Neuer Chat", auto: true })).toBe(true);
  expect(needsChatTitle({ title: "SC Freiburg Tickets prüfen", auto: true })).toBe(false);
  expect(needsChatTitle({ title: "Hier aushelfen", auto: true, provisional: true })).toBe(true);
  const manual = { ...legacy, auto: false };
  expect(needsChatTitle(manual)).toBe(false);
  expect(visibleChatTitle(manual)).toBe(legacy.title);
});

test("vorläufige Titel behalten die natürliche Schreibweise", () => {
  expect(provisionalChatTitle("  Klicke in Discord   auf mein Profilbild. ")).toBe("Klicke in Discord auf mein Profilbild.");
  expect(provisionalChatTitle("")).toBe("Neuer Chat");
});

test("ungültige Modelltitel können durch ein anderes Modell ersetzt werden", () => {
  expect(parseChatTitle("**Titel: Discord-Profil öffnen**")).toBe("Discord-Profil öffnen");
  expect(parseChatTitle("")).toBeNull();
  expect(parseChatTitle("Discord · Profil · Öffnen")).toBeNull();
  expect(parseChatTitle("Kann ich dir helfen?")).toBeNull();
});
