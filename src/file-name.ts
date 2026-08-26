const CLIENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function vpnFileName(clientName: string): string {
  if (!CLIENT_NAME.test(clientName)) {
    throw new Error("Недопустимое техническое имя VPN-конфига");
  }
  return `${clientName}.ovpn`;
}

export function labeledVpnFileName(
  displayName: string,
  clientName: string
): string {
  const technicalName = vpnFileName(clientName);
  const safeLabel = displayName
    .normalize("NFKC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 60)
    .trim();
  return safeLabel ? `${safeLabel} — ${technicalName}` : technicalName;
}
