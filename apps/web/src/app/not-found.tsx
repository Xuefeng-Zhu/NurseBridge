"use client";

import Link from "next/link";
import { useWorkspace } from "../components/workspace";

export default function NotFound() {
  const { session } = useWorkspace();
  const caller = session?.role === "caller";
  return <section className="welcome-card" aria-labelledby="not-found-title">
    <div className="eyebrow">PAGE NOT FOUND</div>
    <h1 id="not-found-title">Let’s get you back.</h1>
    <p>This address doesn’t point to a NurseBridge page. Return to {caller ? "your call" : "the call queue"} to continue.</p>
    <Link className="button primary" href={caller ? "/caller" : "/nurse"}>{caller ? "Return to your call" : "Open nurse workspace"}</Link>
  </section>;
}
