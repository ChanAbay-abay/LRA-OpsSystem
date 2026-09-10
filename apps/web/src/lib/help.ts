/**
 * LRA Global Ops :: the "what is this screen for" copy — DESIGN.md §20.4
 *
 * Chan: "when they forget something, they have the option to know more
 * instead of me having back to back meetings with them on how to use
 * it." This file and `lib/labels.ts` are, between them, every word the
 * app uses to explain itself — Chan can reword the entire product's
 * guidance by editing these two files and nothing else.
 *
 * Copy rules (§20.5), binding:
 *   1. Second person, present tense. "Send it to the GM." Not "The task
 *      is transitioned."
 *   2. Name the LRA thing, not the UI thing. "The GM checks it," not
 *      "the record moves to the verified state."
 *   3. Say what happens if you press the button, not what it's called.
 *   4. State the consequence when there is one.
 *   5. Word budgets: a `body` paragraph ≤ 2 sentences, a `todo` item
 *      ≤ 12 words, a page description ≤ 12 words.
 *   6. Banned: "simply", "just", "easily", "please", "oops", exclamation
 *      marks, emoji, and any sentence starting "This screen allows you
 *      to…".
 *   7. Never explain something the screen could have said plainly
 *      instead — a hint that apologises for a confusing label means the
 *      label is wrong (§17), not that it needs a footnote.
 *
 * `PageHeader`'s `help` prop is required (DESIGN.md §20.3): a screen
 * cannot ship without an entry here, and TypeScript enforces that
 * across all fifteen routes via `satisfies Record<HelpTopicId,
 * HelpTopic>` below.
 */

export interface HelpTopic {
  title: string;
  /** Paragraphs. Each ≤ 2 sentences. */
  body: string[];
  /** "What to do here" — 2–3 items, each ≤ 12 words. */
  todo?: string[];
}

export type HelpTopicId =
  | 'board'
  | 'briefing'
  | 'now'
  | 'queue'
  | 'digest'
  | 'points'
  | 'scoreboard'
  | 'person'
  | 'catalog'
  | 'inbox'
  | 'admin-everything'
  | 'admin-audit'
  | 'admin-users'
  | 'admin-settings';

export const HELP = {
  board: {
    title: 'The board',
    body: [
      "Every task the team is working on this week, sorted into lanes by how far along it is.",
      'Drag a card to move it, or open it to add notes, flag a block, or ask for it to be cancelled.',
    ],
    todo: [
      'Drag your card to the lane it belongs in.',
      'Open a card to leave a note or raise a block.',
      'Use the search and owner filter to find one task fast.',
    ],
  },
  briefing: {
    title: 'Monday briefing',
    body: [
      "This is where the week gets planned. You look back at last week, decide what carries over, clear any blocks, and commit to this week's work.",
      "Once it's closed, this week's commitments are locked and everyone can see who agreed to what.",
      // Chan's ask: this distinction is the one people trip on, and it
      // belongs where the ritual happens rather than in a document
      // nobody opens. "make sure that lives somewhere like in the
      // briefing process so everyone knows. maybe in the guide"
      "Assigned and committed are different things. ASSIGNED is whose task it is — that can change any time, and anyone can pick up a task nobody has taken yet. COMMITTED is what you promised on Monday, for this week. It locks when the briefing closes, and it's what your hit-rate measures.",
      "So a task can be assigned to you without being committed — work that came up on Wednesday is yours to do, but it was never a promise you made, and it won't count against you.",
      "If you commit to something and a colleague ends up finishing it, that shows as handed off — not as a miss for you, and not as a promise you kept. The points go to whoever did the work.",
    ],
    todo: [
      'Review last week and decide what still needs doing.',
      'Pick your tasks for this week under your name.',
      'Take any unassigned task you can do, or ask the GM to assign it.',
      "Close the briefing once everyone has committed.",
    ],
  },
  now: {
    title: 'Now',
    body: [
      "What's on your plate right now — your open work, what you're waiting on someone for, and what's waiting on you.",
      'It refreshes on its own every 20 seconds, so you never need to reload it.',
    ],
    todo: ['Clear a block that names you as soon as you can.', 'Open a task to update it or add a note.'],
  },
  queue: {
    title: 'Approvals',
    body: [
      'Work that is sitting with you, waiting on a decision — oldest first.',
      "Approve it, send it back with a reason, or clear it if you're the founder releasing points.",
    ],
    todo: ["Start with the oldest item — it's been waiting longest.", 'Give a reason whenever you send something back.'],
  },
  digest: {
    title: 'This week',
    body: [
      "A founder's view of the whole team: what people are doing, what's stuck, and what's waiting on you to approve.",
      'Points are only banked once you approve them here.',
    ],
    todo: ['Check the blocked section first — those are stalled.', 'Approve or return the items waiting on you.'],
  },
  points: {
    title: 'My points',
    body: [
      'Your own points balance: cleared, waiting to clear, and committed but not yet submitted.',
      'The ledger below is a record of every task of yours that moved, so you can check your own history.',
    ],
    todo: ['Check the ledger if a number looks wrong to you.'],
  },
  scoreboard: {
    title: 'Scoreboard',
    body: [
      "Everyone's points for the period you pick — this week, the last 4 weeks, the last 13, or all time.",
      'Your own card shows your activity over time as a grid of squares, one per day.',
    ],
    todo: ['Switch the period tabs to see a longer stretch of time.'],
  },
  person: {
    title: "A person's record",
    body: [
      "One person's history: their points, their reliability, and their own activity over time.",
      'Reliability is only shown to the GM, the founder and admin — it is a judgement call, not something you carry around publicly.',
    ],
  },
  catalog: {
    title: 'Task catalog',
    body: [
      "What LRA's recurring work is worth, in points, set by the founder.",
      'Picking a catalog type when you create a task fills in its points automatically.',
    ],
  },
  inbox: {
    title: 'Notifications',
    body: ["Things that happened that you need to know about — a block was raised on you, a request was decided, and so on."],
  },
  'admin-everything': {
    title: 'Everything',
    body: [
      'The full picture, for founder and admin only: every task, every ledger row, every open block across the whole team.',
      "Use this when you need to see something that isn't scoped to one person or one screen.",
    ],
  },
  'admin-audit': {
    title: 'Audit timeline',
    body: [
      'A read-only history of who did what and when. Nothing here can be edited or deleted, by anyone, including LRA itself.',
      'Use it to answer "what actually happened" when two people remember it differently.',
    ],
  },
  'admin-users': {
    title: 'Provisioning',
    body: [
      'Invite the GM, Sales and Broker accounts and see who has logged in.',
      "Re-running an invite is safe — it repairs a missing account instead of creating a duplicate.",
    ],
  },
  'admin-settings': {
    title: 'Ops settings',
    body: [
      'The numbers that drive the points system: the recurring-task cap, staleness thresholds, the reliability window, and who can see the scoreboard.',
      'Changing one of these changes it for everyone, immediately.',
    ],
  },
} satisfies Record<HelpTopicId, HelpTopic>;

/**
 * `HELP[id]` on its own loses the general `HelpTopic` shape — `satisfies`
 * keeps each entry's own literal `todo?` (present or absent) rather than
 * widening to the declared interface, so a consumer indexing directly
 * sees a union of eight-plus slightly different object shapes instead of
 * one. This is the widened accessor components should actually use.
 */
export function getHelpTopic(id: HelpTopicId): HelpTopic {
  return HELP[id];
}
