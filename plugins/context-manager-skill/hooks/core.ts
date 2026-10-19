// Pure logic for Claude Context Manager Skill: settings, thresholds, text.
// No engine calls here, so it behaves the same on every OS and surface.

export const MARKER = '<!-- handoff-complete -->'
export const FORCE_WINDOW_MS = 120_000
export const STARTUP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
export const SETTINGS_FILE = 'context-manager.json'

export type Settings = {
  enabled: boolean
  prep_at: number
  compact_at: number
  force_at: number
  auto_compact: boolean
  show_meter: boolean
  gate_manual: boolean
  offer_on_startup: boolean
  offer_options: boolean
  preflight_check: boolean
  handoff_dir: string
}

export type SettingKey = keyof Settings
export type Source = 'default' | 'plugin options' | 'user file' | 'project file' | 'this session'
export type Resolved = { values: Settings; sources: Record<SettingKey, Source>; problems: string[] }

export const DEFAULTS: Settings = {
  enabled: true,
  prep_at: 130_000,
  compact_at: 150_000,
  force_at: 300_000,
  auto_compact: true,
  show_meter: true,
  gate_manual: true,
  offer_on_startup: true,
  offer_options: true,
  preflight_check: true,
  handoff_dir: '.claude/context-manager/handoffs',
}

export const KEYS = Object.keys(DEFAULTS) as SettingKey[]

/** Parses one setting: numbers accept 150000, "150k", "1.2m"; booleans accept true/false/yes/no/on/off/1/0. */
export function parseSetting(key: SettingKey, raw: unknown): Settings[SettingKey] | undefined {
  const template = DEFAULTS[key]
  if (raw === null || raw === undefined) return undefined
  if (typeof template === 'boolean') {
    if (typeof raw === 'boolean') return raw
    const s = String(raw).trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(s)) return true
    if (['false', '0', 'no', 'off'].includes(s)) return false
    return undefined
  }
  if (typeof template === 'number') {
    if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : undefined
    const s = String(raw).replace(/[,_\s]/g, '').toLowerCase()
    const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(s)
    if (!m) return undefined
    const n = Number(m[1]) * (m[2] === 'k' ? 1_000 : m[2] === 'm' ? 1_000_000 : 1)
    return n > 0 ? Math.round(n) : undefined
  }
  const s = String(raw).trim()
  return s === '' ? undefined : s
}

/** Layers settings: defaults < plugin options < user file < project file < this session. */
export function resolveSettings(layers: {
  options?: Readonly<Record<string, unknown>>
  user?: unknown
  project?: unknown
  session?: unknown
}): Resolved {
  const values = { ...DEFAULTS } as Record<SettingKey, unknown>
  const sources = Object.fromEntries(KEYS.map(k => [k, 'default'])) as Record<SettingKey, Source>
  const problems: string[] = []

  const apply = (layer: unknown, source: Source) => {
    if (layer === undefined || layer === null) return
    if (typeof layer !== 'object' || Array.isArray(layer)) {
      problems.push(`${source} is not a JSON object; ignored`)
      return
    }
    for (const [k, raw] of Object.entries(layer as Record<string, unknown>)) {
      if (!(KEYS as string[]).includes(k)) continue
      const key = k as SettingKey
      const v = parseSetting(key, raw)
      if (v === undefined) {
        problems.push(`${source}: ${key} = ${JSON.stringify(raw)} is not valid; ignored`)
        continue
      }
      // A plugin option equal to the built-in default is the engine filling in the default, not a choice.
      if (source === 'plugin options' && v === DEFAULTS[key]) continue
      values[key] = v
      sources[key] = source
    }
  }

  apply(layers.options, 'plugin options')
  apply(layers.user, 'user file')
  apply(layers.project, 'project file')
  apply(layers.session, 'this session')

  const s = values as Settings
  if (!(s.prep_at < s.compact_at)) problems.push(`prep_at (${formatK(s.prep_at)}) should be below compact_at (${formatK(s.compact_at)})`)
  if (!(s.compact_at < s.force_at)) problems.push(`compact_at (${formatK(s.compact_at)}) should be below force_at (${formatK(s.force_at)})`)
  return { values: s, sources, problems }
}

/** Parses a JSON settings file's text; returns undefined plus a problem for invalid JSON. */
export function parseJsonFile(text: string, label: string): { value?: unknown; problem?: string } {
  if (text.trim() === '') return {}
  try {
    return { value: JSON.parse(text) }
  } catch {
    return { problem: `${label} is not valid JSON; ignored` }
  }
}

export function formatK(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  return `${Math.round(n / 1000)}k`
}

export function formatValue(v: unknown): string {
  return typeof v === 'number' ? formatK(v) : String(v)
}

export function formatAge(ms: number): string {
  const s = Math.max(0, ms / 1000)
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 172_800) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} days ago`
}

/** Joins path parts with forward slashes, which every OS's file APIs accept. */
export function joinPath(...parts: string[]): string {
  return parts
    .filter(p => p !== '')
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('/')
}

export function isAbsolute(p: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(p)
}

export function handoffDir(root: string, s: Settings): string {
  return isAbsolute(s.handoff_dir) ? s.handoff_dir : joinPath(root, s.handoff_dir)
}

export function handoffFile(root: string, s: Settings, sessionId: string): string {
  return joinPath(handoffDir(root, s), `handoff-${sessionId}.md`)
}

export type HandoffState = 'missing' | 'started' | 'complete'

export function handoffState(text: string | undefined): HandoffState {
  if (text === undefined || text.trim() === '') return 'missing'
  return text.includes(MARKER) ? 'complete' : 'started'
}

export type Phase = 'unknown' | 'below-prep' | 'handoff-due' | 'ready-below-compact' | 'ready-to-compact'

export function phaseOf(tokens: number | undefined, state: HandoffState, s: Settings): Phase {
  if (tokens === undefined) return 'unknown'
  if (tokens < s.prep_at) return 'below-prep'
  if (state !== 'complete') return 'handoff-due'
  return tokens < s.compact_at ? 'ready-below-compact' : 'ready-to-compact'
}

export type GateDecision = { allow: true; reason?: string } | { allow: false; reason: string }

/** Decides whether a compaction may run. `lastManualBlockAt` drives "run /compact again to force". */
export function gateCompaction(args: {
  trigger: 'manual' | 'auto' | 'plugin' | 'precompute'
  tokens: number | undefined
  state: HandoffState
  s: Settings
  now: number
  lastManualBlockAt?: number
}): GateDecision {
  const { trigger, tokens, state, s, now, lastManualBlockAt } = args
  if (!s.enabled) return { allow: true }
  if (trigger === 'plugin') return { allow: true }
  if (trigger === 'manual') {
    if (!s.gate_manual || state === 'complete') return { allow: true }
    if (lastManualBlockAt !== undefined && now - lastManualBlockAt <= FORCE_WINDOW_MS) {
      return { allow: true, reason: 'Compacting without a handoff, as requested.' }
    }
    return {
      allow: false,
      reason:
        'Context manager: no handoff saved yet. Ask Claude to run /context-manager-skill:prep-compact first, ' +
        'or run /compact again within 2 minutes to compact anyway.',
    }
  }
  // auto and precompute
  if (tokens !== undefined && tokens >= s.force_at) return { allow: true, reason: `Past the ${formatK(s.force_at)} safety limit.` }
  if (tokens !== undefined && tokens < s.compact_at) {
    return { allow: false, reason: `Context manager: holding compaction until ~${formatK(s.compact_at)}.` }
  }
  if (state !== 'complete') return { allow: false, reason: 'Context manager: compaction held until Claude saves a handoff.' }
  return { allow: true }
}

export function prepNote(tokens: number, s: Settings, path: string): string {
  return (
    `Context manager status: this session's context is about ${formatK(tokens)} tokens, past the user's ` +
    `${formatK(s.prep_at)} preparation threshold (compaction at ${formatK(s.compact_at)}). ` +
    `Per the user's context-manager workflow, the compaction handoff for this session has not been written yet. ` +
    `Its path is ${path}. Compaction is held until that file ends with the line ${MARKER}. ` +
    `The user's workflow is to run the context-manager-skill:prep-compact skill first, confirm in one line that the ` +
    `handoff is ready, then carry on with the request.`
  )
}

export function readyNote(tokens: number, s: Settings, path: string): string {
  return (
    `Context manager status: context is about ${formatK(tokens)} tokens. The handoff at ${path} is complete; ` +
    `decisions made before compaction at ${formatK(s.compact_at)} belong in it too, keeping ${MARKER} as its last line.`
  )
}

export function restoreNote(path: string, text: string): string {
  const max = 9000
  const body = text.length > max ? `${text.slice(0, max)}\n[...truncated; full handoff at ${path}]` : text
  return `This session was just compacted. Before compaction, Claude saved this handoff (archived at ${path}):\n\n${body}`
}

export function startupNote(path: string, savedAt: string): string {
  return (
    `Context manager: the most recent compaction handoff in this project is ${path}, saved ${savedAt}. ` +
    `It records where earlier work left off and is worth reading if the user wants to continue that work.`
  )
}

export function archiveName(sessionId: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `handoff-${sessionId}.used-${stamp}.md`
}

export function meterText(tokens: number | undefined, window: number | undefined, phase: Phase, s: Settings): string {
  if (tokens === undefined) return 'Context: waiting for the first reply'
  const pct = window ? ` (${Math.round((tokens / window) * 100)}%)` : ''
  const head = `Context ${formatK(tokens)}${window ? ` / ${formatK(window)}` : ''}${pct}`
  switch (phase) {
    case 'below-prep':
      return `${head} · handoff at ${formatK(s.prep_at)}, compact at ${formatK(s.compact_at)}`
    case 'handoff-due':
      return `${head} · handoff due now`
    case 'ready-below-compact':
      return `${head} · handoff saved · compact at ${formatK(s.compact_at)}`
    case 'ready-to-compact':
      return `${head} · handoff saved · ${s.auto_compact ? 'compacting after this turn' : 'ready: type /compact'}`
    default:
      return head
  }
}

// ---------- options picker ----------

/** What Claude judged about the work when it offers options. */
export type Situation = 'mid_task' | 'near_done' | 'delicate_step' | 'topic_switch' | 'preflight_overflow'
export const SITUATIONS: readonly Situation[] = ['mid_task', 'near_done', 'delicate_step', 'topic_switch', 'preflight_overflow']

/** Everything the picker can run. */
export type ActionId = 'auto' | 'compact_now' | 'finish_step' | 'fresh_session' | 'continue_fresh' | 'expand' | 'review' | 'snooze'
export const ACTION_IDS: readonly ActionId[] = ['auto', 'compact_now', 'finish_step', 'fresh_session', 'continue_fresh', 'expand', 'review', 'snooze']

export type OfferKind = 'handoff' | 'preflight'

export type Offer = {
  kind: OfferKind
  situation: Situation
  reason: string
  actions: ActionId[] // recommended first
  estimate?: number
  expandTo?: number // the compact_at "expand" would set for this session
  createdAt: number
}

export const SNOOZE_STEP = 100_000
const EXPAND_HEADROOM = 1.15
const EXPAND_CAP = 0.85 // never plan to fill more than 85% of the window

const HANDOFF_ACTIONS: ActionId[] = ['auto', 'compact_now', 'finish_step', 'fresh_session', 'continue_fresh', 'review', 'snooze']
const PREFLIGHT_ACTIONS: ActionId[] = ['expand', 'continue_fresh', 'auto']

const DEFAULT_RECOMMENDATION: Record<Situation, ActionId> = {
  mid_task: 'auto',
  near_done: 'fresh_session',
  delicate_step: 'finish_step',
  topic_switch: 'fresh_session',
  preflight_overflow: 'expand',
}

/** The compact_at that would fit `estimate` more tokens from `tokens`, rounded up to 10k; undefined when it can't fit. */
export function expandTarget(tokens: number, estimate: number, window: number, s: Settings): number | undefined {
  const need = Math.ceil((tokens + estimate * EXPAND_HEADROOM) / 10_000) * 10_000
  const target = Math.max(s.compact_at, need)
  return target <= Math.floor(window * EXPAND_CAP) ? target : undefined
}

/** The session-only thresholds "expand" writes: keeps the gap between prep_at and compact_at. */
export function expandedSettings(target: number, s: Settings): Partial<Settings> {
  const gap = Math.max(10_000, s.compact_at - s.prep_at)
  return { prep_at: Math.max(10_000, target - gap), compact_at: target, force_at: Math.max(s.force_at, target + SNOOZE_STEP) }
}

export function isSituation(v: unknown): v is Situation {
  return typeof v === 'string' && (SITUATIONS as readonly string[]).includes(v)
}

export function isActionId(v: unknown): v is ActionId {
  return typeof v === 'string' && (ACTION_IDS as readonly string[]).includes(v)
}

/** Builds the picker: which actions apply, recommended first. */
export function buildOffer(args: {
  kind: OfferKind
  situation: Situation
  recommended?: ActionId
  reason?: string
  estimate?: number
  tokens?: number
  window: number
  s: Settings
  now: number
}): Offer {
  const { kind, situation, s, window, now } = args
  let actions = [...(kind === 'preflight' ? PREFLIGHT_ACTIONS : HANDOFF_ACTIONS)]
  let expandTo: number | undefined
  if (kind === 'preflight') {
    expandTo = args.tokens !== undefined && args.estimate !== undefined ? expandTarget(args.tokens, args.estimate, window, s) : undefined
    if (expandTo === undefined) actions = actions.filter(a => a !== 'expand')
  }
  let first: ActionId = args.recommended && actions.includes(args.recommended) ? args.recommended : DEFAULT_RECOMMENDATION[situation]
  if (!actions.includes(first)) first = actions[0] ?? 'auto'
  actions = [first, ...actions.filter(a => a !== first)]
  const reason =
    args.reason?.trim() ||
    (kind === 'preflight' ? 'The planned work may not fit before compaction.' : 'A handoff is saved.')
  return { kind, situation, reason: reason.slice(0, 160), actions, estimate: args.estimate, expandTo, createdAt: now }
}

export function actionLabel(a: ActionId, offer: Offer | undefined, s: Settings): string {
  switch (a) {
    case 'auto':
      return offer?.kind === 'preflight' ? `Go ahead; compact at ${formatK(s.compact_at)} if needed` : `Keep going; compact at ${formatK(s.compact_at)}`
    case 'compact_now':
      return 'Compact now'
    case 'finish_step':
      return 'Finish this step, then compact'
    case 'fresh_session':
      return 'Start a fresh session'
    case 'continue_fresh':
      return 'Continue in a fresh session'
    case 'expand':
      return offer?.expandTo ? `Raise this session's limit to ${formatK(offer.expandTo)}` : "Raise this session's limit"
    case 'review':
      return 'Review the handoff'
    case 'snooze':
      return `Snooze: +${formatK(SNOOZE_STEP)} for this project`
  }
}

export const ACTION_HELP: Record<ActionId, string> = {
  auto: 'carry on; the plugin compacts automatically at the threshold',
  compact_now: 'compact as soon as the current turn ends',
  finish_step: 'Claude finishes the current step, updates the handoff, then the plugin compacts',
  fresh_session: 'the task is done or the topic changes: clear the session; the next one is pointed at the handoff',
  continue_fresh: 'save the handoff, clear the session, and automatically ask the new one to continue from it',
  expand: "raise only this session's thresholds so the planned work fits (larger context costs more per turn)",
  review: 'Claude summarises the handoff and asks what to change',
  snooze: "raise this project's thresholds by 100k",
}

export function offerChoicesText(offer: Offer, s: Settings): string {
  return offer.actions
    .map((a, i) => `${i + 1}. ${actionLabel(a, offer, s)}${i === 0 ? ' (recommended)' : ''} [option "${a}"]: ${ACTION_HELP[a]}`)
    .join('\n')
}

export function preflightNote(tokens: number, s: Settings, toolName: string): string {
  const room = Math.max(0, s.compact_at - tokens)
  return (
    `Context manager budget: this session's context is about ${formatK(tokens)} tokens and compaction is set for ` +
    `${formatK(s.compact_at)}, leaving about ${formatK(room)} of room. Per the user's context-manager workflow, ` +
    `before starting the tasks just planned, estimate how many tokens of context they will add (file reads, edits, ` +
    `tool output). If they are likely to exceed the room, call ${toolName} with action "offer", kind "preflight", ` +
    `situation "preflight_overflow", estimate_tokens and a one-sentence reason, and follow its result before starting. ` +
    `If they fit, carry on without mentioning this.`
  )
}

export function continuePrompt(path: string): string {
  return (
    `Continue the work from the previous session. First read the handoff at ${path}, ` +
    `then carry on from its Next steps.`
  )
}

export function snoozed(s: Settings): Partial<Settings> {
  return { prep_at: s.prep_at + SNOOZE_STEP, compact_at: s.compact_at + SNOOZE_STEP, force_at: s.force_at + SNOOZE_STEP }
}
