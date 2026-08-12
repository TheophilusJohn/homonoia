import type { EventView } from './viewModel'

/**
 * The trace, rendered. Monospace, newest at the bottom, capped by the feed.
 * Items slide in once and are otherwise still — this panel is for reading, not
 * for watching.
 */

interface Props {
  readonly events: readonly EventView[]
}

export function EventStream({ events }: Props) {
  return (
    <div className="stream" role="log" aria-label="Event stream" aria-live="polite">
      {events.map((event) => (
        <div className="ev" key={event.key} data-tone={event.tone}>
          <b>{String(event.tick).padStart(5, '0')}</b> {event.text}
        </div>
      ))}
    </div>
  )
}
