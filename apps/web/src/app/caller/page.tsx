import type { Metadata } from "next";
import { CallerPage } from "../../components/caller";
export const metadata: Metadata = { title: "Your call · NurseBridge", description: "Join your care team’s call queue and choose how to share the details for your call." };
export const dynamic = "force-dynamic";
export default function Page() { return <CallerPage />; }
