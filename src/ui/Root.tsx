import { About } from './About'
import { Observatory } from './Observatory'
import { useRoute } from './router'

/** The field, or the page that explains it. */
export function Root() {
  return useRoute() === '/about' ? <About /> : <Observatory />
}
