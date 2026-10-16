import type { NetworkRouteObservation } from "./api/types";
export const routeChannels: Record<string, string> = {
  vpn: "内网 / VPN",
  public: "公网备用",
  configured: "原配置地址",
};
export const easyTierLabels: Record<string, string> = {
  p2p: "EasyTier · P2P 直连",
  relay: "EasyTier · 中继",
  not_detected: "未检测到 EasyTier 路径",
  unknown: "EasyTier 路径未知",
};
export const routeReasons: Record<string, string> = {
  VPN_ADDRESS_NOT_CONFIGURED: "未配置设备内网 IP，使用 SSH 接入地址",
  VPN_UNREACHABLE: "内网连接失败，使用公网备用",
  VPN_RECOVERY_WAITING_IDLE: "内网已恢复，等待任务和终端结束后切回",
};
export function routeDescription(
  r: NetworkRouteObservation | null | undefined,
) {
  return r
    ? `${routeChannels[r.channel] ?? r.channel} · ${easyTierLabels[r.easytier.state] ?? "路径未知"}`
    : "尚未检测";
}
