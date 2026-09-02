// The step flow — the frame's only piece of logic.
//
// An installer is a sequence of questions with one answer set, so the shape is a
// list of steps and a cursor. It is written as its own module rather than inside
// the window because adding a screen must be adding an entry to an array, not
// editing a frame: the window renders whatever the flow says the current step
// is, and knows nothing about what any of them ask.

import Gtk from "gi://Gtk?version=4.0"

export interface Step {
  /** Stable id — the Gtk.Stack child name, and what a log line names. */
  id: string
  /** Shown in the window's header while this step is current. */
  title: string | (() => string)
  /** Built the first time the step is reached, and again after `invalidate()`. */
  build(notifyReady?: () => void): Gtk.Widget
  /**
   * Called every time the flow enters this step, BEFORE `build()` runs on a
   * first visit — so a default computed here is computed against the answers
   * the user has actually given by now.
   *
   * ⚠️ This exists because the step FACTORIES all run at once, in the array
   * literal that builds the window, long before anybody has answered anything.
   * `build()` was already lazy; the constructor never was, and that is where
   * every step used to seed its default. The keyboard step read the chosen
   * language in its constructor and therefore always read the initial one:
   * picking Spanish left English (US) ticked. A default that depends on an
   * earlier answer belongs here and nowhere else.
   */
  onEnter?(): void
  /**
   * Label for the button that leaves this step forward. Every step says it in
   * its own words — "Continue" on a question, "Install" on the last summary —
   * because a button that always says the same thing is how somebody clicks
   * past the point of no return without noticing it.
   */
  nextLabel: string | (() => string)
  /**
   * Can the flow move on? Optional: a step with nothing to fill in is ready by
   * definition. A step that needs an answer keeps its own state and calls the
   * `notifyReady` it was handed at build time.
   */
  ready?(): boolean
  /**
   * Is this step in the middle of something the user must not interrupt?
   *
   * The frame asks before it lets anyone out of the window — the close button and
   * Escape are both refused while this is true. It exists because the last step
   * hands a disk and a password to a root process: quitting there would leave
   * `archinstall` running with nobody watching it, the plaintext credentials file
   * still in /tmp, and no window to say so.
   *
   * A step that reports busy MUST call the `notifyReady` it was handed when the
   * answer changes, or the frame will still be showing the state from before.
   */
  busy?(): boolean
}

export interface FlowResult {
  /** The widget the window puts in its content area. */
  widget: Gtk.Widget
  current(): Step
  currentIndex(): number
  canBack(): boolean
  back(): void
  next(): void
  goTo(id: string): boolean
  goToIndex(i: number): boolean
  maxReachedIndex(): number
  /** Called after every move, and whenever a step reports its readiness changed. */
  onChange(cb: () => void): void
  /** Steps call this (through a closure handed to build()) when `ready()` flips. */
  notifyReady(): void
  /**
   * Throw away every built page; the current one is rebuilt at once and the
   * rest on their next entry.
   *
   * This is how a language change reaches the pages. A step translates its
   * contents inside `build()`, which runs once, so 72 strings used to freeze at
   * whatever the language was when that page was first reached — and since
   * pages are built on arrival, the result was not "the installer stays in
   * English" but "the installer is in whichever language you were speaking when
   * you happened to walk past each page".
   *
   * Rebuilding is safe because no step keeps its state in its widgets: every one
   * of them reads `lib/answers.ts` on build and restores what was chosen. That
   * is a contract, not a coincidence — a step that starts holding state in a
   * widget has to put it in `answers.ts` too, or it will lose it here.
   */
  invalidate(): void
}

export function Flow(steps: Step[]): FlowResult {
  if (steps.length === 0) throw Error("a flow needs at least one step")

  const stack = new Gtk.Stack({
    transition_type: Gtk.StackTransitionType.NONE,
    vhomogeneous: false,
    hhomogeneous: true,
    interpolate_size: true,
    hexpand: true,
    vexpand: true,
  })

  const built = new Map<string, Gtk.Widget>()
  let index = 0
  let maxReached = 0
  const listeners: (() => void)[] = []
  const changed = () => { for (const cb of listeners) cb() }

  function realise(step: Step) {
    // Before build, not after: a first visit has to see the answers given so far,
    // and that is the whole point of the hook.
    step.onEnter?.()
    if (!built.has(step.id)) {
      const w = step.build(changed)
      stack.add_named(w, step.id)
      built.set(step.id, w)
    }
  }

  function show(i: number) {
    if (i < 0 || i >= steps.length) return
    const currentStep = steps[index]
    if (currentStep && (currentStep.busy?.() === true || (currentStep.id === "run" && i !== index))) return
    const step = steps[i]
    realise(step)
    index = i
    if (i > maxReached) maxReached = i
    stack.set_visible_child_name(step.id)
    changed()
  }

  show(0)

  return {
    widget: stack,
    current: () => steps[index],
    currentIndex: () => index,
    canBack: () => index > 0 && steps[index]?.busy?.() !== true && steps[index]?.id !== "run",
    back() { if (index > 0 && steps[index]?.id !== "run") show(index - 1) },
    next() { if (index < steps.length - 1 && steps[index]?.id !== "run") show(index + 1) },
    goTo(id: string): boolean {
      if (steps[index]?.id === "run" || steps[index]?.busy?.() === true) return false
      const target = steps.findIndex(s => s.id === id)
      if (target === -1 || target === steps.length - 1) return false
      if (target <= maxReached) {
        show(target)
        return true
      }
      let canAdvance = true
      for (let j = 0; j < target; j++) {
        if (steps[j].ready && !steps[j].ready!()) {
          canAdvance = false
          break
        }
      }
      if (canAdvance) {
        show(target)
        return true
      }
      return false
    },
    goToIndex(i: number): boolean {
      if (i >= 0 && i < steps.length) {
        show(i)
        return true
      }
      return false
    },
    maxReachedIndex: () => maxReached,
    onChange(cb) { listeners.push(cb) },
    notifyReady: changed,
    invalidate() {
      // Never while the install is running: that page owns a live subprocess and
      // a log nobody can rebuild.
      const step = steps[index]
      if (step.id === "run" || step.busy?.() === true) return
      for (const [, w] of built) stack.remove(w)
      built.clear()
      realise(step)
      stack.set_visible_child_name(step.id)
      changed()
    },
  }
}
