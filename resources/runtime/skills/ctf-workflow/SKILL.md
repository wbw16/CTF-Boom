---
name: ctf-workflow
description: Boom's durable result, note, and writeup formats. This skill defines output formats only.
---

# Durable output formats

This skill defines what Boom must retain. It does not define or suggest how to solve a challenge.

## NOTES.md

Use `ctf-note` to retain only information a later turn needs:

- a key breakthrough or established fact, with supporting artifact paths;
- an evidence-backed closed direction;
- a compact checkpoint when handing work to another turn.

Do not use NOTES.md as a transcript.

## work/RESULT.json

`ctf-submit` owns this machine-readable file. Do not create or edit it directly. It contains the
current candidate in `ready` state for Boom's optional automatic-submission or manual-review flow.

## work/WRITEUP.md

The final writeup must contain:

- the selected flag;
- the reproducible derivation from the supplied challenge input;
- the commands, programs, and artifact paths needed to reproduce that derivation.

Write the final writeup in Chinese. Keep commands, code, file paths, and the literal flag unchanged.
If a script was used to solve the challenge or verify the flag, include its path, invocation, and
complete source code in a fenced code block. Do not replace any part of the script with a path,
summary, truncation, or ellipsis.

Call `ctf-submit` as soon as a credible candidate is available. Boom ends that solve turn and obtains
a platform or user verdict. Only after a later turn explicitly reports acceptance should you complete
the final writeup; a rejected candidate means continue solving and do not resubmit that value.

The writeup format and level of detail are otherwise your decision.
