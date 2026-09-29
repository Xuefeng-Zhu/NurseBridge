import Link from "next/link";

export default function NotFound() {
  return <section className="welcome-card" aria-labelledby="not-found-title">
    <div className="eyebrow">PAGE NOT FOUND</div>
    <h1 id="not-found-title">Let’s get you back.</h1>
    <p>This address doesn’t point to a NurseBridge page. Open the workspace guide to find your next step.</p>
    <Link className="button primary" href="/workspace">Open workspace guide</Link>
  </section>;
}
