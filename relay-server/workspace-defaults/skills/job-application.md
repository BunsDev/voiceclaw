# Skill: Job Application

Use this playbook when the user asks you to review, apply to, or submit an
application for a job. It runs end-to-end: read the posting, draft a tailored
package, stage it under `jobs/<slug>/`, and either submit via the browser or
hand back to the user with a precise list of what they need to do.

The user will speak you through the dry run. Narrate as you go.

## Inputs you'll need

Before you start, locate these. Ask the user if anything is missing — don't
guess.

- **Job posting.** Either a path the user mentions or the canonical KB path
  at `/Users/michael/code/knowledge-base/sources/jobs/`. Posting files are
  named `YYYY-MM-DD-<company>-<role>.md`.
- **Resume.** `/Users/michael/code/knowledge-base/sources/notes/2025-12-31-resume.md`
  is the current canonical resume. The matching `.pdf` is the artifact you
  attach to applications — read the `.md` to reason from.
- **Facts about the user.** `FACTS.md` is already preloaded into your
  context. The richer source is
  `/Users/michael/code/knowledge-base/sources/agents/2026-05-15-about-michael-claude.md`
  plus `/Users/michael/code/knowledge-base/sources/notes/2026-05-15-bio-corrections.md`
  — `read` those if the posting needs depth FACTS.md doesn't cover (comp
  history, specific past projects, framing nuance).

## Slug for the per-job folder

Use lowercase `<company>-<role>`, hyphenated. Match the posting filename
where possible. Example: `jane-app-staff-engineer`.

All artifacts for one job live in `jobs/<slug>/`. Create it with `write` —
the parent dir is allowed because the workspace seeder created `jobs/`.

## Step-by-step

### 1. Read the posting and the user's material

- `read` the job posting in full.
- `read` the resume markdown.
- Skim FACTS.md (already in context). If the role needs specifics that
  FACTS.md doesn't have, `read` `about-michael-claude.md` and
  `bio-corrections.md`.

### 2. Draft `jobs/<slug>/tailoring-notes.md`

A working doc, not a deliverable. Use it to think out loud before you write
the cover letter. Include:

- **Fit assessment.** Honest read of how well the user matches the
  required-qualifications list. Flag gaps explicitly.
- **Resume bullets to emphasize.** Pick 4-8 bullets from the resume that
  map directly to what the posting asks for. Quote the posting line each
  one answers.
- **Bullets to de-emphasize.** Anything that competes for attention but
  doesn't land for this role.
- **Open questions.** Things you'd want the user to clarify before
  submitting (relocation, comp band, framing of past departures, etc).

Save with `write`.

### 3. Draft `jobs/<slug>/cover-letter.md`

Voice and length:

- Match the user's writing style — direct, terse, lowercase-friendly,
  no corporate hedging. Reference his communication patterns in
  FACTS.md / `about-michael-claude.md`.
- 250-400 words. Cover letters that read like essays don't get read.
- Open with the specific reason the user wants this role at this
  company. Not "I am writing to apply for...".
- One paragraph mapping his concrete shipped work to the posting's
  asks. Use real metrics from the resume.
- Close with availability and how to reach him.

Save with `write`.

### 4. Draft `jobs/<slug>/application-plan.md`

This is the runbook for actually submitting. Capture:

- **Application URL.** Pull from the posting. If missing, `web_search`
  for `"<company> careers <role>"` and confirm with the user.
- **Form fields.** Use `agent-browser` (see below) to load the page and
  list every required field, plus what value goes in each.
- **Attachments needed.** Resume PDF path, portfolio URL, any other
  files the form asks for.
- **Submission steps.** Numbered, reproducible. Each step says exactly
  what to click/type.
- **User-required actions.** Anything you can't do unattended: OAuth
  logins, MFA, captchas, "are you authorized to work in X" radio
  buttons that need a human, salary negotiation tone, etc. Be explicit
  — the user is going to follow this list.
- **Risk flags.** Anything in the posting or page that conflicts with
  what FACTS.md says about the user (relocation requirement, comp
  band below his floor, etc).

Save with `write`.

### 5. Inspect the application page with `agent-browser`

`agent-browser` is on PATH. Quick recipe:

```bash
agent-browser open "<application-url>"
agent-browser screenshot ~/.voiceclaw/workspace/jobs/<slug>/application-page.png
agent-browser html main > /tmp/app-page.html   # if the form fields aren't obvious
```

Use the screenshot + DOM to populate the form-fields section of
`application-plan.md`. If the page requires login (Greenhouse, Lever,
Ashby, Workday all sometimes do), capture the login URL and log it as a
user-required action — don't try to log in yourself.

If `agent-browser open` fails (no display, dependency missing), fall
back to `web_search` for the application URL and describe the field
list from the posting + general knowledge of that ATS. Note in the
plan that the page wasn't directly inspected.

### 6. Submit — or hand back

**Default: hand back.** Don't auto-submit unless the user explicitly
says "submit it." Real applications need a final eyeball.

When the user gives the go-ahead:

- If the form is purely text fields with no login/captcha, use
  `agent-browser type` + `agent-browser click` to fill and submit.
  Screenshot before the final submit click and confirm with the user.
- If anything requires the user's hands (OAuth, captcha, MFA), stop
  at that step and tell the user exactly what to click next.

### 7. Report back

Tell the user, out loud:

- What's staged in `jobs/<slug>/` (filenames).
- The one-line fit assessment.
- Submission status: submitted / staged / blocked-on-user.
- Anything the user needs to do next.

Add a `## Voice Note (HH:MM)` entry to today's memory file noting the
job, the slug, and the status. Future you will need to know which
applications are in flight.

## Delegation

Drafting a cover letter is the kind of thing you can do inline with
`write`. But if the user wants a deeper pass — multiple cover-letter
variants, a tailored resume rewrite, a research dossier on the company —
that's `bash claude -p "<task>"` work. Hand it the per-job folder path
and let it iterate.

## Anti-patterns

- Don't fabricate work history. Everything goes back to the resume +
  bio-corrections + FACTS.md. If a posting needs experience the user
  doesn't have, say so in `tailoring-notes.md` — don't invent it in
  the cover letter.
- Don't submit without explicit user say-so.
- Don't write a generic letter. If the cover letter would work
  unchanged for a different job, it's wrong.
- Don't promise things the user hasn't agreed to (start date,
  relocation, comp). If a form field asks, leave it blank and flag
  it for the user.
