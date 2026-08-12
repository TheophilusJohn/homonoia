import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { Observatory } from './ui/Observatory'
import './ui/observatory.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Observatory />
  </StrictMode>,
)
