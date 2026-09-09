import type { SkillDefinition } from './types';

const SKILLIFY_BODY = `# Skillify: capture this session's repeatable process as a skill

The user's description of the process (may be empty): $ARGUMENTS

You are capturing a repeatable process just completed in this session as a reusable skill. The skill runs inline in the main session — the conversation history is already in your context, so review and analyze it directly; do not inject a summary.

## Step 1: Analyze the current session

Before asking anything, review this session and identify:
- What repeatable process was completed
- The process's input parameters
- The steps, in order
- The success criterion for each step (not a vague "the code was written" but a verifiable artifact, such as "the PR is open and CI is green")
- Where the user corrected or guided you
- Which tools were used

## Step 2: Interview in rounds with ask_user

All questions go through the ask_user tool — never ask in plain text. Stop as soon as you have enough; do not over-interview a simple process.

- Round one: propose a skill name and description based on your analysis; ask the user to confirm or rename.
- Round two: confirm where to save it — project level \`.misty/skills/<name>/SKILL.md\` (a process specific to this repository) or user level \`~/.misty/skills/<name>/SKILL.md\` (a process that applies across repositories); confirm the skill's arguments (use \`$ARGUMENTS\` as the placeholder in the body) and its trigger phrases.
- Round three onward: confirm the success criterion for each step; for irreversible operations (merging, sending, deleting) confirm whether a user checkpoint is required.

Pay special attention to the places where the user corrected you in this session — turn those into hard rules for the skill.

## Step 3: Write SKILL.md

Create the directory and file at the location the user chose, in this format:

\`\`\`markdown
---
name: <skill name>
description: <one-line description>
when_to_use: <when to invoke automatically: start with "Use when the user wants to ...", and include trigger phrases and example user messages>
argument-hint: <argument placeholder hint; omit this line if there are no arguments>
---

# <skill title>

## Goal
The goal of the process, ideally with a verifiable completion artifact.

## Steps

### 1. <step name>
Concrete, executable instructions, with commands where needed.

**Success criteria**: required for every step; states that the step is complete and the next one can begin.

## Rules
Hard rules distilled from the user's corrections (optional).
\`\`\`

## Step 4: Confirm and save

Before writing the file, show the full SKILL.md content to the user and get confirmation with ask_user. After saving, tell the user:
- Where the skill is saved
- That you will invoke it automatically through the skill tool whenever the intent matches its when_to_use/description
- That they can edit the SKILL.md directly at any time to adjust it
`;

/** 内置技能：随发布自带，无需落盘 */
export function getBundledSkillDefinitions(): SkillDefinition[] {
  return [
    {
      name: 'skillify',
      description: "Capture this session's repeatable process as a reusable skill",
      whenToUse:
        'The user wants to save or formalize a process just completed (triggers such as "make this a skill", "save this process", "skillify")',
      argumentHint: '[process description]',
      body: SKILLIFY_BODY,
      source: 'bundled',
    },
  ];
}
