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
  it("подменяет endpoint, блокирует IPv6 и добавляет обходящие маршруты", () => {
    const result = prepareVpnProfile(profile, {
      relay: { host: "198.51.100.10", port: 443 },
      bypassRoutes: ["203.0.113.9", "198.51.100.25/24"],
      bypassDomains: ["Example.COM", "xn--e1afmkfd.xn--p1ai"],
      blockIpv6: true,
    }).toString("utf8");

    expect(result).toContain("remote 198.51.100.10 443");
    expect(result).toContain("block-ipv6");
    expect(result).toContain("route 203.0.113.9 255.255.255.255 net_gateway");
    expect(result).toContain("route 198.51.100.0 255.255.255.0 net_gateway");
    expect(result).toContain("route example.com 255.255.255.255 net_gateway");
    expect(result).toContain("route xn--e1afmkfd.xn--p1ai 255.255.255.255 net_gateway");
    expect(result.indexOf("route 203.0.113.9")).toBeLessThan(result.indexOf("<ca>"));
  });

  it("не разрешает исключить весь интернет", () => {
    expect(() =>
      prepareVpnProfile(profile, {
        relay: undefined,
        bypassRoutes: ["0.0.0.0/0"],
        bypassDomains: [],
        blockIpv6: false,
      })
    ).toThrow("0.0.0.0/0");
  });
});
