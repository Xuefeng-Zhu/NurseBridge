"use client";

import Link from "next/link";

export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <section className="welcome-card" aria-labelledby="page-error-title">
    <div className="eyebrow">WORKSPACE CONNECTION</div>
    <h1 id="page-error-title">This view couldn’t open.</h1>
    <p role="alert">Something interrupted this page. Try opening it again. If you were on a call, check its connection before continuing.</p>
    <button className="button primary" onClick={reset}>Try again</button>
    <Link className="text-link" href="/workspace">Return to the workspace guide</Link>
  </section>;
}
