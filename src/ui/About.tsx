import './about.css'

import { hrefFor, navigate, shouldIntercept } from './router'

/**
 * A reading surface, not a control surface.
 *
 * Its one job is to make the running field legible to someone who has never
 * heard of Raft. It is deliberately not a description of the algorithm — the
 * README and the paper do that — and it holds itself to a single analogy, so a
 * reader finishes with one working mental model rather than six partial ones.
 *
 * Editorial layout: a single measure of prose at reading size, not the
 * instrument's 13px chrome. The legend below is built from the *same* `.dot`
 * and `.cell` classes the field and ledger use, so it cannot drift out of sync
 * with what is actually on screen — including the breathing on an uncommitted
 * cell.
 */
export function About() {
  const back = (event: React.MouseEvent) => {
    if (!shouldIntercept(event)) return
    event.preventDefault()
    navigate('/')
  }

  return (
    <div className="reader">
      <header className="reader-head">
        <a className="mark" href={hrefFor('/')} onClick={back}>
          Homo<em>noia</em>
        </a>
        <a className="reader-back" href={hrefFor('/')} onClick={back}>
          Back to the field
        </a>
      </header>

      <main className="prose">
        <h1>What you are looking at</h1>
        <p className="standfirst">
          Five machines trying to agree on one list, while the network loses their messages and
          they keep crashing. This page is two minutes on how to read the screen.
        </p>

        <h2>The notebook problem</h2>
        <p>
          Five people must keep identical notebooks. They sit in separate rooms and can only pass
          notes. Notes go missing, arrive late, or arrive twice. Anyone can walk out at any moment,
          and nobody else can tell whether they have left or are simply slow to reply.
        </p>
        <p>
          Every notebook must end up with the same entries in the same order — and once anyone has
          acted on an entry, it must never change.
        </p>

        <h2>Why that is hard</h2>
        <p>
          You cannot settle it by asking everyone, because someone is always out of the room. You
          cannot let everyone write, because two people would put different things in the same slot.
          And you cannot tell <em>gone</em> apart from <em>slow</em> — which is what makes this
          genuinely difficult rather than merely fiddly.
        </p>
        <p>Raft&rsquo;s answer is two rules: one person writes, and a majority is good enough.</p>

        <h2>The five circles</h2>
        <p>
          Each circle is a participant — a node. Only the amber one accepts new entries: it writes
          them in its own notebook first, then sends copies out. The travelling dots are those notes,
          amber for copies of entries and violet for election votes.
        </p>

        <ul className="legend">
          <li>
            <i className="dot" data-role="leader" aria-hidden="true" />
            <b>Leader</b> the designated writer
          </li>
          <li>
            <i className="dot" data-role="candidate" aria-hidden="true" />
            <b>Candidate</b> campaigning to become it
          </li>
          <li>
            <i className="dot" aria-hidden="true" />
            <b>Follower</b> copying what it is sent
          </li>
          <li>
            <i className="dot" data-role="dead" aria-hidden="true" />
            <b>Down</b> receiving nothing, sending nothing
          </li>
        </ul>

        <h2>The ledger</h2>
        <p>
          The panel on the right is the five notebooks, one row each, one cell per entry. The number
          in a cell is the <em>term</em> — which leader&rsquo;s era wrote it.
        </p>

        <ul className="legend">
          <li>
            <span className="cell" data-state="uncommitted" aria-hidden="true">
              4
            </span>
            <b>Uncommitted</b> written down, but not yet on enough notebooks. Still provisional; it
            can be replaced.
          </li>
          <li>
            <span className="cell" data-state="committed" aria-hidden="true">
              4
            </span>
            <b>Committed</b> a majority hold it. From this moment it never changes again, on any
            node, ever.
          </li>
        </ul>

        <p>
          Watching a column of outlines turn solid is the algorithm doing its one job. Three of five
          is a majority — a <em>quorum</em>. It is why the cluster survives two nodes going down, and
          why it stalls when three do.
        </p>

        <h2>Break it</h2>
        <p>
          Click a node to kill it. If it was the leader, watch the others notice the silence, hold an
          election and pick a new one; the term climbs by one on every attempt.
        </p>
        <p>
          Press <b>Partition</b> to cut the network in two. A rift opens, and notes crossing it come
          apart on the line. The side holding three keeps committing. The side holding two cannot —
          if the old leader is stranded there it will keep accepting entries quite happily, but they
          never go solid, because two is not a majority.
        </p>
        <p>
          Then heal it, and watch closely: the stranded side&rsquo;s provisional entries are thrown
          away and replaced by the majority&rsquo;s. Discarded, not merged. Nothing that had gone
          solid is ever lost.
        </p>

        <h2>Try this</h2>
        <ul className="tries">
          <li>
            Press <b>Demo</b> to run that partition story as a scripted sequence.
          </li>
          <li>Kill the leader while entries are still in flight.</li>
          <li>Push <b>Drop</b> to 40% and watch it still converge, just slower.</li>
          <li>
            Press <b>Pause</b>, then <b>Step</b>, to walk one tick at a time.
          </li>
        </ul>

        <p className="footnote">
          The algorithm is Ongaro and Ousterhout&rsquo;s{' '}
          <a href="https://raft.github.io/raft.pdf">In Search of an Understandable Consensus Algorithm</a>.
          The README covers this implementation, how it is tested, and what is deliberately missing.
        </p>

        <p className="return">
          <a href={hrefFor('/')} onClick={back}>
            Back to the field &rarr;
          </a>
        </p>
      </main>
    </div>
  )
}
