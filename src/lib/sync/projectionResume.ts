import type { ProjectionPause, ProjectionStateMap } from './projectionState'

/**
 * The connection facts the projection resume decision needs.
 *
 * `connectionType` is the Network Information API's `type`. Most browsers do
 * not expose it; when it is absent we only refuse a known cellular link or a
 * slow effective connection. Treating "unknown" as metered would prompt on
 * every Safari/Firefox Wi-Fi download, while treating it as unmetered keeps
 * the existing dictionary policy consistent.
 */
export type ProjectionNetwork = {
  online: boolean
  saveData: boolean
  effectiveType?: string
  connectionType?: string
}

const SLOW_EFFECTIVE_TYPES = new Set(['slow-2g', '2g', '3g'])

/** Silent auto-resume is allowed only on a connection we can treat as unmetered. */
export function shouldAutoResumeProjection(network: ProjectionNetwork): boolean {
  if (!network.online || network.saveData) return false
  if (network.connectionType === 'cellular') return false
  if (network.effectiveType && SLOW_EFFECTIVE_TYPES.has(network.effectiveType)) return false
  return true
}

/**
 * How long until a paused projection may retry, or null when the pause waits
 * for an explicit event (a byte cap, offline, or an error).
 *
 * A quota/state pause persists its retry time in device-local metadata so a
 * reload does not lose the server's window. Zero means the window is over.
 */
export function pauseRetryDelayMs(
  pause: ProjectionPause | undefined,
  now = Date.now(),
): number | null {
  if (pause === undefined) return null
  if (pause.reason !== 'quota' && pause.reason !== 'state') return null
  if (pause.nextAttemptAt === null) return null
  const retryAt = Date.parse(pause.nextAttemptAt)
  if (Number.isNaN(retryAt)) return null
  return Math.max(0, retryAt - now)
}

/**
 * Whether the user may explicitly continue now. Byte/offline/error pauses have
 * no server window. Quota/state pauses expose the button only after the
 * persisted retry time, so an early tap cannot spend another denied request.
 */
export function pauseCanResume(
  pause: ProjectionPause | undefined,
  now = Date.now(),
): boolean {
  if (pause === undefined) return true
  const delay = pauseRetryDelayMs(pause, now)
  return delay === null || delay === 0
}

type NetworkInformationLike = {
  saveData?: boolean
  effectiveType?: string
  type?: string
}

type NavigatorLike = {
  onLine?: boolean
  connection?: NetworkInformationLike
}

/**
 * Reads the browser's connection facts without assuming the API exists.
 * `onLine !== false` matches the rest of the app: a missing flag is not proof
 * that the device is offline.
 */
export function projectionNetworkFrom(source: NavigatorLike | undefined): ProjectionNetwork {
  const connection = source?.connection
  return {
    online: source?.onLine !== false,
    saveData: connection?.saveData === true,
    effectiveType: connection?.effectiveType,
    connectionType: connection?.type,
  }
}

export function currentProjectionNetwork(): ProjectionNetwork {
  if (typeof navigator === 'undefined') {
    return { online: false, saveData: false }
  }
  return projectionNetworkFrom(navigator as Navigator & NavigatorLike)
}

/**
 * Whether a visibility/online event should start a sync to resume a pause.
 * A pause that has no persisted `nextAttemptAt` is due immediately; quota and
 * state pauses wait for their window.
 */
export function shouldResumePausedProjection(
  states: ProjectionStateMap,
  network: ProjectionNetwork,
  now = Date.now(),
): boolean {
  if (!shouldAutoResumeProjection(network)) return false
  return Object.values(states).some((state) => {
    if (state.pause === undefined) return false
    return (pauseRetryDelayMs(state.pause, now) ?? 0) === 0
  })
}
