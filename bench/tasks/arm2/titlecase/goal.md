Add a title-case helper

Create `titlecase.js` in the repository root exporting a function `titleCase(str)`.

It returns `str` with the first letter of each whitespace-separated word
uppercased and the rest of that word lowercased. Words are split on runs of
whitespace; the original whitespace runs are preserved in the output. Leading
and trailing whitespace is preserved as-is (not trimmed).

An empty string returns an empty string. A non-string input throws a `TypeError`.

Also add a test file for the module in the repository (any test runner already
present in the repo, or plain `node --test` if none is), and make sure it passes.

When you are done, commit your work and open a pull request against `main`
following this repository's own instructions (see the task brief you were given
alongside this file for exactly how to open and land it here). Make no further
tool calls once the pull request is open and landed (or you have reported why it
could not land).
