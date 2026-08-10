Add a numeric clamp helper

Create `clamp.js` in the repository root exporting a function `clamp(value, min, max)`.

It returns `value` restricted to the inclusive range `[min, max]`: if `value` is
below `min`, return `min`; if above `max`, return `max`; otherwise return `value`
unchanged.

If `min > max`, throw a `RangeError`.

Also add a test file for the module in the repository (any test runner already
present in the repo, or plain `node --test` if none is), and make sure it passes.

When you are done, commit your work and open a pull request against `main`
following this repository's own instructions (see the task brief you were given
alongside this file for exactly how to open and land it here). Make no further
tool calls once the pull request is open and landed (or you have reported why it
could not land).
