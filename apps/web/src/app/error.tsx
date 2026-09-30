"use client";

import Link from "next/link";
import { useWorkspace } from "../components/workspace";

export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { session } = useWorkspace();
  const caller = session?.role === "caller";
  return <section className="welcome-card" aria-labelledby="page-error-title">
    <div className="eyebrow">WORKSPACE CONNECTION</div>
    <h1 id="page-error-title">This view couldn’t open.</h1>
    <p role="alert">Something interrupted this page. Try opening it again. If you were on a call, check its connection before continuing.</p>
    <button className="button primary" onClick={reset}>Try again</button>
    <Link className="text-link" href={caller ? "/caller" : "/nurse"}>{caller ? "Return to your call" : "Return to the call queue"}</Link>
  </section>;
}
