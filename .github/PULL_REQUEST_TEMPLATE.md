<!--
Thanks for contributing to Nidara! Please fill this in.
See CONTRIBUTING.md for the personal-vs-global heuristic and conventions.
-->

## Summary

<!-- What does this change do, and why? -->

## This is a global change, not a personal preference

<!-- Confirm this isn't accent/wallpaper/keybinds/layout/pinned-apps or another per-user
     taste. If it's a value other users would want different, it should be a Setting, not a
     hardcode. See CONTRIBUTING.md. -->

- [ ] This change benefits all users (correctness / compatibility / performance /
      accessibility / a reusable capability), not just my setup.
- [ ] No personal preferences (accent, wallpaper, pinned apps, keybinds, layout, monitor
      config) are included in this diff.

## Environment & hardware

<!-- Especially important for hardware/compat fixes the maintainers may not be able to
     reproduce. Fill what's relevant. -->

- GPU / driver (`lspci -nn | grep -iE 'VGA|3D'`, `lsmod | grep -E 'nvidia|nouveau|amdgpu'`):
- Hyprland version:
- Relevant adapters (WiFi/Bluetooth) if applicable:
- Other:

## Testing evidence

<!-- What was broken, what you changed, and what you verified afterwards. For compat fixes,
     your evidence IS the test — be concrete (before/after, logs, screenshots). -->

## Conventions checklist

- [ ] I read `SKILL.md` and the relevant `references/` doc, and followed the conventions
      (the "ten commandments": scoped CSS, no hardcoded colours, IPC via `ShellActions`,
      `Status.ts` for visibility, no `transform: scale` on clickables, etc.).
- [ ] CI passes locally (`cd ui/shell && npm run build`).
- [ ] If this changes behaviour or conventions, I updated the relevant skill reference in
      this PR.

## For agent-submitted PRs

<!-- Tick the box below if an AI coding agent prepared this PR. A GitHub Action reads
     it and applies the `agent-submitted` label automatically — you do NOT need label
     permissions (external contributors can't self-label). The label is also applied
     automatically when commits carry the agent's `Co-Authored-By` trailer. -->

- [ ] This PR was prepared with an AI coding agent (e.g. Claude Code).
- [ ] The user reviewed and explicitly approved opening this PR.
