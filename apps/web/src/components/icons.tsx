import type { CSSProperties } from "react";

export type IconName = "queue" | "phone" | "settings" | "play" | "arrow" | "check" | "clock" | "mic" | "mute" | "close" | "person" | "file" | "link" | "volume" | "warning" | "copy" | "refresh" | "trash" | "download";
const paths: Record<IconName, string[]> = {
  queue: ["M4 5h16v4H4zM4 15h16v4H4z", "M8 5v4m0 6v4"],
  phone: ["M5 3h4l2 5-3 2a16 16 0 0 0 6 6l2-3 5 2v4c0 1-1 2-2 2C10 21 3 14 3 5c0-1 1-2 2-2Z"],
  settings: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", "M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"],
  play: ["m9 5 11 7-11 7Z", "M4 4v16"],
  arrow: ["M4 12h16m-6-6 6 6-6 6"],
  check: ["m5 12 4 4L19 6"],
  clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 7v5l3 2"],
  mic: ["M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0Z", "M6 11v1a6 6 0 0 0 12 0v-1M12 18v4m-4 0h8"],
  mute: ["M9 9v3a3 3 0 0 0 5 2m1-6V5a3 3 0 0 0-6 0", "M6 11v1a6 6 0 0 0 10 4m2-5v1M12 18v4m-4 0h8M3 3l18 18"],
  close: ["m6 6 12 12M6 18 18 6"],
  person: ["M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", "M4 21v-3c0-3 3-5 8-5s8 2 8 5v3"],
  file: ["M5 3h9l5 5v13H5Z", "M14 3v6h5M8 13h8m-8 4h6"],
  link: ["m10 13 4-4", "m8 15-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"],
  volume: ["M3 9h4l5-4v14l-5-4H3Z", "M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"],
  warning: ["m12 3 10 18H2Z", "M12 9v5m0 3h.01"],
  copy: ["M9 9h12v12H9Z", "M15 5V3H3v12h2"],
  refresh: ["M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5", "M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"],
  trash: ["M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"],
  download: ["M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"],
};
export function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name].map((d, i) => <path d={d} key={i} />)}</svg>;
}
