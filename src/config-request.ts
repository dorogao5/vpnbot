export const CONFIG_REQUEST_NOTE_MAX_LENGTH = 100;

export function normalizeConfigRequestNote(value: string): string | null {
  const note = value.replace(/\s+/g, " ").trim();
  return note && Array.from(note).length <= CONFIG_REQUEST_NOTE_MAX_LENGTH
    ? note
    : null;
}
