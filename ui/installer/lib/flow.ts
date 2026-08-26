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
  /** Built once, the first time the step is reached. */
  build(notifyReady?: () => void): Gtk.Widget
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
  canBack(): boolean
  back(): void
  next(): void
  /** Called after every move, and whenever a step reports its readiness changed. */
  onChange(cb: () => void): void
  /** Steps call this (through a closure handed to build()) when `ready()` flips. */
  notifyReady(): void
}

export function Flow(steps: Step[]): FlowResult {
  if (steps.length === 0) throw Error("a flow needs at least one step")

  const stack = new Gtk.Stack({
    transition_type: Gtk.StackTransitionType.SLIDE_LEFT_RIGHT,
    transition_duration: 220,
    hexpand: true,
    vexpand: true,
  })

  const built = new Set<string>()
  let index = 0
  const listeners: (() => void)[] = []
  const changed = () => { for (const cb of listeners) cb() }

  function show(i: number) {
    const step = steps[i]
    if (!built.has(step.id)) {
      stack.add_named(step.build(changed), step.id)
      built.add(step.id)
    }
    // Backwards moves slide the other way, which is the whole reason the stack
    // carries a transition: it is the only cue that a step was undone rather
    // than answered.
    stack.transition_type = i >= index
      ? Gtk.StackTransitionType.SLIDE_LEFT
      : Gtk.StackTransitionType.SLIDE_RIGHT
    index = i
    stack.set_visible_child_name(step.id)
    changed()
  }

  show(0)

  return {
    widget: stack,
    current: () => steps[index],
    canBack: () => index > 0,
    back() { if (index > 0) show(index - 1) },
    next() { if (index < steps.length - 1) show(index + 1) },
    onChange(cb) { listeners.push(cb) },
    notifyReady: changed,
  }
}
