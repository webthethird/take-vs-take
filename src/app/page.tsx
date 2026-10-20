// Server component: runs on the server at request time, so it can read the
// fixture files directly. It passes plain data to the client component.

import { listDemoPairs } from "../server/posts.js";
import { Comparer } from "./comparer.js";

export const dynamic = "force-dynamic";

export default async function Page() {
  const pairs = await listDemoPairs();
  return (
    <main>
      <header className="masthead">
        <h1>Take vs. Take</h1>
        <p>
          Paste two X posts. Each is turned into a hypothetical long-only portfolio <em>on its own</em>, without seeing the other. Then both are compared
          over the same period: how the opinions relate, what the portfolios share, and whether they tend to move together.
        </p>
      </header>
      <Comparer pairs={pairs} />
    </main>
  );
}
