import { isIP } from "node:net";
import { domainToASCII } from "node:url";

export function normalizeBypassDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed || trimmed.includes("://") || /[\s/:*?#]/.test(trimmed)) {
    throw new Error(`Некорректный домен: ${value}`);
  }
  const domain = domainToASCII(trimmed).toLowerCase();
  if (!domain || domain.length > 253 || isIP(domain)) {
    throw new Error(`Некорректный домен: ${value}`);
  }
  const labels = domain.split(".");
  if (labels.some((label) =>
    !label ||
    label.length > 63 ||
    !/^[a-z0-9-]+$/.test(label) ||
    label.startsWith("-") ||
    label.endsWith("-")
  )) {
    throw new Error(`Некорректный домен: ${value}`);
  }
  return domain;
}
