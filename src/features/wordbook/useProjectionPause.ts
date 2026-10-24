import { useEffect, useState } from 'react'

import type { ProjectionPause } from '../../lib/sync/projectionState'
import { pauseCanResume, pauseRetryDelayMs } from '../../lib/sync/projectionResume'

/**
 * Re-renders when a persisted quota/state window elapses. The button stays
 * hidden until the server's window is over; the sync timer may resume earlier
 * on an allowed connection.
 */
export function useProjectionPauseReady(pause: ProjectionPause | undefined): boolean {
  // Derive readiness from the clock instead of setting state synchronously in
  // an effect. The timer only advances the clock when a window actually ends.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const delay = pauseRetryDelayMs(pause, now)
    if (delay === null || delay === 0) return
    const timer = setTimeout(() => setNow(Date.now()), delay + 50)
    return () => clearTimeout(timer)
  }, [pause, now])

  return pauseCanResume(pause, now)
}
