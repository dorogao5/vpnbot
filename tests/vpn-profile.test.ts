import { describe, expect, it } from "vitest";
import { prepareVpnProfile } from "../src/vpn-profile.js";

const profile = Buffer.from(`client
dev tun
proto tcp-client
remote 192.0.2.10 54
<ca>
certificate
</ca>
`);

describe("prepareVpnProfile", () => {
  it("подменяет endpoint и блокирует IPv6", () => {
    const result = prepareVpnProfile(profile, {
      relay: { host: "198.51.100.10", port: 443 },
      blockIpv6: true,
    }).toString("utf8");

    expect(result).toContain("remote 198.51.100.10 443");
    expect(result).toContain("block-ipv6");
    expect(result).not.toContain("net_gateway");
    expect(result.indexOf("block-ipv6")).toBeLessThan(result.indexOf("<ca>"));
  });
});
