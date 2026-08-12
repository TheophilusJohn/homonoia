import { useEffect, useState } from 'react'

/**
 * Two pages, so two pages' worth of router.
 *
 * React Router is not a dependency of this project and would be a large one to
 * add for a field and a reading page. This is `pushState` plus a `popstate`
 * listener; links stay real `<a href>` elements so middle-click, open-in-new-tab
 * and copy-link-address all behave. `public/_redirects` gives Cloudflare Pages
 * the SPA fallback that makes /about resolve on a cold load.
 */

export type Route = '/' | '/about'

function readRoute(): Route {
  return window.location.pathname.replace(/\/+$/, '') === '/about' ? '/about' : '/'
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(readRoute)

  useEffect(() => {
    const sync = () => setRoute(readRoute())
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [])

  return route
}

/**
 * Navigate, keeping the query string.
 *
 * `?field=webgl` selects the renderer, and losing it on every navigation would
 * quietly drop the reader back to the default field on the way back.
 */
export function navigate(to: Route): void {
  window.history.pushState(null, '', to + window.location.search)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function hrefFor(to: Route): string {
  return to + window.location.search
}

/** Let the browser handle anything that is not a plain left-click. */
export function shouldIntercept(event: React.MouseEvent): boolean {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
}
