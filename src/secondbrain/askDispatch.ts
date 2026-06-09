/**
 * "/ask" message-flow dispatch — the wire between an inbound chat message and
 * the owner-gated all-entity brain Q&A (`handleOwnerAsk`).
 *
 * Transport-agnostic on purpose (same philosophy as askCommand.ts): the caller
 * hands us the raw text, the sender's verified identity, the owner config, a
 * brain client, and a `send` function. index.ts wires this into the channel
 * onMessage flow following the same async pattern as the "loom" course Q&A.
 *
 * Failure posture: a brain failure must produce a FRIENDLY reply, never
 * silence and never a crash. `SecondBrainClient` already degrades gracefully
 * (it never throws), and `handleOwnerAsk` renders the degraded copy; the
 * try/catch here is a last belt-and-braces layer so even an unexpected throw
 * still answers the owner with the degraded message.
 */
import { SecondBrainClient } from './client.js';
import { handleOwnerAsk } from './askCommand.js';
import { isOwner, OwnerConfig, SenderIdentity } from './owner.js';
import { renderDegradedText } from './cards.js';
import { NewMessage } from '../types.js';

/** Usage hint shown for a bare "/ask" with no question. */
export const ASK_USAGE_HINT =
  'Ask your brain something, e.g. "/ask what did we decide about the GPG pricing?"';

/** Progress ping sent before the (slow) all-entity fan-out. */
export const ASK_PROGRESS_PING = '🧠 Asking your brain…';

/**
 * Parse an "/ask" command. Pure (no network) so the regex lives in one place
 * and is unit-testable — mirrors `parseLoomQuestion`. Returns the question
 * when the text is an ask command, `''` when it is exactly "/ask" with no
 * question, and `null` when the text is NOT an ask command (e.g. "/askance").
 */
export function parseAskQuestion(text: string): string | null {
  const trimmed = text.trim();
  if (!/^\/ask\b/i.test(trimmed)) return null;
  return trimmed.replace(/^\/ask\b[:,]?\s*/i, '').trim();
}

/**
 * Lift the sender's verified platform identity off a NewMessage.
 *
 * Only the Teams channel populates `sender_aad_object_id` / `sender_upn`
 * (resolved from the authenticated inbound activity, AFTER its own owner
 * gate). For any channel that does not, the identity carries only the display
 * name — which can never satisfy `isOwner` (it matches on aadObjectId / upn
 * exclusively), so the ask path stays FAIL-CLOSED on identity-less transports.
 */
export function senderIdentityFromMessage(msg: NewMessage): SenderIdentity {
  return {
    aadObjectId: msg.sender_aad_object_id,
    upn: msg.sender_upn,
    name: msg.sender_name,
  };
}

export interface AskDispatchOpts {
  /** Raw inbound message text (any leading/trailing whitespace is fine). */
  text: string;
  /** Verified sender identity (see senderIdentityFromMessage). */
  sender: SenderIdentity;
  /** Configured owner identity (ATLAS_OWNER_AAD_OBJECT_ID / ATLAS_OWNER_UPN). */
  owner: OwnerConfig;
  /** Brain client (shared with the loom path — same base URL + secret). */
  client: SecondBrainClient;
  /** Sends one text reply to the originating chat. */
  send: (text: string) => Promise<void>;
  /** Optional: invoked with any unexpected error (after the friendly reply). */
  onError?: (err: unknown) => void;
}

/**
 * Handle a possible "/ask" message end-to-end.
 *
 * Returns `true` when the message WAS an ask command (the caller must stop
 * processing — a reply has been sent), `false` when it was not (the caller
 * continues its normal flow). The owner gate lives inside `handleOwnerAsk`
 * and is checked FIRST there (fail-closed); this dispatcher adds no second
 * authorization surface.
 */
export async function maybeHandleAskMessage(
  opts: AskDispatchOpts,
): Promise<boolean> {
  const question = parseAskQuestion(opts.text);
  if (question === null) return false;

  if (!question) {
    await opts.send(ASK_USAGE_HINT);
    return true;
  }

  let reply: string;
  try {
    // Progress ping first: the fan-out runs one brain call per entity and a
    // course-style answer can take tens of seconds — silence reads as broken.
    // Pinged ONLY for the owner: a non-owner gets the refusal alone, and the
    // ping must never claim the brain is being asked when it is not. This is
    // a UX check, not an authorization surface — the gate proper is checked
    // FIRST inside handleOwnerAsk (fail-closed) with the same config.
    if (isOwner(opts.sender, opts.owner)) {
      await opts.send(ASK_PROGRESS_PING);
    }
    const result = await handleOwnerAsk(
      opts.client,
      opts.sender,
      opts.owner,
      question,
    );
    reply = result.text;
  } catch (err) {
    // Should be unreachable (the client never throws), but the contract is:
    // a failed brain call produces a friendly reply, never silence or a crash.
    reply = renderDegradedText();
    opts.onError?.(err);
  }
  await opts.send(reply);
  return true;
}
