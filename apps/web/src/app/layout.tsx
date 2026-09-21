import type { Metadata } from "next";
import "@fontsource/source-sans-3/400.css";
import "@fontsource/source-sans-3/500.css";
import "@fontsource/source-sans-3/600.css";
import "@fontsource/source-sans-3/700.css";
import "./globals.css";
import { Shell, WorkspaceProvider } from "../components/workspace";

export const metadata: Metadata = { title: "NurseBridge · The intake workspace", description: "A synthetic demonstration of evidence-linked voice intake and human handoff. Not for medical care.", icons: { icon: "/favicon.svg" } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><a className="skip-link" href="#main-content">Skip to main content</a><WorkspaceProvider><Shell>{children}</Shell></WorkspaceProvider></body></html>;
}
