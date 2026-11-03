# Contributing

Thanks for wanting to help. Paint Engine is deliberately small: one JavaScript file, no dependencies,
no build step. Contributions that keep it that way are the easiest to accept.

## Reporting a bug

Open an issue with the **Bug report** template. Paint is visual, so a screenshot or a short screen
recording helps more than anything, along with the device and browser.

## Making a change

1. Fork the repo and clone it.
2. Serve the folder (ES modules and the share links need a server; everything else also works
   straight from disk):

   ```bash
   npx serve .
   ```

3. Open the address it prints. The home page and every page in `demo/` load `paint-engine.js` from the
   root, so your change shows up on reload.

Before you open a pull request:

- **Keep it one file.** `paint-engine.js` must stay a plain script with no dependencies that works when
  opened from disk.
- **Don't change the look by accident.** The same input and seed must keep painting the same pixels.
  If the change is meant to change how paint looks, say so and add a before/after screenshot.
- **Try it on a phone** if it touches input, performance or `paintPage()`.
- **Keep the types in step:** update `paint-engine.d.ts` with any API change.
- **Add a line to `CHANGELOG.md`.**
- **Match the code around you:** the source explains *why* in its comments; please do the same.

New demos are welcome too: one self-contained HTML file in `demo/`, short enough to read with
"view source".

By contributing, you agree that your contributions are licensed under the [MIT License](../LICENSE).
