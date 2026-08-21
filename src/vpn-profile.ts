import { isIPv4 } from "node:net";
import type { VpnProfileOptions } from "./config.js";
import { normalizeBypassDomain } from "./bypass-domain.js";

export function prepareVpnProfile(
  profile: Buffer,
  options: VpnProfileOptions
): Buffer {
  let text = profile.toString("utf8");

  if (options.relay) {
    let replaced = false;
    text = text.replace(
      /^remote[ \t]+\S+[ \t]+\d+(?:[ \t]+\S+)?[ \t]*\r?$/gm,
      () => {
        replaced = true;
        return `remote ${options.relay!.host} ${options.relay!.port}`;
      }
    );
    if (!replaced) throw new Error("В OpenVPN-профиле отсутствует remote");
  }

  const directives: string[] = [];
  if (options.blockIpv6 && !/^block-ipv6\s*$/m.test(text)) {
    directives.push("block-ipv6");
  }
  for (const route of options.bypassRoutes) {
    const parsed = parseIpv4Route(route);
    const directive = `route ${parsed.network} ${parsed.netmask} net_gateway`;
    if (!text.includes(directive)) directives.push(directive);
  }
  for (const value of options.bypassDomains) {
    const domain = normalizeBypassDomain(value);
    const directive = `route ${domain} 255.255.255.255 net_gateway`;
    if (!text.includes(directive)) directives.push(directive);
  }

  if (directives.length > 0) {
    const insertion = `${directives.join("\n")}\n`;
    const inlineBlock = text.search(/^<(?:ca|cert|key|tls-auth|tls-crypt)>\s*$/m);
    text = inlineBlock === -1
      ? `${text.trimEnd()}\n${insertion}`
      : `${text.slice(0, inlineBlock)}${insertion}${text.slice(inlineBlock)}`;
  }

  return Buffer.from(text, "utf8");
}

function parseIpv4Route(value: string): { network: string; netmask: string } {
  const [address, prefixText = "32", ...rest] = value.split("/");
  if (rest.length > 0 || !address || !isIPv4(address)) {
    throw new Error(`Некорректный IPv4-маршрут: ${value}`);
  }
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Некорректная маска IPv4-маршрута: ${value}`);
  }
  if (prefix === 0) {
    throw new Error("Маршрут 0.0.0.0/0 нельзя исключить из VPN");
  }

  const octets = address.split(".").map(Number);
  const raw = octets.reduce((result, octet) => (result << 8) | octet, 0) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return {
    network: numberToIpv4(raw & mask),
    netmask: numberToIpv4(mask),
  };
}

function numberToIpv4(value: number): string {
  return [24, 16, 8, 0]
    .map((shift) => (value >>> shift) & 0xff)
    .join(".");
}
