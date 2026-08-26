import type { VpnProfileOptions } from "./config.js";

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

  if (directives.length > 0) {
    const insertion = `${directives.join("\n")}\n`;
    const inlineBlock = text.search(/^<(?:ca|cert|key|tls-auth|tls-crypt)>\s*$/m);
    text = inlineBlock === -1
      ? `${text.trimEnd()}\n${insertion}`
      : `${text.slice(0, inlineBlock)}${insertion}${text.slice(inlineBlock)}`;
  }

  return Buffer.from(text, "utf8");
}
